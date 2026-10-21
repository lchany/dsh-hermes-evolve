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
  // Hermes truncates (int()), it does not round: 14/2200 is 0%, not 1%.
  const pct = Math.min(100, Math.floor((used / limit) * 100))
  const shown = blockedInSnapshot ? entries.map(renderSnapshotEntry) : entries
  return [
    SEP,
    `${HEADERS[store]} [${pct}% — ${used.toLocaleString('en-US')}/${limit.toLocaleString('en-US')} chars]`,
    SEP,
    serializeEntries(shown),
  ].join('\n')
}

// ── write planning ─────────────────────────────────────────────────────────

const OP_KINDS = ['add', 'patch', 'remove']

// Hermes memory_tool.py: the model-facing action model is add/patch/remove. `replace`
// was removed when `patch` arrived; existing staged records that say replace still
// replay (skill_tools), but a new call is refused with this text.
const REPLACE_REMOVED = "'replace' is not available; use 'patch'. old_text is the exact span to change and content is its new text; the rest of the entry is kept. To rewrite a whole entry, set old_text to the whole entry. Nothing was written."
const PATCH_DROP_HINT = "To drop text inside an entry, patch a longer span that contains it; 'remove' deletes the whole entry."

/** Occurrences of a span, overlapping ones included: '00' occurs twice in '1000'. */
function spanOccurrences (text, span) {
  if (span === '') return 0
  let count = 0
  for (let i = 0; i + span.length <= text.length; i++) if (text.startsWith(span, i)) count++
  return count
}

/** Hermes `_repeated_span_message`. */
function repeatedSpanMessage (oldText, count) {
  return `'${oldText}' appears ${count} times in the matched entry, and patch edits one span. ` +
    'Include more surrounding text so old_text occurs once.'
}

/**
 * Hermes `_patch_entry`: splice exactly one span and keep the rest of the entry
 * verbatim. A span that occurs more than once is refused rather than edited
 * everywhere; a no-op edit and a poisoned result are refused too.
 */
function patchEntry (entry, oldText, newText) {
  const count = spanOccurrences(entry, oldText)
  if (count > 1) return { ok: false, reason: 'ambiguous', detail: repeatedSpanMessage(oldText, count) }
  const patched = entry.replace(oldText, newText)
  if (patched === entry) {
    return {
      ok: false,
      reason: 'invalid-args',
      detail: `Patch is a no-op: '${oldText}' -> '${newText}' leaves the entry unchanged.`,
    }
  }
  const scan = scanEntry(patched)
  if (!scan.ok) return { ok: false, reason: 'threat', detail: `Entry rejected: ${scan.issues.join(', ')}.` }
  return { ok: true, entry: patched }
}

/** Hermes `_no_match_error`: name the entries sharing the most words with old_text. */
function noMatchMessage (entries, oldText, verb) {
  const words = new Set(String(oldText || '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [])
  const closeness = []
  if (words.size > 0) {
    entries.forEach((entry, index) => {
      const candidate = new Set(String(entry).toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [])
      let shared = 0
      for (const word of words) if (candidate.has(word)) shared++
      const score = shared / words.size
      if (score >= 0.3) closeness.push({ score, index, entry })
    })
    closeness.sort((a, b) => b.score - a.score || a.index - b.index)
  }
  const closest = closeness.slice(0, 3).map((item) => item.entry)
  const hint = String(oldText || '').includes('§')
    ? " old_text must come from ONE entry ('§' separates entries); use one op per entry."
    : ''
  return {
    detail: `No entry matched '${oldText}'.${hint} Retry the ${verb} with old_text copied verbatim ` +
      `from the intended entry${closest.length > 0 ? ' (closest_entries below).' : '.'}`,
    closestEntries: closest,
  }
}

/**
 * Apply ONE op to an entry list, returning a plan (no I/O).
 * Single-op shape uses the tool-level wording (memory_tool.py `_validate_single_op`);
 * `position` switches to the batch wording ("Operation 2 (patch): …").
 */
function applyOne (entries, op, { position = null } = {}) {
  const kind = String(op.action || '')
  const batch = position !== null
  const pos = batch ? `${position}: ` : ''
  // 'replace' is no longer offered to the model; a staged record created before
  // its removal still replays here (memory_tool.py keeps it in _STORE_ACTIONS).
  if (!OP_KINDS.includes(kind) && kind !== 'replace') {
    return {
      ok: false,
      reason: 'bad-action',
      detail: batch ? `${pos}unknown action. Use add, patch, or remove.` : `Unknown action '${kind}'. Use: add, patch, remove`,
    }
  }

  if (kind === 'add') {
    const text = normalizeEntry(op.text)
    if (text === '') {
      return { ok: false, reason: 'no-content', detail: batch ? `${pos}content is required.` : "Content is required for 'add' action." }
    }
    if (entries.some((e) => normalizeEntry(e) === text)) {
      // Exact duplicates are a no-op, not a failure (Hermes dedups on load too).
      return { ok: true, entries, noop: true, detail: 'Entry already exists (no duplicate added).' }
    }
    return { ok: true, entries: [...entries, text] }
  }

  const oldRaw = op.oldText === undefined || op.oldText === null ? '' : String(op.oldText)
  if (oldRaw.trim() === '') {
    return {
      ok: false,
      reason: 'missing-old-text',
      detail: batch
        ? `${pos}old_text is required.`
        : `'${kind}' needs old_text -- a short unique substring of the entry to ${kind}. None was provided. ` +
          `Reissue the ${kind} with old_text set to part of one of the current_entries below.`,
    }
  }
  if (kind === 'patch') {
    const newText = op.text
    if (newText === undefined || newText === null || String(newText).trim() === '') {
      return {
        ok: false,
        reason: 'no-content',
        detail: batch
          ? `${pos}content is required — set this operation object's own 'content' to the new text for the old_text span. ${PATCH_DROP_HINT}`
          : `content (the new text for the old_text span) is required for 'patch' action. ${PATCH_DROP_HINT}`,
      }
    }
  }

  if (kind === 'replace') {
    // Legacy replay: apply to the pinned entry when one was stored, exactly like
    // memory_tool.py `store.replace(target, old_text, content, entry=matched_entry)`.
    if (String(op.text || '').trim() === '') {
      return { ok: false, reason: 'no-content', detail: batch ? `${pos}content is required.` : "Content is required for 'replace' action." }
    }
    let index = typeof op.matched_entry === 'string' ? entries.indexOf(op.matched_entry) : -1
    if (index < 0) {
      const located = findEntry(entries, oldRaw)
      if (located.error === 'no-match') {
        const miss = noMatchMessage(entries, oldRaw, 'replace')
        return { ok: false, reason: 'no-match', detail: batch ? `${pos}${miss.detail}` : miss.detail, closestEntries: miss.closestEntries }
      }
      if (located.error === 'ambiguous') {
        return {
          ok: false,
          reason: 'ambiguous',
          detail: batch ? `${pos}'${oldRaw}' matched multiple distinct entries -- be more specific.` : `Multiple entries matched '${oldRaw}'. Be more specific.`,
          candidates: located.candidates,
        }
      }
      index = located.index
    }
    const next = entries.slice()
    const previous = next[index]
    next[index] = normalizeEntry(op.text)
    return { ok: true, entries: next, previous }
  }

  const found = findEntry(entries, oldRaw)
  if (found.error === 'no-match') {
    const miss = noMatchMessage(entries, oldRaw, kind)
    return { ok: false, reason: 'no-match', detail: batch ? `${pos}${miss.detail}` : miss.detail, closestEntries: miss.closestEntries }
  }
  if (found.error === 'ambiguous') {
    const matches = found.candidates.map((entry) => (entry.length > 80 ? `${entry.slice(0, 80)}...` : entry))
    return {
      ok: false,
      reason: 'ambiguous',
      detail: batch
        ? `${pos}'${oldRaw}' matched multiple distinct entries -- be more specific.`
        : `Multiple entries matched '${oldRaw}'. Be more specific.`,
      candidates: batch ? matches : found.candidates,
      matches,
    }
  }

  if (kind === 'remove') {
    const next = entries.filter((_, i) => i !== found.index)
    return { ok: true, entries: next, removed: entries[found.index] }
  }

  // patch: the span keeps its whitespace — it is part of the text being replaced.
  const result = patchEntry(entries[found.index], oldRaw, String(op.text))
  if (result.ok !== true) return { ...result, detail: batch ? `${pos}${result.detail}` : result.detail }
  const next = entries.slice()
  const previous = next[found.index]
  next[found.index] = result.entry
  return { ok: true, entries: next, previous, patched: result.entry }
}

/**
 * Apply a batch. The limit is checked on the FINAL state only — that is what
 * makes "free 153 chars by shortening one entry, then add" possible in one call.
 * `batch` distinguishes `operations` (atomic, pos-labelled, cannot empty the store)
 * from the bare single-op shape (one store call, allowed to delete the last entry).
 */
function applyOperations (entries, operations, { limit, batch = operations.length > 1, label = 'the store' } = {}) {
  let current = entries.slice()
  const applied = []
  const suffix = batch ? ' No operations were applied (batch is all-or-nothing).' : ''
  const fail = (detail, extra) => ({ ok: false, ...extra, detail: `${detail}${suffix}`, current, applied, currentEntries: current })

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i]
    const position = batch ? `Operation ${i + 1} (${String(op.action || 'unknown') || 'unknown'})` : null
    const result = applyOne(current, op, { position })
    if (!result.ok) return fail(result.detail, result)
    current = result.entries
    applied.push({
      ...op,
      noop: result.noop === true,
      previous: result.previous,
      removed: result.removed,
      patched: result.patched,
    })
  }

  // A batch that removes every entry is far more likely to be a matching accident
  // than an intent; hermes' single remove() is the deliberate-wipe path (#103419).
  if (batch && entries.length > 0 && current.length === 0) {
    return fail(`Refusing to empty ${label}: this batch would remove every entry from a previously non-empty store. ` +
      'Keep at least one entry — merge overlapping entries into a shorter one instead of removing the last one. ' +
      'To delete the final entry deliberately, use single remove() calls.', { reason: 'would-empty' })
  }

  const used = charsOf(current)
  if (used > limit) {
    const deficit = used - limit
    const usedText = used.toLocaleString('en-US')
    const limitText = limit.toLocaleString('en-US')
    const deficitText = deficit.toLocaleString('en-US')
    const singleKind = batch ? null : String((operations[0] || {}).action || '')
    let detail
    if (batch) {
      detail = `Applying all ${operations.length} operations would put memory at ${usedText}/${limitText} chars: ` +
        `free at least ${deficitText} chars more. Add removes or shortening patches of other stale entries to the same batch, then retry.`
    } else if (singleKind === 'add') {
      const added = String((applied[0] && applied[0].text) || '').trim().length
      detail = `Memory at ${usedText}/${limitText} chars; adding this entry (${added.toLocaleString('en-US')} chars) ` +
        `would exceed the limit by ${deficitText} chars. Retry as ONE 'operations' batch that removes or shortens (patch) ` +
        'stale entries from current_entries below to free at least ' +
        `${deficitText} chars AND adds this entry — the limit is checked only on the batch result.`
    } else {
      // patch: the replacement already landed in `current`; hermes words this per-shape.
      detail = `Patch would put memory at ${usedText}/${limitText} chars. Shorten the new text, or 'remove' other ` +
        'stale or less important entries to make room (see current_entries below), then retry — all in this turn.'
    }
    return fail(detail, { reason: 'over-limit', deficit, used, limit })
  }

  for (const entry of current) {
    const scan = scanEntry(entry)
    if (!scan.ok) {
      return fail(`Entry rejected: ${scan.issues.join(', ')}.`, { reason: 'threat' })
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
async function writeMemory (dir, store, operations, { limit, header, batch = operations.length > 1 } = {}) {
  const { entries, readFailed } = await readStore(dir, store)
  if (readFailed) {
    return { ok: false, reason: 'read-failed', detail: 'The memory file could not be read. Refusing to overwrite it.' }
  }
  const plan = applyOperations(entries, operations, {
    limit,
    batch,
    label: store === 'user' ? 'USER.md' : 'MEMORY.md',
  })
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
  return { ok: true, entries: plan.entries, applied: plan.applied, chars: plan.chars, limit }
}

module.exports = {
  ENTRY_DELIMITER,
  SEP,
  STORES,
  STORE_KIND,
  HEADERS,
  REPLACE_REMOVED,
  PATCH_DROP_HINT,
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