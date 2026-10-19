'use strict'

/**
 * dsh-hermes-evolve — Hermes Agent's self-evolution loop, as a DSH plugin.
 *
 * Four capabilities, each ported from a specific Hermes module:
 *
 *   1. MEMORY + USER PROFILE  (`memories/MEMORY.md`, `memories/USER.md`)
 *      Injected into every session's context, mutable through a `memory` tool.
 *      Ported from `tools/memory_tool.py` + `tools/memory_tool_store.py`.
 *   2. SKILL LIBRARY  (`$DSH_HOME/skills/<name>/SKILL.md` + support files)
 *      `skills_list` / `skill_view` / `skill_manage`, with Hermes' validations,
 *      read-before-write guard, advisory linter, ledger and archive-not-delete.
 *      Ported from `tools/skill_manager_tool.py`, `skills_tool.py`, `skill_linter.py`.
 *   3. BACKGROUND REVIEW  (in-turn coaching + a post-turn fork that writes)
 *      Every N tool iterations / turns a forked agent re-reads the transcript
 *      and saves lessons. Ported from `agent/background_review.py` and
 *      `agent/turn_finalizer.py`.
 *   4. CURATOR  (inactivity state machine + optional LLM consolidation)
 *      Marks stale, archives inactive skills, never deletes. Ported from
 *      `agent/curator.py` + `agent/curator_backup.py`.
 *
 * The plugin is host-plane: it subscribes to every session's `session/event`,
 * forks review agents through the `agents` service, and writes to the same
 * stores the model-facing tools write to — so the next session starts smarter.
 */

const { DEFAULTS, settingsSchema } = require('./const')
const util = require('./util')
const memory = require('./memory')
const prompts = require('./prompts')
const store = require('./skill_store')
const skillTools = require('./skill_tools')
const review = require('./review')
const curator = require('./curator')
const { registerPanelRoutes } = require('./panel')

const SETTINGS_NS = 'hermes-evolve'
const PLUGIN = 'hermes-evolve'

let schemastery = null
try {
  schemastery = require('@deepseek-ai/schemastery')
} catch {
  // Without the schema the plugin still works; the host just shows no form.
  schemastery = null
}

/** Settings schema, exported at module level because the host discovers
 *  `Config` by symbol — `ctx.settings.register` no longer exists. */
const Config = schemastery !== null ? settingsSchema(schemastery) : undefined

function pickLogger (ctx) {
  try {
    if (ctx && ctx.logger && typeof ctx.logger === 'object') return ctx.logger
  } catch { /* no logger */ }
  return {
    info: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
    debug: () => {},
  }
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sanitizeConfig (raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    const fallback = DEFAULTS[key]
    // The host materialises `.volatile()` fields of the apply-config as `{}`
    // once the settings document exists (measured on dsh 0.2.0-rc.2). Copying
    // that `{}` over the default poisons every consumer until the projection
    // lands, so only same-shaped values are accepted; the live document is
    // merged through this same filter.
    if (fallback === undefined) continue
    if (Array.isArray(fallback)) {
      if (Array.isArray(value)) out[key] = value
      continue
    }
    if (typeof value === typeof fallback) out[key] = value
  }
  return out
}

/** Pick the reply language. The plugin writes prose (review conclusions, panel
 *  labels) in the deployment's locale; defaults to Chinese like Hermes' users. */
function resolveLang (ctx) {
  try {
    const descriptors = ctx.settings.describe()
    const locale = descriptors.find((entry) => entry.ns === 'locale')
    if (locale && locale.value !== null && typeof locale.value === 'object') {
      for (const key of ['preference', 'language', 'locale', 'lang', 'value']) {
        const candidate = locale.value[key]
        if (typeof candidate === 'string' && candidate.trim() !== '') {
          return /^en/i.test(candidate.trim()) ? 'en' : 'zh'
        }
      }
    }
  } catch { /* fall through */ }
  return 'zh'
}

function apply (ctx, config = {}) {
  const logger = pickLogger(ctx)
  const settings = { ...DEFAULTS, ...sanitizeConfig(config) }

  // ── settings: live values ───────────────────────────────────────────────
  //
  // The host projects `Config` into a settings page. Writes arrive as a document
  // update; `refreshLive` folds the resolved value into the SAME object every
  // consumer holds, so no consumer needs to re-bind.
  const settingsEventName = 'settings/document-updated'
  const refreshLive = () => {
    try {
      const descriptor = ctx.settings.describe().find((entry) => entry.ns === SETTINGS_NS)
      if (descriptor !== undefined && descriptor.value !== null && typeof descriptor.value === 'object') {
        Object.assign(settings, sanitizeConfig(descriptor.value))
      }
    } catch { /* settings not ready yet */ }
  }
  refreshLive()
  void (async () => {
    // The projection may not exist at apply time; retry like the other
    // market plugins do rather than losing live updates for the whole boot.
    for (let attempt = 0; attempt < 15; attempt += 1) {
      refreshLive()
      try {
        if (ctx.settings.describe().some((entry) => entry.ns === SETTINGS_NS)) break
      } catch { /* not ready */ }
      await sleep(2000)
    }
  })()

  ctx.effect(() => {
    const off = ctx.on(settingsEventName, (ns) => {
      if (ns !== SETTINGS_NS) return
      refreshLive()
      void refreshMemoryCache()
    })
    return () => { try { off() } catch { /* gone */ } }
  }, `${PLUGIN}: settings subscription`)

  // ── coexistence with other capability plugins ───────────────────────────
  //
  // A profile may already provide skill or memory tools (dsh base ships skill
  // tools; memory plugins ship `memory`). Registering a *global* tool with an
  // occupied name throws, so `auto` claims only free names. The background
  // review/curator forks register their tools in the agent's own scope, where
  // ours shadow globals — so ported fidelity inside those passes is unaffected.
  const existingToolNames = (() => {
    try { return new Set(ctx.tools.schemas().map((schema) => schema.name)) } catch { return new Set() }
  })()
  const ownTool = (name) => settings.registerTools !== 'off' && !existingToolNames.has(name)
  const foreignMemory = existingToolNames.has('memory') && settings.respectForeignMemory !== false
  const injectMemory = () => settings.memoryInjectionEnabled !== false && !foreignMemory
  const hasSkillManage = () => ownTool('skill_manage') || existingToolNames.has('skill_manage')

  // ── memory snapshot ─────────────────────────────────────────────────────
  let memoryText = ''
  const frozenMemory = new WeakMap()

  const refreshMemoryCache = async () => {
    try {
      if (!injectMemory()) {
        memoryText = ''
        return
      }
      const stores = []
      if (settings.memoryEnabled !== false) {
        const loaded = await memory.readStore(util.memoryDir(), 'memory')
        stores.push({ store: 'memory', entries: loaded.entries, limit: Number(settings.memoryCharLimit) || 2200 })
      }
      if (settings.userProfileEnabled !== false) {
        const loaded = await memory.readStore(util.memoryDir(), 'user')
        stores.push({ store: 'user', entries: loaded.entries, limit: Number(settings.userCharLimit) || 1375 })
      }
      memoryText = memory.renderMemoryContext(stores, { lang: settings.lang })
    } catch (error) {
      logger.warn?.(`[${PLUGIN}] cannot read memory store: ${error && error.message ? error.message : error}`)
      memoryText = ''
    }
  }
  void refreshMemoryCache()

  // ── system prompt: durable instructions + the memory snapshot ───────────
  ctx.effect(() => {
    const disposers = []
    disposers.push(ctx.systemPrompt.section({
      name: `${PLUGIN}:memory-guidance`,
      order: 50,
      text: () => (injectMemory() ? prompts.memoryGuidance(true) : ''),
    }))
    disposers.push(ctx.systemPrompt.section({
      name: `${PLUGIN}:skills-coaching`,
      order: 51,
      text: () => {
        if (settings.coachingEnabled === false) return ''
        // Pointing the model at a tool nobody registered is worse than silence.
        if (!hasSkillManage()) return ''
        return prompts.skillsCoaching(settings.coachingMode !== 'patch-only')
      },
    }))
    disposers.push(ctx.systemPrompt.context({
      name: `${PLUGIN}:memory`,
      order: 40,
      text: (assembleContext) => {
        if (memoryText === '') return ''
        // Hermes freezes the memory snapshot at session start: a fact learned
        // mid-session must not rewrite the prefix that is already cached.
        const scope = assembleContext !== null && typeof assembleContext === 'object' ? assembleContext.scope : undefined
        if (scope !== null && (typeof scope === 'object' || typeof scope === 'function')) {
          if (frozenMemory.has(scope)) return frozenMemory.get(scope)
          frozenMemory.set(scope, memoryText)
          return memoryText
        }
        return memoryText
      },
    }))
    return () => {
      for (const dispose of disposers) { try { dispose() } catch { /* gone */ } }
    }
  }, `${PLUGIN}: prompt contributions`)

  // ── model-facing tools ──────────────────────────────────────────────────
  //
  // Registered globally so the MAIN agent gets Hermes' native tool surface.
  // Each agent gets its own read-before-write ledger keyed by `exec.agent`.
  const marksByAgent = new WeakMap()
  const resolveToolContext = (exec) => {
    const agent = exec !== null && typeof exec === 'object' ? exec.agent : undefined
    let marks
    if (agent !== null && (typeof agent === 'object' || typeof agent === 'function')) {
      marks = marksByAgent.get(agent)
      if (marks === undefined) {
        marks = store.makeReadMarks()
        marksByAgent.set(agent, marks)
      }
    } else {
      marks = store.makeReadMarks()
    }
    return skillTools.toolContext({
      marks,
      agentCreated: false,
      requireReadBeforeWrite: true,
      linterEnabled: settings.linterEnabled !== false,
      ledgerEnabled: settings.ledgerEnabled !== false,
      supportFilesEnabled: settings.supportFilesEnabled !== false,
      maxSupportFileChars: settings.maxSupportFileChars,
      maxBodyChars: settings.maxBodyChars,
      memoryCharLimit: settings.memoryCharLimit,
      userCharLimit: settings.userCharLimit,
      lang: settings.lang,
    })
  }
  ctx.effect(() => {
    const disposers = []
    const skipped = []
    for (const definition of skillTools.buildToolSet({ resolveContext: resolveToolContext })) {
      if (definition.name === 'memory' && foreignMemory) { skipped.push('memory'); continue }
      if (!ownTool(definition.name)) { skipped.push(definition.name); continue }
      try {
        disposers.push(ctx.tools.register(definition))
      } catch (error) {
        // Another plugin may claim the name between our probe and this call
        // (mount order is not guaranteed). Losing one tool must not take the
        // whole plugin — and the session — down.
        skipped.push(definition.name)
        logger.warn?.(`[${PLUGIN}] cannot register ${definition.name}: ${error && error.message ? error.message : error}`)
      }
    }
    if (skipped.length > 0) {
      logger.info?.(`[${PLUGIN}] left ${skipped.join(', ')} to the host profile`)
    }
    return () => {
      for (const dispose of disposers) { try { dispose() } catch { /* gone */ } }
    }
  }, `${PLUGIN}: tool registrations`)

  // ── background review ───────────────────────────────────────────────────
  const scheduler = review.createScheduler({ hostCtx: ctx, settings, logger })

  // ── curator scheduling ──────────────────────────────────────────────────
  const curatorStatus = { lastActivityAt: Date.now(), lastCheckAt: 0, lastResult: null, running: false }
  const CURATOR_CHECK_INTERVAL_MS = 15 * 60 * 1000
  const curatorTick = async (trigger) => {
    if (settings.enabled === false || settings.curatorEnabled === false) return
    if (curatorStatus.running) return
    const now = Date.now()
    if (now - curatorStatus.lastCheckAt < CURATOR_CHECK_INTERVAL_MS) return
    curatorStatus.lastCheckAt = now
    const idleHours = (now - curatorStatus.lastActivityAt) / 3_600_000
    if (idleHours < (Number(settings.curatorMinIdleHours) || 0)) return
    curatorStatus.running = true
    try {
      const result = await curator.runCurator({ hostCtx: ctx, settings, logger })
      curatorStatus.lastResult = { at: new Date().toISOString(), trigger, ...summarizeCuratorResult(result) }
      if (result.ok === true && result.automatic && result.automatic.archived && result.automatic.archived.length > 0) {
        logger.info?.(`[${PLUGIN}] curator archived ${result.automatic.archived.length} inactive skill(s)`)
      }
    } catch (error) {
      logger.warn?.(`[${PLUGIN}] curator pass failed: ${error && error.message ? error.message : error}`)
    } finally {
      curatorStatus.running = false
    }
  }
  const curatorTimer = setInterval(() => { void curatorTick('interval') }, CURATOR_CHECK_INTERVAL_MS)
  if (typeof curatorTimer.unref === 'function') curatorTimer.unref()
  ctx.effect(() => () => clearInterval(curatorTimer), `${PLUGIN}: curator timer`)
  // Seed the curator clock once at boot (first observation never prunes).
  const seedTimer = setTimeout(() => { void curatorTick('boot') }, 30_000)
  if (typeof seedTimer.unref === 'function') seedTimer.unref()
  ctx.effect(() => () => clearTimeout(seedTimer), `${PLUGIN}: curator seed timer`)

  // ── session events ──────────────────────────────────────────────────────
  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      try {
        if (settings.enabled === false) return
        if (event !== null && typeof event === 'object') {
          curatorStatus.lastActivityAt = Date.now()
        }
        Promise.resolve(scheduler.onEvent(session, event))
          .then(() => { if (event && event.type === 'turn/end') void curatorTick('turn-end') })
          .catch((error) => logger.debug?.(`[${PLUGIN}] session event failed: ${error && error.message ? error.message : error}`))
      } catch (error) {
        logger.debug?.(`[${PLUGIN}] session event failed: ${error && error.message ? error.message : error}`)
      }
    })
    return () => { try { off() } catch { /* gone */ } }
  }, `${PLUGIN}: session/event subscription`)

  // ── panel routes (optional service) ─────────────────────────────────────
  try {
    ctx.inject(['webServer'], (webServerCtx) => {
      const dispose = registerPanelRoutes(webServerCtx, {
        pluginCtx: ctx,
        settings,
        settingsNs: SETTINGS_NS,
        logger,
        refreshMemoryCache,
        readMemoryText: () => memoryText,
        curatorStatus,
        runCuratorNow: (options) => curator.runNow({ hostCtx: ctx, settings, logger, ...options }),
        curatorModule: curator,
      })
      ctx.effect(() => dispose, `${PLUGIN}: panel routes`)
    })
  } catch (error) {
    logger.debug?.(`[${PLUGIN}] no webServer service; running without a panel: ${error && error.message}`)
  }

  logger.info?.(`[${PLUGIN}] active — mode=${settings.mode} curator=${settings.curatorEnabled ? 'on' : 'off'} skills=${util.skillsDir()}`)
}

function summarizeCuratorResult (result) {
  if (result === null || typeof result !== 'object') return { ok: false }
  if (result.skipped !== undefined) return { skipped: result.skipped }
  const archived = result.automatic && result.automatic.ok === true
    ? result.automatic.archived.map((item) => item.name)
    : []
  return {
    ok: result.ok === true,
    archived,
    summary: result.state ? result.state.last_run_summary : undefined,
    durationSeconds: result.durationSeconds,
  }
}

module.exports = {
  name: PLUGIN,
  inject: ['settings', 'systemPrompt', 'tools', 'agents', 'agentDefaultModel', 'sessions'],
  Config,
  apply,
  __internals: {
    sanitizeConfig,
    resolveLang,
    summarizeCuratorResult,
  },
}