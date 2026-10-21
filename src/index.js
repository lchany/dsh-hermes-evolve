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
const backfill = require('./backfill')
const curator = require('./curator')
const commands = require('./commands')
const learnPrompt = require('./learn_prompt')
const { registerPanelRoutes } = require('./panel')
const { randomUUID } = require('node:crypto')

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
  // Prose this plugin writes (notices, panel labels, memory context) follows the
  // deployment locale; Hermes does the same through its i18n catalogs.
  const refreshLang = () => { settings.lang = resolveLang(ctx) }
  refreshLang()

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
    refreshLang()
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
        const limit = Number(settings.memoryCharLimit) || 2200
        // hermes memory_tool_store.py:246-252 (#10877): a store an external writer
        // pushed past its cap used to ride into the prompt silently while every
        // later add was refused with no visible cause. Warn; never truncate.
        const notice = memory.overLimitNotice('memory', loaded.entries, limit)
        if (notice !== null) logger.warn?.(`[${PLUGIN}] ${notice}`)
        stores.push({ store: 'memory', entries: loaded.entries, limit })
      }
      if (settings.userProfileEnabled !== false) {
        const loaded = await memory.readStore(util.memoryDir(), 'user')
        const limit = Number(settings.userCharLimit) || 1375
        const notice = memory.overLimitNotice('user', loaded.entries, limit)
        if (notice !== null) logger.warn?.(`[${PLUGIN}] ${notice}`)
        stores.push({ store: 'user', entries: loaded.entries, limit })
      }
      memoryText = memory.renderMemoryContext(stores, { lang: settings.lang })
    } catch (error) {
      logger.warn?.(`[${PLUGIN}] cannot read memory store: ${error && error.message ? error.message : error}`)
      memoryText = ''
    }
  }
  void refreshMemoryCache()

  // ── system prompt: durable instructions + the memory snapshot ───────────
  //
  // hermes prompt_builder.py:1449 names the basic tools from the turn's tool
  // set: "terminal" alone, or "web_search or terminal" when web search is
  // available. bash is DSH's terminal; the label is computed per call because
  // plugins may register tools after this section is installed.
  const basicToolsLabel = () => {
    try {
      const names = new Set(ctx.tools.schemas().map((schema) => schema.name))
      return names.has('web_search') ? 'web_search or bash' : 'bash'
    } catch {
      return prompts.BASIC_TOOLS_DEFAULT
    }
  }

  ctx.effect(() => {
    const disposers = []
    disposers.push(ctx.systemPrompt.section({
      name: `${PLUGIN}:memory-guidance`,
      order: 50,
      text: () => (injectMemory()
        ? prompts.memoryGuidance({
            memoryEnabled: settings.memoryEnabled !== false,
            userProfileEnabled: settings.userProfileEnabled !== false,
            skillManageAvailable: hasSkillManage()
          })
        : ''),
    }))
    disposers.push(ctx.systemPrompt.section({
      name: `${PLUGIN}:skills-coaching`,
      order: 51,
      text: () => {
        if (settings.coachingEnabled === false) return ''
        // Pointing the model at a tool nobody registered is worse than silence.
        if (!hasSkillManage()) return ''
        return prompts.skillsCoaching(settings.coachingMode !== 'patch-only', { basicTools: basicToolsLabel() })
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
  // hermes #42405: the store owns one per-turn counter of failed consolidation
  // attempts and resets it at the turn boundary. One counter per agent session;
  // `turn/start` (below) resets it, and a fork that never emits turn events just
  // keeps counting for the length of its single pass.
  const consolidationBySession = new Map()
  const consolidationFor = (agent) => {
    const session = agent !== null && (typeof agent === 'object' || typeof agent === 'function') ? agent.session : undefined
    const id = session !== null && typeof session === 'object' && typeof session.id === 'string' ? session.id : null
    if (id === null) return memory.createRetryCounter()
    let counter = consolidationBySession.get(id)
    if (counter === undefined) {
      counter = memory.createRetryCounter()
      consolidationBySession.set(id, counter)
      // Sessions are cheap to recreate; bound the map rather than grow forever.
      if (consolidationBySession.size > 200) consolidationBySession.delete(consolidationBySession.keys().next().value)
    }
    return counter
  }
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
      // hermes #42405: failures count against this turn's consolidation cap.
      consolidation: consolidationFor(agent),
      agentCreated: false,
      requireReadBeforeWrite: true,
      linterEnabled: settings.linterEnabled !== false,
      ledgerEnabled: settings.ledgerEnabled !== false,
      supportFilesEnabled: settings.supportFilesEnabled !== false,
      maxSupportFileChars: settings.maxSupportFileChars,
      maxBodyChars: settings.maxBodyChars,
      memoryCharLimit: settings.memoryCharLimit,
      userCharLimit: settings.userCharLimit,
      memoryEnabled: settings.memoryEnabled !== false,
      userProfileEnabled: settings.userProfileEnabled !== false,
      // Hermes gates tool writes too, not just forks: `skills.write_approval` /
      // `memory.write_approval` are read on every write path.
      writeApproval: settings.skillsWriteApproval === true,
      memoryApproval: settings.memoryWriteApproval === true,
      lang: settings.lang,
      // Hermes' `on_memory_write`: announce applied native writes so an
      // external provider (dsh-agentmemory) can mirror them. Emitted on the
      // plugin context, so any listener in the host sees it.
      onMemoryWrite: (rows) => {
        try { ctx.emit('hermes-evolve/memory-write', { rows }) } catch { /* no listeners */ }
      },
    })
  }
  ctx.effect(() => {
    const disposers = []
    const skipped = []
    for (const definition of skillTools.buildToolSet({ resolveContext: resolveToolContext })) {
      const memoryDisabled = settings.memoryEnabled === false && settings.userProfileEnabled === false
      if (definition.name === 'memory' && (foreignMemory || memoryDisabled)) { skipped.push('memory'); continue }
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
  const scheduler = review.createScheduler({ hostCtx: ctx, settings, logger, hasSkillManage })

  // ── review dispatch whitelist (D4) ──────────────────────────────────────
  //
  // Hermes narrows a review fork's tool surface twice: the advertised set and
  // the dispatch path (`set_thread_tool_whitelist` +
  // `agent/background_review.py:1153-1170`). The second gate matters here too:
  // the model can still emit a call for a tool it saw earlier in the parent
  // transcript, and a tool registered AFTER the fork's `tools.restrict` would
  // not be covered. Denying with `{kind:'deny'}` shows the model Hermes'
  // sentence instead of running the tool.
  ctx.effect(() => {
    const off = ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        const agent = exec !== null && typeof exec === 'object' ? exec.agent : undefined
        const session = agent !== null && typeof agent === 'object' ? agent.session : undefined
        const policy = session !== null && typeof session === 'object'
          ? review.reviewSessionPolicy(session.id)
          : undefined
        if (policy !== undefined && !review.reviewToolAllowed(exec.name, policy)) {
          return { kind: 'deny', reason: review.reviewDenyReason(exec.name, policy) }
        }
        if (policy !== undefined) {
          const budget = review.consumeReviewIteration(session.id)
          if (budget !== null && budget.allowed === false) {
            return {
              kind: 'deny',
              reason: budget.tokenHit
                ? review.reviewTokenBudgetReason(budget.tokens, budget.maxTokens)
                : review.reviewBudgetReason(budget.used, budget.max),
            }
          }
        }
      } catch { /* a broken listener must never block dispatch */ }
      return next()
    })
    return () => { try { off() } catch { /* gone */ } }
  }, `${PLUGIN}: review dispatch whitelist`)

  // ── curator scheduling ──────────────────────────────────────────────────
  const curatorStatus = { lastActivityAt: Date.now(), lastCheckAt: 0, lastResult: null, running: false }
  const CURATOR_CHECK_INTERVAL_MS = 15 * 60 * 1000
  const curatorTick = async (trigger, { idleHours: idleOverride } = {}) => {
    if (settings.enabled === false || settings.curatorEnabled === false) return
    if (curatorStatus.running) return
    const now = Date.now()
    if (now - curatorStatus.lastCheckAt < CURATOR_CHECK_INTERVAL_MS) return
    curatorStatus.lastCheckAt = now
    // Hermes' startup hook passes `idle_for_seconds=float('inf')`: a process that
    // has just booted has been idle forever, so the min-idle gate must not hold
    // the first check back.
    const idleHours = Number.isFinite(idleOverride)
      ? idleOverride
      : (now - curatorStatus.lastActivityAt) / 3_600_000
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

  // ── curator session-start hook (D7) ─────────────────────────────────────
  //
  // Hermes checks the curator when a session starts, not only on a timer:
  // `hermes_cli/cli_tui_runtime_mixin.py:352` calls
  // `maybe_run_curator(idle_for_seconds=float('inf'))` on its startup thread,
  // while `hermes_cli/web_server_sessions.py:299` passes a measured idle. The
  // host timer alone would miss a machine that is only ever used in short
  // interactive sessions, so mirror the startup hook as well.
  ctx.effect(() => {
    const off = ctx.on('agent/created', (payload) => {
      try {
        const plan = curatorSessionStartIdle(payload, settings)
        if (plan === undefined) return
        void curatorTick('session-start', plan)
      } catch { /* maintenance must never break session creation */ }
    })
    return () => { try { off() } catch { /* gone */ } }
  }, `${PLUGIN}: curator session-start hook`)

  // ── session events ──────────────────────────────────────────────────────
  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      try {
        if (settings.enabled === false) return
        if (event !== null && typeof event === 'object') {
          curatorStatus.lastActivityAt = Date.now()
          // hermes `turn_context.py:627` resets the store's consolidation-failure
          // counter at the start of every turn (#42405).
          if (event.type === 'turn/start') {
            const counter = session !== null && typeof session === 'object'
              ? consolidationBySession.get(session.id)
              : undefined
            if (counter !== undefined) counter.reset()
          }
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
        backfillStatus: () => backfill.readStatus(),
        runBackfill: (options) => backfill.start({
          hostCtx: ctx,
          settings,
          logger,
          runReview: review.runReview,
        }, options),
        stopBackfill: () => backfill.stop(),
        listTools: () => {
          // `schemas()` is the only view a host-plane plugin gets of the
          // composed global surface: its own tools, every MCP bridge, and other
          // plugins' registrations.
          try {
            return (ctx.tools?.schemas?.() || [])
              .map((schema) => schema && schema.name)
              .filter(Boolean)
          } catch {
            return []
          }
        },
      })
      ctx.effect(() => dispose, `${PLUGIN}: panel routes`)
    })
  } catch (error) {
    logger.debug?.(`[${PLUGIN}] no webServer service; running without a panel: ${error && error.message}`)
  }

  // ── user commands (Hermes' Desktop surface) ────────────────────────────
  //
  // `/skills`, `/memory`, `/curator`, `/refine`, `/learn` are plain chat
  // commands in Hermes; DSH's command registry is the same seam, so the
  // control points survive the port without a panel round-trip.
  ctx.effect(() => commands.registerCommands(ctx, {
    settings,
    logger,
    hostCtx: ctx,
    persistSettings: (patch) => ctx.settings.update(SETTINGS_NS, patch),
    runCuratorNow: (options) => curator.runNow({ hostCtx: ctx, settings, logger, ...options }),
    runReview: review.runReview,
    hasSkillManage,
    learnPrompt,
    randomId: () => randomUUID(),
  }), `${PLUGIN}: commands`)

  // ── queued backfill ────────────────────────────────────────────────────
  //
  // A run prepared before a host restart has no other way to start itself:
  // plugin code loads once with the host. Consuming the request file here makes
  // "restart" the only manual step between queuing and the first review.
  void backfill.resumeRequest({
    hostCtx: ctx,
    settings,
    logger,
    runReview: review.runReview,
  }).then((outcome) => {
    if (outcome && outcome.started === true) logger.info?.(`[${PLUGIN}] queued backfill started`)
  }).catch((error) => logger.warn?.(`[${PLUGIN}] queued backfill failed: ${error && error.message ? error.message : error}`))

  logger.info?.(`[${PLUGIN}] active — approvals(skills/memory)=${settings.skillsWriteApproval ? 'on' : 'off'}/${settings.memoryWriteApproval ? 'on' : 'off'} curator=${settings.curatorEnabled ? 'on' : 'off'} skills=${util.skillsDir()}`)
}

/**
 * Hermes runs `maybe_run_curator` from the session-start path. Two shapes exist
 * upstream (`hermes_cli/cli_tui_runtime_mixin.py:352` uses
 * `idle_for_seconds=float('inf')`, the web server passes a measured idle), so
 * `startup` means fully idle and `resume` keeps the measured idle. Returns the
 * `curatorTick` options, or undefined when this creation is not a user session
 * start. Our own forks share the `hermes-evolve-` prefix and are skipped.
 */
function curatorSessionStartIdle (payload, settings) {
  if (payload === null || typeof payload !== 'object') return undefined
  if (settings.enabled === false || settings.curatorEnabled === false) return undefined
  const source = payload.source
  if (source !== 'startup' && source !== 'resume') return undefined
  const agent = payload.agent
  if (agent === null || typeof agent !== 'object') return undefined
  const session = agent.session
  if (session !== null && typeof session === 'object' && typeof session.id === 'string' && session.id.startsWith(`${PLUGIN}-`)) {
    return undefined
  }
  if (agent.status !== 'idle') return undefined
  return source === 'startup' ? { idleHours: Number.POSITIVE_INFINITY } : {}
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
  // `sessionPersistence` lets `/backfill` read archived sessions; it is a core
  // service, so waiting for it costs nothing at load time.
  inject: ['settings', 'systemPrompt', 'tools', 'agents', 'agentDefaultModel', 'sessions', 'commands', 'sessionPersistence'],
  Config,
  apply,
  __internals: {
    sanitizeConfig,
    resolveLang,
    summarizeCuratorResult,
    curatorSessionStartIdle,
  },
}