'use strict'

/**
 * The skill store — a faithful port of the parts of hermes `tools/skill_manager_tool.py`,
 * `tools/skills_tool.py`, `tools/skill_usage.py` and `tools/curator_backup.py` that
 * define where a skill lives, what a write is allowed to touch, and how a removal
 * becomes an archive instead of a delete.
 *
 * Layout (identical to hermes, rooted at DSH_HOME):
 *
 *   $DSH_HOME/skills/<name>/SKILL.md            the library (DSH's own scanner reads this)
 *   $DSH_HOME/skills/<category>/<name>/SKILL.md optional nesting
 *   $DSH_HOME/skills/.archive/<name>/           archived packages (recoverable)
 *   $DSH_HOME/skills/.usage.json                usage sidecar (see skill_usage.js)
 *   $DSH_HOME/skills/.curator_state             curator scheduling state
 *   $DSH_HOME/skills/.curator_backups/          tar.gz snapshots
 *   $DSH_HOME/skills/.curator_ledger.jsonl      before/after ledger
 */

const fsP = require('node:fs/promises')
const { join, dirname, relative, sep, isAbsolute, normalize } = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const execFileP = promisify(execFile)

const {
  skillsDir, archiveDir, backupsDir, ledgerPath, pendingDir, ensureDir,
  readFileSafe, atomicWrite, atomicWriteJson, exists, listDir, sha256, isoNow, isoFileStamp,
  stripFrontmatter, nameOf, descriptionOf, KEBAB_NAME_RE, truncate,
} = require('./util')

const EXCLUDED_DIRS = new Set(['.archive', '.curator_backups', '.hub', '.locks', '.git', 'node_modules', '.curator_suppressed'])
const SUPPORT_ROOTS = ['references', 'templates', 'scripts', 'assets']
const NAME_MAX = 64
const DESCRIPTION_MAX = 1024
const BODY_MAX_CHARS = 128 * 1024
const SUPPORT_FILE_MAX_CHARS = 64 * 1024

// ── scanning ───────────────────────────────────────────────────────────────

/** Parse the YAML frontmatter Hermes skills use. Deliberately a subset: top-level
 *  `key: value` scalars plus indented/`-` nested blocks serialized back as JSON
 *  strings, which round-trips through `mergeFrontmatter`. */
function parseFrontmatter (raw) {
  const text = String(raw || '')
  const lines = text.split(/\r?\n/)
  if (lines[0] === undefined || lines[0].trim() !== '---') return { frontmatter: {}, body: text }
  const closer = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (closer < 0) return { frontmatter: {}, body: text }
  const block = lines.slice(1, closer)
  const body = lines.slice(closer + 1).join('\n').replace(/^\n+/, '')
  const frontmatter = {}
  let currentKey = null
  for (const line of block) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    const top = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/)
    if (top !== null) {
      const [, key, rest] = top
      let value = rest.trim()
      if (value === '') {
        currentKey = key
        frontmatter[key] = {}
        continue
      }
      currentKey = null
      frontmatter[key] = unquote(value)
      continue
    }
    const nested = line.match(/^\s+([A-Za-z0-9_.-]+):\s*(.*)$/)
    if (nested !== null && currentKey !== null && typeof frontmatter[currentKey] === 'object') {
      frontmatter[currentKey][nested[1]] = unquote(nested[2].trim())
      continue
    }
    if (/^\s*-/.test(line) && currentKey !== null) {
      const item = unquote(line.replace(/^\s*-\s*/, '').trim())
      if (!Array.isArray(frontmatter[currentKey])) frontmatter[currentKey] = []
      frontmatter[currentKey].push(item)
    }
  }
  return { frontmatter, body }
}

function unquote (value) {
  if (value === undefined) return ''
  const text = String(value)
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text) } catch { return text.slice(1, -1) }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1)
  return text
}

function serializeFrontmatter (frontmatter) {
  const lines = []
  for (const [key, value] of Object.entries(frontmatter || {})) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      lines.push(`${key}:`)
      for (const item of value) lines.push(`  - ${JSON.stringify(String(item))}`)
    } else if (typeof value === 'object') {
      lines.push(`${key}:`)
      for (const [k, v] of Object.entries(value)) lines.push(`  ${k}: ${JSON.stringify(String(v))}`)
    } else {
      lines.push(`${key}: ${JSON.stringify(String(value))}`)
    }
  }
  return lines.join('\n')
}

function composeSkillMd (frontmatter, body) {
  const head = serializeFrontmatter(frontmatter)
  return `---\n${head}\n---\n\n${String(body || '').trim()}\n`
}

async function walkSkillDirs (root, found = [], depth = 0) {
  if (depth > 6) return found
  const entries = await listDir(root)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (EXCLUDED_DIRS.has(entry.name)) continue
    if (entry.name.startsWith('.') && entry.name !== '.archive') continue
    const dir = join(root, entry.name)
    const mdPath = join(dir, 'SKILL.md')
    if (await exists(mdPath)) {
      found.push({ dir, mdPath })
      // A skill package does not nest further skill packages in hermes; stop here.
      continue
    }
    await walkSkillDirs(dir, found, depth + 1)
  }
  return found
}

function categoryOf (dir) {
  const rel = relative(skillsDir(), dir)
  const parts = rel.split(sep)
  return parts.length > 1 ? parts[0] : undefined
}

/** Every skill on disk, resolved to its frontmatter name. */
async function scanSkills () {
  const root = skillsDir()
  if (!(await exists(root))) return []
  const dirs = await walkSkillDirs(root)
  const out = []
  for (const { dir, mdPath } of dirs) {
    const raw = await readFileSafe(mdPath)
    if (raw === undefined) continue
    const { frontmatter, body } = parseFrontmatter(raw)
    const declared = typeof frontmatter.name === 'string' && frontmatter.name.trim() !== ''
      ? frontmatter.name.trim()
      : dir.split(sep).pop()
    const description = typeof frontmatter.description === 'string' && frontmatter.description.trim() !== ''
      ? frontmatter.description.trim()
      : firstBodyLine(body)
    out.push({
      name: declared.slice(0, NAME_MAX),
      description: truncate(description || '', DESCRIPTION_MAX),
      category: categoryOf(dir),
      dir,
      mdPath,
      relPath: relative(root, mdPath).split(sep).join('/'),
      body,
      frontmatter,
      content: raw,
    })
  }
  out.sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name))
  return out
}

function firstBodyLine (body) {
  return String(body || '').split('\n').map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('#')) || ''
}

/** Locate a skill by frontmatter name, directory name, or relative path. */
async function findSkill (nameOrPath) {
  const wanted = String(nameOrPath || '').trim()
  if (wanted === '') return undefined
  const all = await scanSkills()
  const flat = wanted.split('/').filter(Boolean)
  const bare = flat[flat.length - 1]
  return all.find((s) => s.name === wanted)
    || all.find((s) => s.relPath === wanted || s.relPath === `${wanted}/SKILL.md`)
    || all.find((s) => s.dir.split(sep).pop() === wanted)
    || all.find((s) => s.name === bare)
}

async function listLinkedFiles (dir) {
  const out = {}
  for (const root of SUPPORT_ROOTS) {
    const base = join(dir, root)
    if (!(await exists(base))) continue
    const files = []
    const walk = async (current, prefix) => {
      for (const entry of await listDir(current)) {
        const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        if (entry.isDirectory()) await walk(join(current, entry.name), rel)
        else files.push(rel)
      }
    }
    await walk(base, '')
    if (files.length > 0) out[root] = files.sort()
  }
  return out
}

// ── validation ─────────────────────────────────────────────────────────────

function validateName (name) {
  const text = String(name || '').trim()
  if (text === '') return 'Skill name is required.'
  if (text.length > NAME_MAX) return `Skill name must be at most ${NAME_MAX} characters (got ${text.length}).`
  if (!KEBAB_NAME_RE.test(text)) {
    return `Invalid skill name '${text}'. Use lowercase letters, digits and hyphens (e.g. 'pdf-toolkit').`
  }
  return undefined
}

function validateDescription (description) {
  const text = String(description || '').replace(/\r?\n/g, ' ').trim()
  if (text === '') return 'Skill description is required: make the first 57 characters a self-contained trigger.'
  if (text.length > DESCRIPTION_MAX) return `Skill description must be at most ${DESCRIPTION_MAX} characters (got ${text.length}).`
  return undefined
}

/**
 * Validate a SKILL.md an agent wants to create. The frontmatter is the contract
 * the DSH skill scanner relies on, so a body-only file is refused rather than
 * written into a shape nothing can load.
 */
function validateSkillMd (content, expectedName) {
  const text = String(content || '')
  if (text.trim() === '') return 'SKILL.md content is required.'
  const { frontmatter, body } = parseFrontmatter(text)
  const nameError = validateName(frontmatter.name)
  if (nameError !== undefined) return `SKILL.md frontmatter: ${nameError}`
  if (frontmatter.name.trim() !== expectedName) {
    return `SKILL.md frontmatter name '${frontmatter.name}' does not match the requested skill '${expectedName}'.`
  }
  const descriptionError = validateDescription(frontmatter.description)
  if (descriptionError !== undefined) return `SKILL.md frontmatter: ${descriptionError}`
  if (body.trim() === '') return 'SKILL.md body is required (the whole point of a skill is reusable procedure).'
  if (text.length > BODY_MAX_CHARS) return `SKILL.md is ${text.length} chars, over the ${BODY_MAX_CHARS}-char budget. Split depth into references/.`
  return undefined
}

function validateRelativeSupportPath (filePath) {
  const text = String(filePath || '').trim()
  if (text === '') return 'file_path is required.'
  if (isAbsolute(text)) return 'file_path must be RELATIVE to the skill directory (no leading slash).'
  const normalized = normalize(text).split(sep).join('/')
  if (normalized.startsWith('..')) return "file_path must stay inside the skill directory (no '..')."
  const root = normalized.split('/')[0]
  if (!SUPPORT_ROOTS.includes(root)) {
    return `file_path must start with one of: ${SUPPORT_ROOTS.map((r) => `${r}/`).join(', ')} (got '${normalized}').`
  }
  if (normalized === `${root}/`) return 'file_path must name a file inside the supporting directory.'
  return undefined
}

function supportPathOf (dir, filePath) {
  return join(dir, normalize(String(filePath)).split(sep).join(sep))
}

// ── read-before-write marks ────────────────────────────────────────────────

/**
 * Hermes refuses a patch whose target was not loaded in THIS review turn.
 * The mark lives in a per-review object handed to the tool handlers, so one
 * review's reads never authorize the next review's writes.
 */
function makeReadMarks () {
  return new Set()
}

function markRead (marks, file) {
  if (marks && typeof file === 'string') marks.add(file)
}

function hasRead (marks, file) {
  return marks instanceof Set && marks.has(file)
}

const READ_BEFORE_WRITE_MESSAGE = (fileLabel) =>
  `Refusing to write ${fileLabel}: the current content has not been loaded in this review turn. `
  + 'Call skill_view(name) for SKILL.md, or skill_view(name, file_path=...) for a supporting file, '
  + 'then retry the write using the content just returned. (Content quoted earlier in the conversation does not count.)'

// ── ledger ─────────────────────────────────────────────────────────────────

const LEDGER_MAX_BYTES = 4 * 1024 * 1024

async function blobPath (digest) {
  return join(backupsDir(), 'blobs', `${digest}.txt`)
}

async function captureBlob (content) {
  const digest = sha256(String(content || ''))
  const path = await blobPath(digest)
  if (!(await exists(path))) {
    await ensureDir(dirname(path))
    await atomicWrite(path, String(content || ''))
  }
  return digest
}

/**
 * Record one mutation. Hermes' ledger is telemetry, not a gate: a failure to
 * write it never blocks a skill write. It exists so `curator rollback` has a
 * machine-readable trail of what each pass changed.
 */
async function ledgerAppend (entry) {
  try {
    const path = ledgerPath()
    await ensureDir(dirname(path))
    const record = { at: isoNow(), actor: 'curator', ...entry }
    const line = `${JSON.stringify(record)}\n`
    const prior = (await readFileSafe(path)) || ''
    let next = prior + line
    if (next.length > LEDGER_MAX_BYTES) {
      // Keep the tail; a 4MB ledger is already far past useful.
      const lines = next.split('\n')
      next = lines.slice(Math.floor(lines.length / 2)).join('\n')
    }
    await atomicWrite(path, next)
    return true
  } catch {
    return false
  }
}

async function captureBefore (skill, completePackage) {
  if (skill === undefined || skill === null) return undefined
  try {
    const files = {}
    const walk = async (dir, prefix) => {
      for (const entry of await listDir(dir)) {
        const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        if (entry.isDirectory()) {
          if (EXCLUDED_DIRS.has(entry.name)) continue
          await walk(join(dir, entry.name), rel)
        } else {
          const raw = await readFileSafe(join(dir, entry.name))
          if (raw !== undefined) files[rel] = await captureBlob(raw)
        }
      }
    }
    await walk(skill.dir, '')
    return { skill: skill.name, dir: skill.dir, complete_package: completePackage === true, files }
  } catch {
    return undefined
  }
}

// ── backups ────────────────────────────────────────────────────────────────

const BACKUP_KEEP = 2
const TRANSIENT_DIRS = ['node_modules', '.venv', 'venv', '__pycache__', '.git', '.mypy_cache', '.pytest_cache']

/**
 * Snapshot the skills tree with tar. `tar` is used rather than a JS archive
 * writer so the artifact stays a plain `skills.tar.gz` a human can inspect
 * (hermes uses Python's tarfile and the same layout).
 */
async function createBackup ({ keep = BACKUP_KEEP } = {}) {
  const root = skillsDir()
  if (!(await exists(root))) return undefined
  const stamp = isoFileStamp()
  let id = stamp
  const base = backupsDir()
  if (await exists(join(base, id))) id = `${stamp}-02`
  const dest = join(base, id)
  await ensureDir(dest)
  const archive = join(dest, 'skills.tar.gz')
  const excludes = ['.curator_backups', '.hub', '.locks', '.git', '.archive', '.curator_ledger.jsonl', ...TRANSIENT_DIRS]
  const args = ['-czf', archive, '-C', root]
  for (const item of excludes) args.push(`--exclude=${item}`)
  args.push('.')
  try {
    await execFileP('tar', args, { maxBuffer: 32 * 1024 * 1024 })
  } catch (error) {
    await ledgerAppend({ action: 'backup-failed', id, error: String(error && error.message) })
    return undefined
  }
  const manifest = { id, created_at: isoNow(), keep, files: excludes }
  await atomicWriteJson(join(dest, 'manifest.json'), manifest)
  await pruneBackups(keep, id)
  return { id, path: archive }
}

async function listBackups () {
  const base = backupsDir()
  if (!(await exists(base))) return []
  const out = []
  for (const entry of await listDir(base)) {
    if (!entry.isDirectory() || entry.name === 'blobs') continue
    const archive = join(base, entry.name, 'skills.tar.gz')
    if (await exists(archive)) out.push({ id: entry.name, path: archive })
  }
  out.sort((a, b) => b.id.localeCompare(a.id))
  return out
}

async function pruneBackups (keep, justCreated) {
  const all = await listBackups()
  const stale = all.slice(Math.max(keep, 1)).filter((b) => b.id !== justCreated)
  for (const item of stale) {
    try {
      await fsP.rm(join(backupsDir(), item.id), { recursive: true, force: true })
    } catch { /* telemetry-only */ }
  }
}

/** Extract one backup over the skills tree. Refuses absolute/`..` members, because
 *  a tar entry escaping the root is how a restore turns into a data-loss event. */
async function restoreBackup (id) {
  const dir = join(backupsDir(), id)
  const archive = join(dir, 'skills.tar.gz')
  if (!(await exists(archive))) return { ok: false, error: `backup '${id}' not found` }
  let listing
  try {
    const { stdout } = await execFileP('tar', ['-tzf', archive], { maxBuffer: 64 * 1024 * 1024 })
    listing = stdout.split('\n').filter(Boolean)
  } catch (error) {
    return { ok: false, error: `could not read backup: ${error.message}` }
  }
  for (const member of listing) {
    if (isAbsolute(member) || member.split('/').includes('..')) {
      return { ok: false, error: `refusing to restore: archive member '${member}' escapes the skills root` }
    }
  }
  try {
    await execFileP('tar', ['-xzf', archive, '-C', skillsDir()], { maxBuffer: 32 * 1024 * 1024 })
  } catch (error) {
    return { ok: false, error: `extract failed: ${error.message}` }
  }
  await ledgerAppend({ action: 'rollback', id })
  return { ok: true, id, restored: listing.length }
}

// ── pending writes (approval mode) ─────────────────────────────────────────

async function stagePending (record) {
  const dir = pendingDir()
  await ensureDir(dir)
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const row = { id, at: isoNow(), status: 'pending', ...record }
  await atomicWriteJson(join(dir, `${id}.json`), row)
  return row
}

async function listPending () {
  const dir = pendingDir()
  if (!(await exists(dir))) return []
  const out = []
  for (const entry of await listDir(dir)) {
    if (!entry.name.endsWith('.json')) continue
    const raw = await readFileSafe(join(dir, entry.name))
    if (raw === undefined) continue
    try { out.push(JSON.parse(raw)) } catch { /* skip corrupt */ }
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  return out
}

async function resolvePending (id, decision) {
  const path = join(pendingDir(), `${id}.json`)
  const raw = await readFileSafe(path)
  if (raw === undefined) return { ok: false, error: `pending write '${id}' not found` }
  let row
  try { row = JSON.parse(raw) } catch { return { ok: false, error: `pending write '${id}' is corrupt` } }
  if (row.status !== 'pending') return { ok: false, error: `pending write '${id}' is already ${row.status}` }
  return { ok: true, record: row, path, decision }
}

module.exports = {
  EXCLUDED_DIRS,
  SUPPORT_ROOTS,
  NAME_MAX,
  DESCRIPTION_MAX,
  BODY_MAX_CHARS,
  SUPPORT_FILE_MAX_CHARS,
  BACKUP_KEEP,
  READ_BEFORE_WRITE_MESSAGE,
  parseFrontmatter,
  serializeFrontmatter,
  composeSkillMd,
  scanSkills,
  findSkill,
  listLinkedFiles,
  validateName,
  validateDescription,
  validateSkillMd,
  validateRelativeSupportPath,
  supportPathOf,
  makeReadMarks,
  markRead,
  hasRead,
  ledgerAppend,
  captureBefore,
  createBackup,
  listBackups,
  restoreBackup,
  pruneBackups,
  stagePending,
  listPending,
  resolvePending,
  archiveRoot: archiveDir,
  truncated: truncate,
  sha256,
  nameOf,
  descriptionOf,
  stripFrontmatter,
}