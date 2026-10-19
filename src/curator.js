'use strict'

/**
 * The skill curator, ported from hermes `agent/curator.py`.
 *
 * Two halves, deliberately separated:
 *
 *  1. A DETERMINISTIC pass (`applyAutomaticTransitions` in skill_usage.js) that
 *     only ever marks `stale` / `active` / `archived` from inactivity. It is
 *     cheap, explainable, and always runs when the curator is enabled.
 *  2. An optional LLM CONSOLIDATION pass that merges narrow skills into
 *     umbrellas. It is opt-in (`curatorConsolidate`), takes a backup first, and
 *     its changes are reconciled against the tool calls it actually made —
 *     because a model that says "I consolidated 12 skills" while archiving 30
 *     is the failure mode hermes shipped a reconciliation step to catch.
 *
 * Both halves obey the same invariants: never delete (archive is the most
 * destructive action available), never touch a pinned or unmanaged skill, and
 * fall back to "do nothing" whenever the state it depends on is unreadable.
 */

const fsP = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const store = require('./skill_store')
const usageMod = require('./skill_usage')
const prompts = require('./prompts')
const { buildToolSet } = require('./skill_tools')
const util = require('./util')

const CURATOR_LOCK_STALE_SECONDS = 3600
const REPORTS_DIR = 'reports'

// ── state ──────────────────────────────────────────────────────────────────

function emptyState () {
  return {
    last_run_at: null,
    last_run_duration_seconds: null,
    last_run_summary: null,
    last_run_summary_shown_at: null,
    last_report_path: null,
    paused: false,
    run_count: 0,
    seeded_at: null,
    last_automatic: null,
    last_consolidation: null,
  }
}

async function loadState () {
  const raw = await util.readFileSafe(util.curatorStatePath())
  if (raw === undefined) return emptyState()
  const parsed = util.tryParseJson(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyState()
  return { ...emptyState(), ...parsed }
}

async function saveState (state) {
  await util.atomicWriteJson(util.curatorStatePath(), state)
}

// ── lock ───────────────────────────────────────────────────────────────────

async function acquireLock () {
  const lockDir = path.join(util.skillsDir(), '.locks', 'curator-run')
  await util.ensureDir(path.dirname(lockDir))
  try {
    await fsP.mkdir(lockDir)
    return { ok: true, release: async () => { try { await fsP.rm(lockDir, { recursive: true, force: true }) } catch { /* gone */ } } }
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      // Two CLIs launched seconds apart both saw the interval elapsed and both
      // pruned the tree (hermes history). A stale claim may be taken over.
      try {
        const stat = await fsP.stat(lockDir)
        if ((Date.now() - stat.mtimeMs) / 1000 > CURATOR_LOCK_STALE_SECONDS) {
          await fsP.rm(lockDir, { recursive: true, force: true })
          await fsP.mkdir(lockDir)
          return { ok: true, release: async () => { try { await fsP.rm(lockDir, { recursive: true, force: true }) } catch { /* gone */ } } }
        }
      } catch { /* raced with the holder: treat as held */ }
      return { ok: false, reason: 'locked' }
    }
    // The lock directory could not be created at all: fail open rather than
    // silently disabling the curator forever on read-only state dirs.
    return { ok: true, release: async () => {}, degraded: true }
  }
}

// ── archive ────────────────────────────────────────────────────────────────

/**
 * Archive one skill directory: move it under `skills/.archive/<name>`, collapse
 * collisions with a timestamp suffix, and age the destination's mtime so a later
 * `purge` (which walks by mtime) does not consider a freshly-archived skill
 * ancient. Returns the destination path.
 */
async function archiveSkillDir (skill) {
  const archiveRoot = util.archiveDir()
  await util.ensureDir(archiveRoot)
  let dest = path.join(archiveRoot, skill.name)
  if (await util.exists(dest)) {
    dest = path.join(archiveRoot, `${skill.name}-${util.isoFileStamp()}`)
  }
  await fsP.rename(skill.dir, dest)
  const now = new Date()
  await fsP.utimes(dest, now, now)
  await usageMod.markArchived(skill.name)
  return dest
}

// ── deterministic pass ─────────────────────────────────────────────────────

async function deterministicPass ({ settings, nowMs = Date.now() }) {
  const staleDays = Math.max(1, Number(settings.curatorStaleDays) || 14)
  const archiveDays = Math.max(1, Number(settings.curatorArchiveDays) || 30)
  if (archiveDays < staleDays) {
    return { ok: false, error: `curatorArchiveDays (${archiveDays}) must be >= curatorStaleDays (${staleDays}); refusing to run a pass that archives what it just marked stale.` }
  }
  const skills = await store.scanSkills()
  const usage = await usageMod.loadUsage()
  const records = new Map()
  for (const skill of skills) {
    const raw = usage[skill.name]
    if (raw === undefined) {
      // First sight: start the clock now instead of treating a missing record as
      // ancient evidence (hermes #79295: a first pass marked the whole library stale).
      await usageMod.seedRecordIfMissing(skill.name)
      records.set(skill.name, await usageMod.getRecord(skill.name))
    } else {
      records.set(skill.name, usageMod.backfill(raw))
    }
  }
  const archivePlan = []
  const result = await usageMod.applyAutomaticTransitions({
    records,
    now: nowMs,
    staleDays,
    archiveDays,
    isManaged: (name) => usageMod.isCuratorManagedRecord(records.get(name)),
    isProtected: () => false,
    isBundled: () => false,
    isCronReferenced: () => false,
    archive: (name, record) => {
      const skill = skills.find((candidate) => candidate.name === name)
      if (skill === undefined) return false
      archivePlan.push({ skill, reason: `inactive > ${archiveDays}d (state=${record && record.state ? record.state : 'unknown'})` })
      return true
    },
  })
  // Archive only after the whole plan is computed: a partially-applied
  // transition set is harder to reason about than a failed pass.
  const archived = []
  const errors = []
  for (const item of archivePlan) {
    try {
      const dest = await archiveSkillDir(item.skill)
      archived.push({ name: item.skill.name, dest, reason: item.reason })
      await store.ledgerAppend({
        action: 'archive',
        actor: 'curator',
        skill: item.skill.name,
        dir: item.skill.dir,
        dest,
        reason: item.reason,
        complete_package: true,
      })
    } catch (error) {
      errors.push({ skill: item.skill.name, error: error && error.message ? error.message : String(error) })
    }
  }
  return {
    ok: true,
    checked: result.checked,
    markedStale: result.marked_stale,
    reactivated: result.reactivated,
    seeded: result.seeded,
    archived,
    errors,
    remaining: skills.length - archived.length,
    staleDays,
    archiveDays,
  }
}

// ── consolidation pass (LLM) ───────────────────────────────────────────────

async function consolidationPass ({ hostCtx, settings, logger, dryRun, model }) {
  const now = new Date()
  const skills = await store.scanSkills()
  const usage = await usageMod.loadUsage()
  const catalog = skills.map((skill) => ({ name: skill.name, description: skill.description, category: skill.category }))
  const systemPrompt = prompts.curatorSystemPrompt({ dryRun })
  const userMessage = prompts.buildCuratorUserMessage({
    catalog,
    usage,
    idleDays: {
      staleDays: Math.max(1, Number(settings.curatorStaleDays) || 14),
      archiveDays: Math.max(1, Number(settings.curatorArchiveDays) || 30),
    },
    now: now.toISOString(),
    dryRun,
    lang: settings.lang,
  })

  const controller = new AbortController()
  const marks = store.makeReadMarks()
  const tools = buildToolSet({
    marks,
    agentCreated: true,
    actor: 'curator',
    requireReadBeforeWrite: true,
    linterEnabled: settings.linterEnabled !== false,
    ledgerEnabled: settings.ledgerEnabled !== false,
    supportFilesEnabled: settings.supportFilesEnabled !== false,
    maxSupportFileChars: settings.maxSupportFileChars,
    maxBodyChars: settings.maxBodyChars,
    memoryCharLimit: settings.memoryCharLimit,
    userCharLimit: settings.userCharLimit,
  })
  const selected = model && (model.provider || model.model)
    ? model
    : (() => { try { return hostCtx.agentDefaultModel.currentSelection() } catch { return undefined } })()

  let handle
  const timer = setTimeout(() => { try { controller.abort() } catch { /* aborted */ } },
    Math.max(60, settings.reviewTimeoutSec * 3) * 1000)
  try {
    handle = await hostCtx.agents.create({
      sessionId: `hermes-evolve-curator-${randomUUID()}`,
      meta: { cwd: util.dshHome(), origin: 'subagent', agentPreset: 'standard', isSeeded: false },
      agentOptions: selected && (selected.provider || selected.model)
        ? { ...(selected.provider ? { provider: selected.provider } : {}), ...(selected.model ? { model: selected.model } : {}) }
        : {},
      signal: controller.signal,
      setup (agentCtx) {
        agentCtx.systemPrompt.section({
          name: 'hermes-evolve:curator-system', order: 0, text: systemPrompt, complete: true, interpolate: false,
        })
        for (const definition of tools) agentCtx.tools.register(definition)
        restrictInherited(agentCtx, logger)
      },
    })
    const agent = handle.agent
    agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: userMessage }], source: { kind: 'user' } })
    await agent.whenIdle()
    const summary = lastAssistantText(agent)
    const deletes = collectToolDeletes(agent)
    const after = await store.scanSkills()
    return { ok: true, summary, deletes, before: catalog.map((entry) => entry.name), after: after.map((entry) => entry.name), dryRun }
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
    if (handle !== undefined) { try { await handle.dispose() } catch { /* gone */ } }
  }
}

function restrictInherited (agentCtx, logger) {
  let inherited = []
  try { inherited = agentCtx.tools.schemas().map((schema) => schema.name) } catch { return }
  const ours = new Set(['skills_list', 'skill_view', 'skill_manage', 'memory'])
  inherited = inherited.filter((name) => !ours.has(name))
  if (inherited.length === 0) return
  try { agentCtx.tools.restrict({ deny: inherited }) } catch (error) {
    logger?.debug?.(`[hermes-evolve] curator cannot restrict tools: ${error && error.message}`)
  }
}

function lastAssistantText (agent) {
  try {
    const events = agent.session.snapshotEvents()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event.type !== 'assistant/message') continue
      const content = event.data && event.data.message ? event.data.message.content : []
      const text = util.contentToText(content)
      if (text !== '') return text
    }
  } catch { /* best effort */ }
  return ''
}

/** Every `skill_manage` delete op the fork actually issued, from the durable log. */
function collectToolDeletes (agent) {
  const deletes = []
  try {
    for (const event of agent.session.snapshotEvents()) {
      if (event.type !== 'tool/call' || event.data.name !== 'skill_manage') continue
      let args
      try { args = JSON.parse(event.data.arguments) } catch { continue }
      const ops = Array.isArray(args && args.operations) ? args.operations : []
      for (const op of ops) {
        if (!op || op.action !== 'delete') continue
        deletes.push({
          skill: String(op.name || ''),
          absorbedInto: typeof op.absorbed_into === 'string' ? op.absorbed_into.trim() : '',
        })
      }
    }
  } catch { /* best effort */ }
  return deletes
}

/**
 * Reconcile intent against effect (hermes #29912: an agent reported a
 * consolidation while archiving an entire cluster unverified). Every skill that
 * disappeared must be named by a delete call the fork made; those that name a
 * surviving umbrella count as consolidated, and anything else is reported as
 * unexplained rather than assumed good.
 */
function reconcile ({ before, after, deletes }) {
  const surviving = new Set(after)
  const removed = before.filter((name) => !surviving.has(name))
  const named = new Map()
  for (const item of deletes) if (item.skill !== '') named.set(item.skill, item.absorbedInto)
  const consolidated = []
  const pruned = []
  const unexplained = []
  for (const name of removed) {
    if (!named.has(name)) { unexplained.push(name); continue }
    const absorbedInto = named.get(name)
    if (absorbedInto !== '' && surviving.has(absorbedInto)) consolidated.push({ from: name, into: absorbedInto })
    else pruned.push({ name })
  }
  return {
    removed,
    consolidated,
    pruned,
    unexplained,
    // The signal hermes treats as a broken pass: archiving a lot while verifying
    // no consolidation at all.
    suspicious: removed.length >= 5 && consolidated.length === 0,
  }
}

// ── the pass ───────────────────────────────────────────────────────────────

async function runCurator ({ hostCtx, settings, logger, dryRun = false, consolidate = undefined, force = false, model }) {
  if (settings.curatorEnabled === false && force !== true) {
    return { ok: false, skipped: 'disabled' }
  }
  const state = await loadState()
  if (state.paused === true && force !== true) return { ok: false, skipped: 'paused' }
  const lock = await acquireLock()
  if (!lock.ok) return { ok: false, skipped: 'locked' }

  const startedAt = Date.now()
  try {
    const nowMs = Date.now()
    const consolidatePass = consolidate === undefined ? settings.curatorConsolidate === true : consolidate === true

    if (dryRun !== true) {
      // First observation seeds the clock instead of running: an interval of a
      // week must not fire just because the plugin was installed today.
      if (state.last_run_at === null) {
        state.last_run_at = new Date(nowMs).toISOString()
        state.seeded_at = state.last_run_at
        state.last_run_summary = 'deferred first run — curator seeded, will run after one interval'
        await saveState(state)
        return { ok: true, skipped: 'seeded', summary: state.last_run_summary }
      }
      const intervalHours = Math.max(1, Number(settings.curatorIntervalHours) || 24 * 7)
      const elapsedHours = (nowMs - Date.parse(state.last_run_at)) / 3_600_000
      if (force !== true && elapsedHours < intervalHours) {
        return { ok: false, skipped: 'not-due', elapsedHours, intervalHours }
      }
    }

    if (consolidatePass && dryRun !== true) {
      const backup = await store.createBackup({ keep: Math.max(1, Number(settings.curatorBackupKeep) || 2) })
      logger?.info?.(`[hermes-evolve] curator backup ${backup && backup.id ? backup.id : '(failed)'}`)
    }

    const automatic = await deterministicPass({ settings, nowMs })
    let consolidation = null
    if (consolidatePass) {
      const raw = await consolidationPass({ hostCtx, settings, logger, dryRun, model })
      if (raw.ok !== true) consolidation = { ok: false, error: raw.error }
      else {
        consolidation = {
          ok: true,
          dryRun,
          summary: raw.summary.slice(0, 4000),
          deletes: raw.deletes,
          ...(dryRun ? {} : reconcile({ before: raw.before, after: raw.after, deletes: raw.deletes })),
        }
      }
    }

    const durationSeconds = Math.round((Date.now() - startedAt) / 100) / 10
    if (dryRun !== true) {
      state.last_run_at = new Date().toISOString()
      state.last_run_duration_seconds = durationSeconds
      state.run_count = (state.run_count || 0) + 1
      state.last_automatic = {
        checked: automatic.ok === true ? automatic.checked : null,
        marked_stale: automatic.ok === true ? automatic.markedStale : null,
        archived: automatic.ok === true ? automatic.archived.map((item) => item.name) : [],
        reactivated: automatic.ok === true ? automatic.reactivated : null,
      }
      state.last_consolidation = consolidation !== null && consolidation.ok === true
        ? { consolidated: consolidation.consolidated.length, pruned: consolidation.pruned.length, unexplained: consolidation.unexplained }
        : consolidation
      state.last_run_summary = summaryLine(automatic, consolidation)
      const reportPath = await writeReport({ automatic, consolidation, state })
      state.last_report_path = reportPath
      await saveState(state)
      return { ok: true, state, automatic, consolidation, durationSeconds, reportPath }
    }
    return { ok: true, dryRun: true, state, automatic, consolidation }
  } finally {
    await lock.release()
  }
}

function summaryLine (automatic, consolidation) {
  const bits = []
  if (automatic && automatic.ok === true) {
    bits.push(`${automatic.checked} checked`)
    if (automatic.markedStale) bits.push(`${automatic.markedStale} stale`)
    if (automatic.reactivated) bits.push(`${automatic.reactivated} reactivated`)
    if (automatic.archived.length > 0) bits.push(`${automatic.archived.length} archived`)
  }
  if (consolidation && consolidation.ok === true) {
    if (consolidation.dryRun === true) bits.push('consolidation dry-run')
    else {
      bits.push(`${consolidation.consolidated.length} consolidated`)
      if (consolidation.pruned.length > 0) bits.push(`${consolidation.pruned.length} pruned`)
      if (consolidation.unexplained.length > 0) bits.push(`${consolidation.unexplained.length} UNEXPLAINED`)
    }
  }
  return bits.length === 0 ? 'nothing to do' : bits.join(', ')
}

async function writeReport ({ automatic, consolidation, state }) {
  const dir = path.join(util.skillsDir(), '.curator_backups', REPORTS_DIR)
  await util.ensureDir(dir)
  const stamp = util.isoFileStamp()
  const lines = [`# Curator report ${new Date().toISOString()}`, '', `Summary: ${summaryLine(automatic, consolidation)}`, '']
  if (automatic && automatic.ok === true) {
    lines.push('## Deterministic transitions', `- checked: ${automatic.checked}`)
    lines.push(`- marked stale: ${automatic.markedStale}`, `- reactivated: ${automatic.reactivated}`, `- archived: ${automatic.archived.length}`)
    for (const item of automatic.archived) lines.push(`  - ${item.name} (${item.reason}) -> ${item.dest}`)
    if (automatic.errors && automatic.errors.length > 0) {
      lines.push('', '### Errors')
      for (const item of automatic.errors) lines.push(`- ${item.skill}: ${item.error}`)
    }
  } else if (automatic && automatic.error) {
    lines.push('## Deterministic pass refused', automatic.error)
  }
  if (consolidation !== null) {
    lines.push('', '## Consolidation pass')
    if (consolidation.ok !== true) lines.push(`FAILED: ${consolidation.error}`)
    else if (consolidation.dryRun === true) lines.push('DRY-RUN — no changes written.', '', consolidation.summary)
    else {
      lines.push(`- consolidated: ${consolidation.consolidated.length}`, `- pruned: ${consolidation.pruned.length}`, `- unexplained removals: ${consolidation.unexplained.length}`)
      for (const item of consolidation.consolidated) lines.push(`  - ${item.from} -> ${item.into}`)
      for (const item of consolidation.pruned) lines.push(`  - pruned: ${item.name}`)
      for (const name of consolidation.unexplained) lines.push(`  - UNEXPLAINED removal: ${name}`)
      if (consolidation.suspicious) lines.push('', 'WARNING: many skills disappeared with no verified consolidation — inspect the transcript before trusting this pass.')
      lines.push('', '### Fork report', consolidation.summary)
    }
  }
  const reportPath = path.join(dir, `${stamp}.md`)
  await util.atomicWrite(reportPath, lines.join('\n'))
  return reportPath
}

// ── lifecycle helpers used by the plugin and the panel ────────────────────

async function status () {
  const state = await loadState()
  const skills = await store.scanSkills()
  const usage = await usageMod.loadUsage()
  const managed = skills.filter((skill) => usageMod.isCuratorManagedRecord(usageMod.getRecord(usage, skill.name)))
  const counts = { active: 0, stale: 0, archived: 0 }
  for (const skill of skills) {
    const record = usageMod.getRecord(usage, skill.name)
    if (record.state === 'stale') counts.stale += 1
    else if (record.state === 'archived') counts.archived += 1
    else counts.active += 1
  }
  const intervalHours = 24 * 7
  const dueIn = state.last_run_at === null
    ? 0
    : Math.max(0, intervalHours - (Date.now() - Date.parse(state.last_run_at)) / 3_600_000)
  return {
    state,
    skills: skills.length,
    managed: managed.length,
    counts,
    backups: await store.listBackups(),
    dueInHours: Math.round(dueIn * 10) / 10,
  }
}

async function setPaused (paused) {
  const state = await loadState()
  state.paused = paused === true
  await saveState(state)
  return state
}

async function runNow ({ hostCtx, settings, logger, dryRun = false, consolidate = undefined, model }) {
  return runCurator({ hostCtx, settings, logger, dryRun, consolidate, force: true, model })
}

module.exports = {
  ARCHIVE_DIR: util.archiveDir,
  loadState,
  saveState,
  deterministicPass,
  consolidationPass,
  reconcile,
  runCurator,
  runNow,
  status,
  setPaused,
  archiveSkillDir,
  collectToolDeletes,
  CURATOR_LOCK_STALE_SECONDS,
}