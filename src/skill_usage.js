'use strict'

/**
 * Skill usage sidecar — a faithful port of hermes `tools/skill_usage.py`.
 *
 * The record lives in `$DSH_HOME/skills/.usage.json`, keyed by SKILL NAME (never
 * frontmatter), because the same skill can move between directories during
 * consolidation and its history must follow the name.
 *
 * Where hermes reads provenance from bundling manifests, we read it from the
 * skill's source tier as reported by the DSH skills service (or, in the offline
 * scan, from the directory it was found under).
 */

const { join } = require('node:path')
const {
  skillsDir, usagePath, readFileSafe, atomicWriteJson, isoNow,
} = require('./util')
const { LIMITS } = require('./const')

const DAY_MS = LIMITS.DAY_MS

const STATE_ACTIVE = 'active'
const STATE_STALE = 'stale'
const STATE_ARCHIVED = 'archived'

/** Fields a record always carries; missing keys are backfilled on read. */
function emptyRecord () {
  return {
    created_by: null,
    use_count: 0,
    view_count: 0,
    last_used_at: null,
    last_viewed_at: null,
    patch_count: 0,
    patch_generation: 0,
    last_reused_patch_generation: 0,
    last_patched_at: null,
    created_at: isoNow(),
    state: STATE_ACTIVE,
    pinned: false,
    archived_at: null,
    // When the curator first anchored this skill's inactivity clock (seed or
    // re-anchor); null = never seen.
    first_seen_at: null,
  }
}

function backfill (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return emptyRecord()
  return { ...emptyRecord(), ...raw }
}

function num (value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** `latest_activity_at` — created_at is EXCLUDED on purpose so a never-active
 *  skill stays distinguishable from one that was used and then went quiet. */
function latestActivityAt (rec) {
  const stamps = [rec && rec.last_used_at, rec && rec.last_viewed_at, rec && rec.last_patched_at]
    .filter((v) => typeof v === 'string' && v !== '')
    .sort()
  return stamps.length === 0 ? null : stamps[stamps.length - 1]
}

function activityCount (rec) {
  return num(rec && rec.use_count) + num(rec && rec.view_count) + num(rec && rec.patch_count)
}

/** A record is "curator managed" only when the provenance marker says the agent
 *  authored it. Foreground creates record `created_by: "learn"`, so a skill the
 *  user asked for in conversation is NOT silently handed to the curator (#67140). */
function isCuratorManagedRecord (rec) {
  if (rec === null || typeof rec !== 'object') return false
  return rec.created_by === 'agent' || rec.agent_created === true
}

// ── sidecar I/O ────────────────────────────────────────────────────────────

async function loadUsage () {
  const raw = await readFileSafe(usagePath())
  if (raw === undefined || raw.trim() === '') return {}
  let data
  try {
    data = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    return {}
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return {}
  const out = {}
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) out[String(key)] = value
  }
  return out
}

async function saveUsage (data) {
  return atomicWriteJson(usagePath(), data)
}

async function getRecord (name) {
  const usage = await loadUsage()
  return backfill(usage[name])
}

/** Read-modify-write one record under the file lock. Returns the mutator result,
 *  or undefined when the write did not land. */
async function mutateRecord (name, mutator) {
  if (typeof name !== 'string' || name === '') return undefined
  const data = await loadUsage()
  const rec = backfill(data[name])
  data[name] = rec
  const result = mutator(rec)
  const ok = await saveUsage(data)
  return ok ? result : undefined
}

async function seedRecordIfMissing (name) {
  const data = await loadUsage()
  if (Object.prototype.hasOwnProperty.call(data, name)) return
  data[name] = { ...emptyRecord(), first_seen_at: isoNow() }
  await saveUsage(data)
}

/** Start a skill's inactivity clock NOW, once. Telemetry can write a record the
 *  moment a bundled skill is seeded, so by the curator's first sight created_at
 *  may be months old and every never-used built-in goes stale on that pass
 *  (#79295). `first_seen_at` marks the clock as anchored. */
async function reanchorClock (name) {
  return mutateRecord(name, (rec) => {
    rec.created_at = isoNow()
    rec.first_seen_at = rec.created_at
    if (rec.state === STATE_STALE) rec.state = STATE_ACTIVE
  })
}

function bump (rec, countKey, tsKey, at) {
  rec[countKey] = num(rec[countKey]) + 1
  rec[tsKey] = at || isoNow()
}

async function recordCreated (name, { agentCreated = false, at } = {}) {
  return mutateRecord(name, (rec) => {
    // `agent` = curator-managed; `learn` = foreground/user-requested create.
    rec.created_by = agentCreated ? 'agent' : 'learn'
    rec.created_at = at || isoNow()
  })
}

async function recordLoaded (name, { file = 'SKILL.md', at } = {}) {
  return mutateRecord(name, (rec) => {
    const stamp = at || isoNow()
    if (file === 'SKILL.md') {
      bump(rec, 'use_count', 'last_used_at', stamp)
    } else {
      bump(rec, 'view_count', 'last_viewed_at', stamp)
    }
  })
}

async function recordPatched (name, { at } = {}) {
  return mutateRecord(name, (rec) => {
    rec.patch_count = num(rec.patch_count) + 1
    rec.patch_generation = num(rec.patch_generation) + 1
    rec.last_patched_at = at || isoNow()
  })
}

async function setPinned (name, pinned) {
  await mutateRecord(name, (rec) => { rec.pinned = pinned === true })
  const rec = await getRecord(name)
  return rec.pinned === (pinned === true)
}

async function markState (name, state, extra = {}) {
  return mutateRecord(name, (rec) => {
    rec.state = state
    Object.assign(rec, extra)
  })
}

async function markArchived (name, at) {
  return markState(name, STATE_ARCHIVED, { archived_at: at || isoNow() })
}

// ── deterministic lifecycle transitions ────────────────────────────────────

/**
 * The inactivity prune that always runs when the curator is enabled.
 *
 * Faithful to hermes `apply_automatic_transitions`: a skill with no durable
 * record is seeded (never treated as ancient), a bundled skill nobody ever used
 * gets its clock re-anchored, and then four rules decide:
 *
 *   - never used and younger than the stale line -> reactivate if stale, skip
 *     (absence of evidence is not staleness);
 *   - anchor at or before the archive line -> archive (from active OR stale);
 *   - anchor at or before the stale line, currently active -> stale;
 *   - anchor newer than the stale line, currently stale -> active.
 *
 * @param {object} opts
 * @param {Map<string, object>} opts.records  name -> backfilled record
 * @param {number} opts.now                   epoch ms
 * @param {number} opts.staleDays
 * @param {number} opts.archiveDays
 * @param {(name: string) => boolean} [opts.isManaged]
 * @param {(name: string) => boolean} [opts.isProtected]
 * @param {(name: string) => boolean} [opts.isBundled]
 * @param {(name: string) => boolean} [opts.isCronReferenced]
 * @param {(name: string, name_) => Promise<boolean>} [opts.archive]
 * @returns {{checked:number, marked_stale:number, archived:number, reactivated:number, seeded:number, archived_names:string[]}}
 */
async function applyAutomaticTransitions (opts) {
  const now = opts.now || Date.now()
  const staleCutoff = now - opts.staleDays * DAY_MS
  const archiveCutoff = now - opts.archiveDays * DAY_MS
  const records = opts.records
  const counts = { checked: 0, marked_stale: 0, archived: 0, reactivated: 0, seeded: 0, archived_names: [] }
  const isManaged = opts.isManaged || (() => true)
  const isProtected = opts.isProtected || (() => false)
  const isBundled = opts.isBundled || (() => false)
  const isCronReferenced = opts.isCronReferenced || (() => false)

  for (const [name, rec] of records) {
    counts.checked += 1
    if (isProtected(name) || isCronReferenced(name)) continue
    if (rec.pinned === true) continue
    // Only curator-managed skills may be touched. A skill the user asked for in
    // conversation is `created_by: 'learn'` and must never auto-transition.
    if (!isManaged(name)) continue

    // 1. No durable record: seed so the clock starts at first sight.
    if (opts.isPersisted !== undefined && !opts.isPersisted(name)) {
      await seedRecordIfMissing(name)
      counts.seeded += 1
      continue
    }

    // 2. A bundled skill nobody ever used may carry months-old telemetry: the
    //    clock must start now, or the whole built-in set goes stale at once.
    const neverActive = latestActivityAt(rec) === null
    if (isBundled(name) && num(rec.use_count) === 0 && neverActive && !rec.first_seen_at) {
      await reanchorClock(name)
      Object.assign(rec, await getRecord(name))
      counts.seeded += 1
      continue
    }

    const anchorIso = latestActivityAt(rec) || rec.created_at || new Date(now).toISOString()
    const anchor = Date.parse(anchorIso)
    if (!Number.isFinite(anchor)) continue // corrupt timestamp: fail safe, do not transition

    if (num(rec.use_count) === 0 && anchor > staleCutoff) {
      if (rec.state === STATE_STALE) {
        await markState(name, STATE_ACTIVE)
        counts.reactivated += 1
      }
      continue
    }
    if (anchor <= archiveCutoff) {
      const ok = opts.archive ? await opts.archive(name, rec) : false
      if (ok) {
        await markArchived(name)
        counts.archived += 1
        counts.archived_names.push(name)
      }
      continue
    }
    if (anchor <= staleCutoff && rec.state === STATE_ACTIVE) {
      await markState(name, STATE_STALE)
      counts.marked_stale += 1
      continue
    }
    if (anchor > staleCutoff && rec.state === STATE_STALE) {
      await markState(name, STATE_ACTIVE)
      counts.reactivated += 1
    }
  }
  return counts
}

/** Curator-eligible + managed rows for reporting. */
async function curatedReport (names) {
  const usage = await loadUsage()
  const rows = []
  for (const name of [...names].sort()) {
    const rec = backfill(usage[name])
    rows.push({
      name,
      ...rec,
      last_activity_at: latestActivityAt(rec),
      activity_count: activityCount(rec),
      persisted: Object.prototype.hasOwnProperty.call(usage, name),
      managed: isCuratorManagedRecord(rec),
    })
  }
  return rows
}

module.exports = {
  STATE_ACTIVE,
  STATE_STALE,
  STATE_ARCHIVED,
  emptyRecord,
  backfill,
  latestActivityAt,
  activityCount,
  isCuratorManagedRecord,
  loadUsage,
  saveUsage,
  getRecord,
  mutateRecord,
  seedRecordIfMissing,
  reanchorClock,
  recordCreated,
  recordLoaded,
  recordPatched,
  setPinned,
  markState,
  markArchived,
  applyAutomaticTransitions,
  curatedReport,
  usageFile: () => join(skillsDir(), '.usage.json'),
}