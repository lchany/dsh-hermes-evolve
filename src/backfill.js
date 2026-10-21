'use strict'

/**
 * Historical backfill — replay archived sessions through the same review pass.
 *
 * The port reviews the *live* conversation (scheduler on `turn/end`) and offers
 * `/refine` for one session on demand. Imported sessions and sessions from
 * before this plugin existed never went through either path, so their lessons
 * never reached MEMORY.md / USER.md / the skill tree. This module closes that
 * gap without inventing a second distillation strategy: it renders each archived
 * transcript exactly as `review.renderTranscript` expects and calls the same
 * `runReview`, so a backfilled lesson is written by the same prompts, the same
 * toolset, and the same approval gates as a live review.
 *
 * Two deliberate differences from an automatic review:
 *   - memory consolidation is allowed (`unattendedMemory: false`). A live review
 *     is add-only so an unattended turn can never delete a human's notes; a
 *     backfill is user-initiated and would otherwise saturate the 1375/2200-char
 *     budgets in a dozen sessions and then write nothing at all.
 *   - the run is incremental and interruptible: a status file records progress,
 *     `stop` cancels between sessions, and the ledger-like result list makes a
 *     rerun pick up where the last one stopped (`--force` ignores that).
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const util = require('./util')
const memory = require('./memory')

/** Review forks review the memory system itself; backfilling them is noise. */
const META_PREFIX = 'hermes-evolve-review-'
const STATUS_FILE = 'backfill-status.json'
const LOG_FILE = 'backfill-log.jsonl'
const MAX_STATUS_RESULTS = 60

/** The in-process run, if any. Only one backfill may own the host at a time. */
let active = null

function statusPath () {
  return path.join(util.stateDir(), STATUS_FILE)
}

function logPath () {
  return path.join(util.stateDir(), LOG_FILE)
}

/** A queued `{options}` document that starts a run on the next plugin load. */
function requestPath () {
  return path.join(util.stateDir(), 'backfill-request.json')
}

/**
 * Start the run an operator queued before restarting the host.
 *
 * Plugin code only reloads with the host, so a backfill prepared in one session
 * has no way to start itself later. Writing the request file and consuming it
 * here keeps that restart as the only manual step.
 */
async function resumeRequest (deps, { delayMs = 15000 } = {}) {
  let options
  try {
    options = JSON.parse(await fsp.readFile(requestPath(), 'utf8'))
  } catch {
    return { started: false, error: 'no queued backfill request' }
  }
  try { await fsp.rm(requestPath(), { force: true }) } catch { /* retried next load */ }
  if (delayMs > 0) await sleep(delayMs)
  return start(deps, options !== null && typeof options === 'object' ? options : {})
}

function contentText (content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Archived events → the `{role, content, source}` messages `renderTranscript`
 * reads. Tool traffic is omitted on purpose: the transcript budget is 12k chars
 * and tool results would crowd out the conversation the reviewer learns from.
 */
function buildMessages (events) {
  const messages = []
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type === 'user/message') {
      const data = event.data && typeof event.data === 'object' ? event.data : {}
      const kind = data.source && typeof data.source === 'object' ? data.source.kind : ''
      if (typeof kind === 'string' && kind !== '' && kind !== 'user') continue
      const text = contentText(data.content)
      if (text === '') continue
      messages.push({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
    } else if (event.type === 'assistant/message') {
      const data = event.data && typeof event.data === 'object' ? event.data : {}
      const message = data.message && typeof data.message === 'object' ? data.message : {}
      const text = contentText(message.content)
      if (text === '') continue
      messages.push({ role: 'assistant', content: [{ type: 'text', text }] })
    }
  }
  return messages
}

/** Characters currently stored in one built-in memory store. */
function memoryChars (kind) {
  try {
    return fs.readFileSync(memory.storeFile(util.memoryDir(), kind), 'utf8').length
  } catch {
    return 0
  }
}

/** Both budgets at/over their cap: add-only reviews can no longer write memory. */
function memorySaturated (settings) {
  const memoryLimit = Number(settings.memoryCharLimit) || 2200
  const userLimit = Number(settings.userCharLimit) || 1375
  return memoryChars('memory') >= memoryLimit * 0.98 && memoryChars('user') >= userLimit * 0.98
}

async function readStatus () {
  try {
    const parsed = JSON.parse(await fsp.readFile(statusPath(), 'utf8'))
    if (parsed !== null && typeof parsed === 'object') return parsed
  } catch { /* first run */ }
  return { running: false, reviewed: 0, skipped: 0, failed: 0, actions: 0, results: [] }
}

async function writeStatus (state) {
  try {
    await fsp.mkdir(util.stateDir(), { recursive: true })
    await util.atomicWriteJson(statusPath(), state)
  } catch { /* status is advisory; a lost write must not stop the run */ }
}

async function appendLog (row) {
  try {
    await fsp.mkdir(util.stateDir(), { recursive: true })
    await fsp.appendFile(logPath(), `${JSON.stringify(row)}\n`)
  } catch { /* same */ }
}

/**
 * Completed-session ledger, independent of the (windowed) status list.
 *
 * Status keeps only the last MAX_STATUS_RESULTS rows so the panel payload stays
 * small; that window cannot double as resume state or a long run would re-review
 * its own early sessions after a restart.
 */
function ledgerPath () {
  return path.join(util.stateDir(), 'backfill-ledger.json')
}

function readLedger () {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'))
    const done = new Map()
    for (const row of Array.isArray(parsed.sessions) ? parsed.sessions : []) {
      if (row && typeof row.id === 'string') done.set(row.id, row)
    }
    return done
  } catch {
    return new Map()
  }
}

async function recordLedger (row) {
  try {
    const done = readLedger()
    done.set(row.id, { id: row.id, at: row.at, actions: row.actions, cwd: row.cwd })
    const sessions = [...done.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)))
    await fsp.mkdir(util.stateDir(), { recursive: true })
    await util.atomicWriteJson(ledgerPath(), { updatedAt: new Date().toISOString(), sessions })
  } catch { /* the ledger is an optimisation, not a correctness gate */ }
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Candidate sessions, richest first.
 *
 * `eventCount` is a cheap proxy for turn count; sessions the backend cannot size
 * cheaply fall to the end and are still attempted.
 */
async function collectTargets (hostCtx, options) {
  const persistence = hostCtx.get?.('sessionPersistence')
  if (persistence === undefined || persistence === null) {
    throw new Error('sessionPersistence service is unavailable in this profile')
  }
  const snapshots = await persistence.list()
  const rows = []
  for (const snapshot of snapshots || []) {
    const header = snapshot !== null && typeof snapshot === 'object' ? snapshot.header : undefined
    const id = header !== null && typeof header === 'object' ? header.id : undefined
    if (typeof id !== 'string' || id === '') continue
    if (options.includeMeta !== true && id.startsWith(META_PREFIX)) continue
    const cwd = typeof header.cwd === 'string' ? header.cwd : ''
    if (typeof options.workspace === 'string' && options.workspace !== ''
      && path.basename(cwd) !== options.workspace) continue
    rows.push({
      id,
      cwd,
      title: typeof header.title === 'string' ? header.title : '',
      eventCount: Number(snapshot.eventCount) || 0,
      sizeBytes: Number(snapshot.sizeBytes) || 0,
    })
  }
  rows.sort((a, b) => (b.eventCount - a.eventCount) || (b.sizeBytes - a.sizeBytes))
  return rows
}

/** Read one stored session's events into the message shape reviewers consume. */
async function sessionMessages (persistence, id) {
  const handle = await persistence.open(id, 'read')
  try {
    const read = await handle.read()
    return buildMessages(read && Array.isArray(read.events) ? read.events : [])
  } finally {
    try { await handle.close() } catch { /* already closed */ }
  }
}

/** Review actions are localized one-line summaries, so count them by text. */
function actionKinds (actions) {
  const counts = {}
  for (const action of Array.isArray(actions) ? actions : []) {
    const name = typeof action === 'string'
      ? action.slice(0, 60)
      : (action !== null && typeof action === 'object'
          ? String(action.tool || action.kind || action.target || 'action').slice(0, 60)
          : 'action')
    counts[name] = (counts[name] || 0) + 1
  }
  return counts
}

/** Sessions whose review already succeeded; a failed review stays eligible. */
function alreadyReviewed () {
  return new Set(readLedger().keys())
}

/**
 * Start a backfill run in the background.
 *
 * @returns {Promise<{started:boolean, error?:string, status?:object}>}
 */
async function start (deps, options = {}) {
  if (active !== null) return { started: false, error: 'a backfill is already running', status: active }
  const hostCtx = deps.hostCtx
  const logger = deps.logger
  const runReview = deps.runReview
  const settings = deps.settings
  if (typeof runReview !== 'function') return { started: false, error: 'review engine unavailable' }

  const options_ = {
    limit: Number(options.limit) > 0 ? Number(options.limit) : 0,
    workspace: typeof options.workspace === 'string' ? options.workspace : '',
    idleStop: Number.isFinite(Number(options.idleStop)) && Number(options.idleStop) >= 0 ? Number(options.idleStop) : 3,
    maxMinutes: Number.isFinite(Number(options.maxMinutes)) && Number(options.maxMinutes) > 0 ? Number(options.maxMinutes) : 0,
    pauseMs: Number.isFinite(Number(options.pauseMs)) ? Number(options.pauseMs) : 750,
    consolidate: options.consolidate !== false,
    reviewMemory: options.reviewMemory !== false,
    reviewSkills: options.reviewSkills !== false,
    includeMeta: options.includeMeta === true,
    force: options.force === true,
    dryRun: options.dryRun === true,
    focus: typeof options.focus === 'string' ? options.focus : '',
  }

  const state = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    stopReason: null,
    error: null,
    options: options_,
    candidates: 0,
    reviewed: 0,
    skipped: 0,
    failed: 0,
    actions: 0,
    idleStreak: 0,
    current: null,
    lastError: null,
    results: [],
  }
  // Read the ledger BEFORE the first status write: that write starts from an
  // empty result list and would otherwise erase the record of what already ran.
  const done = options_.force ? new Set() : alreadyReviewed()
  active = state
  await writeStatus(state)

  void (async () => {
    const startedAtMs = Date.now()
    try {
      const targets = await collectTargets(hostCtx, options_)
      state.candidates = targets.length
      await writeStatus(state)
      logger.info?.(`[hermes-evolve] backfill: ${targets.length} candidate sessions`)
      const persistence = hostCtx.get('sessionPersistence')
      if (options_.dryRun === true) {
        // Report what a real run would do without spending a single token.
        for (const target of targets) {
          let messages
          try { messages = await sessionMessages(persistence, target.id) } catch { state.skipped += 1; continue }
          const turns = messages.reduce((count, message) => count + (message.role === 'user' ? 1 : 0), 0)
          if (turns === 0 || messages.length < 2) { state.skipped += 1; continue }
          state.candidates = state.candidates
          state.results.push({ id: target.id, cwd: target.cwd, turns, ok: null, actions: 0, kinds: {}, at: new Date().toISOString(), planned: true })
          if (state.results.length > MAX_STATUS_RESULTS) state.results.shift()
        }
        state.stopReason = 'dry-run'
        return
      }
      for (const target of targets) {
        if (state.cancelled === true) { state.stopReason = 'cancelled'; break }
        if (options_.limit > 0 && state.reviewed >= options_.limit) { state.stopReason = 'limit'; break }
        if (options_.maxMinutes > 0 && Date.now() - startedAtMs > options_.maxMinutes * 60000) { state.stopReason = 'time-limit'; break }
        if (options_.consolidate !== true && memorySaturated(settings)) { state.stopReason = 'memory-budget-full'; break }
        if (done.has(target.id)) { state.skipped += 1; continue }

        let messages
        try {
          messages = await sessionMessages(persistence, target.id)
        } catch (error) {
          state.skipped += 1
          await appendLog({ id: target.id, at: new Date().toISOString(), ok: false, error: `read: ${error && error.message ? error.message : error}` })
          continue
        }
        const turns = messages.reduce((count, message) => count + (message.role === 'user' ? 1 : 0), 0)
        if (turns === 0 || messages.length < 2) { state.skipped += 1; continue }

        state.current = { id: target.id, cwd: target.cwd, turns, startedAt: new Date().toISOString() }
        await writeStatus(state)
        const focus = options_.focus !== ''
          ? options_.focus
          : 'This is a historical session being backfilled. Prefer updating an existing memory entry over adding a near-duplicate; capture durable user preferences and reusable procedures only.'
        const result = await runReview(hostCtx, {
          cwd: target.cwd || process.cwd(),
          messages,
          reviewMemory: options_.reviewMemory,
          reviewSkills: options_.reviewSkills,
          focus,
          settings,
          logger,
          allowMemoryRewrite: options_.consolidate === true,
        })
        const actions = Array.isArray(result.actions) ? result.actions : []
        const row = {
          id: target.id,
          cwd: target.cwd,
          turns,
          ok: result.ok === true,
          skipped: result.skipped,
          error: result.error,
          actions: actions.length,
          kinds: actionKinds(actions),
          durationMs: result.durationMs,
          at: new Date().toISOString(),
        }
        state.reviewed += 1
        state.actions += actions.length
        if (result.ok !== true) {
          state.failed += 1
          state.lastError = result.error || result.skipped || 'review failed'
        }
        state.idleStreak = result.ok === true && actions.length === 0 ? state.idleStreak + 1 : 0
        state.results.push(row)
        if (state.results.length > MAX_STATUS_RESULTS) state.results.shift()
        state.current = null
        await appendLog(row)
        if (row.ok === true) await recordLedger(row)
        await writeStatus(state)
        logger.info?.(`[hermes-evolve] backfill ${state.reviewed}: ${target.id} ok=${row.ok} actions=${row.actions} (${Math.round((result.durationMs || 0) / 1000)}s)`)
        if (options_.idleStop > 0 && state.idleStreak >= options_.idleStop) { state.stopReason = `idle-${options_.idleStop}`; break }
        if (options_.pauseMs > 0) await sleep(options_.pauseMs)
      }
      if (state.stopReason === null) state.stopReason = 'complete'
    } catch (error) {
      state.error = error && error.message ? error.message : String(error)
      state.stopReason = 'error'
      logger.warn?.(`[hermes-evolve] backfill failed: ${state.error}`)
    } finally {
      state.running = false
      state.finishedAt = new Date().toISOString()
      state.current = null
      active = null
      await writeStatus(state)
    }
  })()

  return { started: true, status: { ...state, results: [] } }
}

/** Ask the running backfill to stop after the current session. */
function stop () {
  if (active === null) return { stopped: false, error: 'no backfill is running' }
  active.cancelled = true
  return { stopped: true }
}

/** One-line status for chat commands. */
async function statusText () {
  const status = await readStatus()
  if (status.running !== true) {
    const when = status.finishedAt ? ` (finished ${status.finishedAt})` : ''
    return `Backfill idle${when}: reviewed=${status.reviewed || 0} skipped=${status.skipped || 0} failed=${status.failed || 0} actions=${status.actions || 0} stop=${status.stopReason || '-'}`
  }
  const current = status.current ? ` now=${status.current.id} (${status.current.turns} turns)` : ''
  return `Backfill running: reviewed=${status.reviewed}/${status.candidates} failed=${status.failed} actions=${status.actions} idleStreak=${status.idleStreak}${current}`
}

/**
 * Command-line style option parsing for `/backfill`.
 * `status` and `stop` are sub-commands, not flags.
 */
function parseArgs (rawInput) {
  const args = String(rawInput === undefined || rawInput === null ? '' : rawInput).trim().split(/\s+/).filter(Boolean)
  const options = {}
  let sub = ''
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === 'status' || arg === 'stop') { sub = arg; continue }
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--force') options.force = true
    else if (arg === '--include-meta') options.includeMeta = true
    else if (arg === '--no-consolidate') options.consolidate = false
    else if (arg === '--memory-only') { options.reviewSkills = false }
    else if (arg === '--skills-only') { options.reviewMemory = false }
    else if (arg === '--limit') options.limit = Number(args[++i])
    else if (arg === '--idle-stop') options.idleStop = Number(args[++i])
    else if (arg === '--max-minutes') options.maxMinutes = Number(args[++i])
    else if (arg === '--workspace') options.workspace = args[++i]
    else if (arg === '--focus') options.focus = args.slice(i + 1).join(' ')
  }
  return { sub, options }
}

module.exports = {
  META_PREFIX,
  buildMessages,
  memoryChars,
  memorySaturated,
  collectTargets,
  sessionMessages,
  start,
  stop,
  statusText,
  readStatus,
  parseArgs,
  resumeRequest,
  statusPath,
  logPath,
  requestPath,
  ledgerPath,
}