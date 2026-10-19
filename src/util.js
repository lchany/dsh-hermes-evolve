'use strict'

const { createHash, randomUUID } = require('node:crypto')
const fsP = require('node:fs/promises')
const { join, resolve, sep } = require('node:path')
const { homedir } = require('node:os')

const PLUGIN = 'hermes-evolve'

// ── paths ──────────────────────────────────────────────────────────────────

function dshHome () {
  return process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
}

/** Where the plugin keeps its own state: memory, pending, backups, ledger. */
function storeDir () {
  return join(dshHome(), PLUGIN)
}

/** The user skill library DSH reads. Same layout the skills service scans. */
function skillsDir () {
  return join(dshHome(), 'skills')
}

/**
 * Hermes-faithful location: `$HERMES_HOME/memories` -> `$DSH_HOME/memories`.
 * DSH_HOME is the profile root, the structural analogue of HERMES_HOME, so the
 * files live where a hermes user would look for them (and where the panel can
 * point a human at them).
 */
function memoryDir () {
  return join(dshHome(), 'memories')
}

function pendingDir () {
  return join(storeDir(), 'pending')
}

function backupsDir () {
  return join(skillsDir(), '.curator_backups')
}

function archiveDir () {
  return join(skillsDir(), '.archive')
}

function ledgerPath () {
  return join(skillsDir(), '.curator_ledger.jsonl')
}

function stateDir () {
  return join(storeDir(), 'state')
}

/** Hermes keeps curator scheduling state inside the skills tree. */
function curatorStatePath () {
  return join(skillsDir(), '.curator_state')
}

/** Sidecar usage records, keyed by skill name (never frontmatter). */
function usagePath () {
  return join(skillsDir(), '.usage.json')
}

/**
 * Workspace memory. The cwd string is the authoritative input — we never walk
 * up looking for a project root (that is unstable across checkouts). The slug
 * is lossy (every separator becomes '-'), so the file carries a `<!-- cwd: -->`
 * header describing itself.
 */
const WORKSPACE_SLUG_MAX = 128

function workspaceSlug (cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return undefined
  const slug = cwd.replace(/[/\\:]/g, '-')
  if (slug.length <= WORKSPACE_SLUG_MAX) return slug
  return slug.slice(0, WORKSPACE_SLUG_MAX - 9) + '-' + sha256(cwd).slice(0, 8)
}

function workspaceMemoryDir (cwd) {
  const slug = workspaceSlug(cwd)
  return slug === undefined ? undefined : join(memoryDir(), 'workspaces', slug)
}

const workspaceCwdHeader = (cwd) => `<!-- cwd: ${cwd} -->`

function workspaceCwdOf (raw) {
  const m = String(raw || '').match(/^<!-- cwd: (.+) -->$/m)
  return m === null ? undefined : m[1].trim()
}

// ── fs helpers ─────────────────────────────────────────────────────────────

async function readFileSafe (file) {
  try {
    return await fsP.readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

async function ensureDir (dir) {
  await fsP.mkdir(dir, { recursive: true })
}

/**
 * Write through a temp file in the same directory + rename. A reader never
 * observes a half-written file, and a crash leaves no truncated SKILL.md.
 */
async function atomicWrite (targetFile, content) {
  await ensureDir(join(targetFile, '..'))
  const temp = join(join(targetFile, '..'), `.${randomUUID()}.tmp`)
  await fsP.writeFile(temp, content, 'utf8')
  await fsP.rename(temp, targetFile)
}

async function atomicWriteJson (targetFile, value) {
  await atomicWrite(targetFile, JSON.stringify(value, null, 2) + '\n')
}

async function exists (file) {
  try {
    await fsP.access(file)
    return true
  } catch {
    return false
  }
}

async function listDir (dir) {
  try {
    return await fsP.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function rmrf (target) {
  await fsP.rm(target, { recursive: true, force: true })
}

/** True when `child` resolves inside `parent` (both absolute). */
function isInside (parent, child) {
  const p = resolve(parent)
  const c = resolve(child)
  return c === p || c.startsWith(p + sep)
}

// ── text helpers ───────────────────────────────────────────────────────────

function sha256 (text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/** `turn/end` reason arrives as `{kind:'completed'}`; tolerate a bare string. */
function reasonKind (reason) {
  if (reason === null || reason === undefined) return undefined
  if (typeof reason === 'string') return reason
  if (typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind
  return undefined
}

/** Best-effort text extraction from an LLM message content field. */
function contentToText (content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    if (content && typeof content === 'object' && typeof content.text === 'string') return content.text
    return ''
  }
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if ((block.type === 'tool_call' || block.type === 'tool_use') && block.name) parts.push(`[tool ${block.name}]`)
  }
  return parts.join('\n')
}

/** First fenced ```json (or bare ```) block, else the first {...} span. */
function extractFencedJson (text) {
  const raw = String(text || '')
  const fence = raw.match(/```(?:json|yaml|yml)?\s*\n([\s\S]*?)```/)
  if (fence) return fence[1].trim()
  const braced = raw.match(/[{[][\s\S]*[}\]]/)
  return braced ? braced[0].trim() : raw.trim()
}

function tryParseJson (text) {
  const candidate = extractFencedJson(text)
  try {
    return JSON.parse(candidate)
  } catch { /* fall through to the brace scan */ }
  // Some models emit prose before the object and a trailing fence after it.
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch { /* unparseable */ }
  }
  return undefined
}

/** Normalize whitespace so two renderings of the same entry compare equal. */
function normalizeEntry (text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

// ── frontmatter ────────────────────────────────────────────────────────────

/** Render SKILL.md: YAML frontmatter (name/description) + body. */
function buildSkillMd (name, description, body) {
  const yaml = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(String(description || '').replace(/\r?\n/g, ' '))}\n---`
  return `${yaml}\n\n${String(body || '').trim()}\n`
}

/**
 * Patch the frontmatter's name/description and replace the body, keeping any
 * extra frontmatter keys (model-invocation flags, license, metadata) the user
 * or another tool added.
 */
function mergeFrontmatter (existingContent, name, description, newBody) {
  const raw = String(existingContent || '')
  const lines = raw.split(/\r?\n/)
  let kept = []
  let body = raw
  if (lines[0] !== undefined && lines[0].trim() === '---') {
    const closer = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
    if (closer > 0) {
      kept = lines.slice(1, closer).filter((l) => !/^(name|description)\s*:/.test(l.trim()))
      body = lines.slice(closer + 1).join('\n')
    }
  }
  const desc = typeof description === 'string' && description !== ''
    ? description
    : (descriptionOf(raw) || '')
  const yaml = [
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(desc.replace(/\r?\n/g, ' '))}`,
    ...kept,
  ].join('\n')
  const finalBody = typeof newBody === 'string' && newBody.trim() !== '' ? newBody : body
  return `---\n${yaml}\n---\n\n${String(finalBody || '').trim()}\n`
}

function descriptionOf (skillMdContent) {
  const match = String(skillMdContent || '').match(/^description:\s*(.+)$/m)
  if (!match) return undefined
  let value = match[1].trim()
  if (value.startsWith('"') || value.startsWith("'")) {
    try {
      value = JSON.parse(value.startsWith("'") ? '"' + value.slice(1, -1) + '"' : value)
    } catch {
      value = value.replace(/^["']|["']$/g, '')
    }
  }
  return value
}

function nameOf (skillMdContent) {
  const match = String(skillMdContent || '').match(/^name:\s*(.+)$/m)
  return match === null ? undefined : match[1].trim().replace(/^["']|["']$/g, '')
}

/** Body without frontmatter — what a skill_view call returns. */
function stripFrontmatter (raw) {
  const text = String(raw || '')
  const lines = text.split(/\r?\n/)
  if (lines[0] === undefined || lines[0].trim() !== '---') return text
  const closer = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (closer < 0) return text
  return lines.slice(closer + 1).join('\n').replace(/^\n+/, '')
}

// ── misc ───────────────────────────────────────────────────────────────────

/** kebab-case class-level skill name. */
const KEBAB_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function truncate (text, max) {
  const s = String(text || '')
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…'
}

function isoNow (now = Date.now()) {
  return new Date(now).toISOString()
}

/** ISO timestamp for a backup id, filename-safe (Windows has no ':' in names). */
function isoFileStamp (now = Date.now()) {
  return isoNow(now).replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z')
}

module.exports = {
  PLUGIN,
  dshHome,
  storeDir,
  skillsDir,
  memoryDir,
  pendingDir,
  backupsDir,
  archiveDir,
  ledgerPath,
  stateDir,
  curatorStatePath,
  usagePath,
  workspaceSlug,
  workspaceMemoryDir,
  workspaceCwdHeader,
  workspaceCwdOf,
  readFileSafe,
  ensureDir,
  atomicWrite,
  atomicWriteJson,
  exists,
  listDir,
  rmrf,
  isInside,
  sha256,
  reasonKind,
  contentToText,
  extractFencedJson,
  tryParseJson,
  normalizeEntry,
  buildSkillMd,
  mergeFrontmatter,
  descriptionOf,
  nameOf,
  stripFrontmatter,
  KEBAB_NAME_RE,
  truncate,
  isoNow,
  isoFileStamp,
}