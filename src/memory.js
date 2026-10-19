'use strict'

/**
 * The two memory stores, ported from Hermes' builtin memory subsystem.
 *
 * Storage contract (memory_tool_store.py):
 *   - one plain-text file per store, entries joined by ENTRY_DELIMITER ("\n§\n")
 *   - no banner in the file; the header is synthesized at render time
 *   - the limit is measured on the joined text, delimiters included
 *   - an empty store and a store of blank lines are both "empty"
 *
 * Injection contract (memory_tool_store.format_for_system_prompt):
 *   - the system prompt gets a FROZEN load-time snapshot, never live state;
 *     mid-session writes change disk and the tool's view but not the prompt
 *     bytes, so the prefix cache survives
 */

const { join } = require('node:path')
const {
  readFileSafe, atomicWrite, normalizeEntry, truncate,
  workspaceCwdHeader,
} = require('./util')

const ENTRY_DELIMITER = '\n§\n'
const SEP = '═'.repeat(46)

const STORE_KIND = { memory: 'memory', user: 'user' }
const STORES = ['memory', 'user']

const HEADERS = {
  memory: 'MEMORY (your personal notes)',
  user: 'USER PROFILE (who the user is)',
}

/**
 * Threat scan. Memory enters the system prompt on every turn, so a poisoned
 * entry persists across sessions — Hermes' comment on `_scan_memory_content`
 * is explicit that this is why the scope is strict.
 */
const THREAT_PATTERNS = [
  /(sk-[A-Za-z0-9_-]{16,})/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|api[_-]?key|apikey|secret|access[_-]?token|bearer)\b\s*[=:]\s*\S{4,}/i,
  /\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?\b/i,
  /\byou\s+are\s+now\s+(?:a|an|the)\b/i,
  /^\s*system\s*:\s*/im,
]
const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

function storeFile (dir, store) {
  return join(dir, store === 'user' ? 'USER.md' : 'MEMORY.md')
}

/** Split on a line that is exactly `§`. Entries may contain newlines. */
function parseEntries (raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '')
  if (text.trim() === '') return []
  const entries = []
  let current = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '§') {
      const entry = current.join('\n').trim()
      if (entry !== '') entries.push(entry)
      current = []
      continue
    }
    current.push(line)
  }
  const tail = current.join('\n').trim()
  if (tail !== '') entries.push(tail)
  // Load-time de-duplication, order preserved (Hermes: dict.fromkeys).
  return [...new Set(entries)]
}

function serializeEntries (entries) {
  return entries.map((e) => String(e).trim()).filter((e) => e !== '').join(ENTRY_DELIMITER)
}

/** The char budget is measured on the serialized form, delimiters included. */
function charsOf (entries) {
  return serializeEntries(entries).length
}

/**
 * Matching normalization for old_text lookup (memory_tool_store._normalize_for_match):
 * quote variants fold to ', dash variants fold to -, whitespace runs collapse,
 * and a literal "\n" is treated as a space. Punctuation is NOT stripped —
 * "layout" and "lay-out" must stay distinguishable.
 */
function normalizeForMatch (text) {
  return String(text || '')
    .replace(/\\n/g, ' ')
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″]/g, "'")
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Whole-entry exact match wins over substring; otherwise substring is unique-checked. */
function findEntry (entries, oldText) {
  const needleRaw = String(oldText || '').trim()
  if (needleRaw === '') return { error: 'empty' }
  const needle = normalizeForMatch(needleRaw)
  if (!/[\p{L}\p{N}]/u.test(needle)) return { error: 'no-match' }

  const exact = entries.findIndex((e) => normalizeEntry(e) === needle || normalizeForMatch(e) === needle)
  if (exact >= 0) return { index: exact }

  const hits = []
  for (let i = 0; i < entries.length; i++) {
    if (normalizeForMatch(entries[i]).includes(needle)) hits.push(i)
  }
  if (hits.length === 1) return { index: hits[0] }
  if (hits.length === 0) return { error: 'no-match' }
  return { error: 'ambiguous', candidates: hits.map((i) => entries[i]) }
}

/** False when the entry carries a credential, an injection marker or control bytes. */
function scanEntry (text) {
  const s = String(text || '')
  const issues = []
  if (INVISIBLE_RE.test(s)) issues.push('invisible characters')
  if (CONTROL_RE.test(s)) issues.push('control characters')
  for (const re of THREAT_PATTERNS) {
    const m = s.match(re)
    if (m) {
      issues.push(`sensitive pattern (${truncate(m[1] || m[0], 24)})`)
      break
    }
  }
  return { ok: issues.length === 0, issues }
}

function renderSnapshotEntry (entry, index) {
  const scan = scanEntry(entry)
  if (scan.ok) return entry
  // The live entry stays on disk — deleting a user's memory to hide an attack
  // would destroy the evidence. Only the injected copy is replaced.
  return `[BLOCKED: entry #${index + 1} contained ${scan.issues.join(', ')}. Removed from the system prompt; use the panel to review and delete the original.]`
}

/**
 * Render one store the way Hermes does:
 *   ══════════...
 *   MEMORY (your personal notes) [67% — 1,474/2,200 chars]
 *   ══════════...
 *   entry one
 *   §
 *   entry two
 */
function renderBlock (store, entries, limit, { blockedInSnapshot = true } = {}) {
  if (entries.length === 0) return undefined
  const used = charsOf(entries)
  const pct = Math.min(100, Math.round((used / limit) * 100))
  const shown = blockedInSnapshot ? entries.map(renderSnapshotEntry) : entries
  return [
    SEP,
    `${HEADERS[store]} [${pct}% — ${used.toLocaleString('en-US')}/${limit.toLocaleString('en-US')} chars]`,
    SEP,
    serializeEntries(shown),
  ].join('\n')
}

// ── write planning ─────────────────────────────────────────────────────────

const OP_KINDS = ['add', 'replace', 'remove']

/**
 * Apply ONE op to an entry list, returning a plan (no I/O).
 * Mirrors Hermes: replace is whole-entry replacement, old_text only locates.
 */
function applyOne (entries, op) {
  const kind = op.action
  if (!OP_KINDS.includes(kind)) return { ok: false, reason: 'bad-action', detail: `unknown action '${kind}'` }

  if (kind === 'add') {
    const text = normalizeEntry(op.text)
    if (text === '') return { ok: false, reason: 'no-content', detail: "Content is required for 'add' action." }
    if (entries.some((e) => normalizeEntry(e) === text)) {
      // Exact duplicates are a no-op, not a failure (Hermes dedups on load too).
      return { ok: true, entries, noop: true, detail: 'Entry already exists (no duplicate added).' }
    }
    return { ok: true, entries: [...entries, text] }
  }

  const found = findEntry(entries, op.oldText)
  if (found.error === 'empty') {
    return { ok: false, reason: 'missing-old-text', detail: `old_text is required for '${kind}' action.` }
  }
  if (found.error === 'no-match') return { ok: false, reason: 'no-match', detail: `No entry matching '${truncate(op.oldText, 80)}' was found.` }
  if (found.error === 'ambiguous') return { ok: false, reason: 'ambiguous', detail: `'${truncate(op.oldText, 60)}' matches ${found.candidates.length} entries; quote more of the entry.`, candidates: found.candidates }

  if (kind === 'remove') {
    const next = entries.filter((_, i) => i !== found.index)
    return { ok: true, entries: next, removed: entries[found.index] }
  }

  const text = normalizeEntry(op.text)
  if (text === '') return { ok: false, reason: 'no-content', detail: "Content is required for 'replace' action." }
  const next = entries.slice()
  const previous = next[found.index]
  next[found.index] = text
  return { ok: true, entries: next, previous }
}

/**
 * Apply a batch. The limit is checked on the FINAL state only — that is what
 * makes "free 153 chars by shortening one entry, then add" possible in one call.
 */
function applyOperations (entries, operations, { limit }) {
  let current = entries.slice()
  const applied = []
  for (const op of operations) {
    const result = applyOne(current, op)
    if (!result.ok) {
      return { ok: false, ...result, current, applied, currentEntries: current }
    }
    current = result.entries
    applied.push({ ...op, noop: result.noop === true, previous: result.previous, removed: result.removed })
  }

  // Refuse to empty a previously non-empty store: a batch that removes every
  // entry is far more likely to be a matching accident than an intent.
  if (entries.length > 0 && current.length === 0) {
    return {
      ok: false,
      reason: 'would-empty',
      detail: 'Refusing to empty the store: this batch would remove every entry from a previously non-empty store. Delete the final entry deliberately with a single remove operation.',
      currentEntries: current,
      applied,
    }
  }

  const used = charsOf(current)
  if (used > limit) {
    const deficit = used - limit
    // Hermes' wording: the model must fix this in ONE corrective batch, because
    // the limit is checked on the batch result and a second round trip is worse
    // than the extra sentence.
    const usedText = used.toLocaleString('en-US')
    const limitText = limit.toLocaleString('en-US')
    const deficitText = deficit.toLocaleString('en-US')
    return {
      ok: false,
      reason: 'over-limit',
      detail: `Memory at ${usedText}/${limitText} chars; this batch would exceed the limit by ${deficitText} chars. ` +
        'Retry as ONE \'operations\' batch that removes or shortens (replace) stale entries from current_entries ' +
        `below to free at least ${deficitText} chars AND adds this entry — the limit is checked only on the batch result.`,
      deficit,
      used,
      limit,
      currentEntries: current,
      applied,
    }
  }

  for (const entry of current) {
    const scan = scanEntry(entry)
    if (!scan.ok) {
      return { ok: false, reason: 'threat', detail: `Entry rejected: ${scan.issues.join(', ')}.`, currentEntries: current, applied }
    }
  }

  return { ok: true, entries: current, applied, chars: used, limit }
}

/** Read one store's entries. Returns { entries, raw, readFailed }. */
async function readStore (dir, store) {
  const raw = await readFileSafe(storeFile(dir, store))
  if (raw === undefined) {
    // Distinguish "new store" from "unreadable file": treating an unreadable
    // store as empty and saving would wipe existing memory.
    const existsProbe = await readFileSafe(storeFile(dir, store))
    if (existsProbe === undefined) return { entries: [], raw: '', readFailed: false }
  }
  return { entries: parseEntries(raw), raw, readFailed: false }
}

/**
 * Render the full memory context for prompt injection: the global stores plus
 * the optional per-cwd workspace layer.
 */
function renderMemoryContext (stores, { lang = 'zh' } = {}) {
  const blocks = []
  for (const { store, entries, limit, label } of stores) {
    if (!entries || entries.length === 0) continue
    const block = renderBlock(store, entries, limit)
    if (block === undefined) continue
    blocks.push(label === undefined ? block : `${label}\n${block}`)
  }
  return blocks.join('\n\n')
}

/**
 * Write a memory change to disk. `dir` selects the global or workspace layer.
 * Returns a structured outcome — callers never throw on a rejected write.
 */
async function writeMemory (dir, store, operations, { limit, header } = {}) {
  const { entries, readFailed } = await readStore(dir, store)
  if (readFailed) {
    return { ok: false, reason: 'read-failed', detail: 'The memory file could not be read. Refusing to overwrite it.' }
  }
  const plan = applyOperations(entries, operations, { limit })
  if (!plan.ok) return { ...plan, ok: false }
  await atomicWrite(storeFile(dir, store), serializeEntries(plan.entries))
  if (header !== undefined) {
    // The workspace layer writes its cwd header as an HTML comment so a human
    // reading the file (and the panel) can tell which project it belongs to.
    const current = await readFileSafe(storeFile(dir, store)) || ''
    if (!current.includes(header)) {
      await atomicWrite(storeFile(dir, store), `${header}\n${current}`)
    }
  }
  return { ok: true, entries: plan.entries, chars: plan.chars, limit }
}

module.exports = {
  ENTRY_DELIMITER,
  SEP,
  STORES,
  STORE_KIND,
  HEADERS,
  storeFile,
  parseEntries,
  serializeEntries,
  charsOf,
  normalizeForMatch,
  findEntry,
  scanEntry,
  renderBlock,
  renderSnapshotEntry,
  applyOne,
  applyOperations,
  readStore,
  writeMemory,
  renderMemoryContext,
  workspaceCwdHeader,
}