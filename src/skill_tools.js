'use strict'

/**
 * The four model-facing tools, ported from hermes:
 *
 *   skills_list    tier-1 catalog (name + description)
 *   skill_view     full SKILL.md or one linked file, and the read that authorizes a write
 *   skill_manage   create / patch / write_file / remove_file / delete(->archive)
 *   memory         add / replace / remove / batch over MEMORY.md and USER.md
 *
 * They are registered into the REVIEW FORK's own tool layer, never globally, so
 * the main conversation's tool surface (and its prompt cache) is untouched.
 * Handlers return the same JSON envelopes and the same error strings hermes
 * returns, because those strings are what teaches the model to retry correctly.
 */

const fsP = require('node:fs/promises')
const { join, dirname } = require('node:path')

const store = require('./skill_store')
const usage = require('./skill_usage')
const linter = require('./skill_linter')
const memory = require('./memory')
const {
  skillsDir, archiveDir, memoryDir, ensureDir, readFileSafe, atomicWrite, exists,
  sha256, isoNow,
} = require('./util')

const SCHEMAS = require('./tool_schemas')
const { DEFAULTS } = require('./const')

/** Remove a directory only when it is empty (a support-file removal tidies up). */
async function removeDirIfEmpty (dir) {
  try {
    const entries = await fsP.readdir(dir)
    if (entries.length === 0) await fsP.rmdir(dir)
  } catch { /* not empty / missing / not a dir */ }
}

const json = (value) => JSON.stringify(value, null, 0)

function fail (message, extra = {}) {
  return json({ success: false, error: message, ...extra })
}

// ── shared helpers ─────────────────────────────────────────────────────────

function toolContext (overrides = {}) {
  return {
    marks: store.makeReadMarks(),
    agentCreated: false,
    requireReadBeforeWrite: true,
    // When true, every mutating tool refuses and asks the model to describe the
    // change instead: the human approves before anything lands (Hermes'
    // `skills.write_approval` / `memory.write_approval`).
    writeApproval: false,
    linterEnabled: true,
    ledgerEnabled: true,
    supportFilesEnabled: true,
    maxSupportFileChars: store.SUPPORT_FILE_MAX_CHARS,
    maxBodyChars: store.BODY_MAX_CHARS,
    memoryCharLimit: DEFAULTS.memoryCharLimit,
    userCharLimit: DEFAULTS.userCharLimit,
    // hermes `_review_tool_whitelist`: a memory-less review pass must not even
    // SEE the memory tool, or it burns iterations on a denied call.
    includeMemory: true,
    // hermes #105921: an unattended fork may add notes but may not delete or
    // rewrite existing ones — those are staged for a human instead.
    unattendedMemory: false,
    lang: 'zh',
    // Hermes' provider hook `on_memory_write`: a host that owns the built-in
    // store announces each applied operation so an external memory provider can
    // mirror it. Null here means nobody is listening.
    onMemoryWrite: null,
    ...overrides,
  }
}

// ── approval mode (D6) ─────────────────────────────────────────────────────
//
// Hermes does not refuse a gated write: `evaluate_gate` returns `stage=True`,
// `_run_write_gate` persists a complete, replayable payload, and the tool
// answers `{success:true, staged:true, pending_id, gist, message}`
// (tools/skill_manager_tool.py:652-700, tools/write_approval.py:_staged).
// The human then approves from the pending surface and the replay goes through
// the same handler. Refusing outright was a capability regression: the review
// could describe a change but never deliver one. The functions below restore
// Hermes' staging semantics on top of our pending store.

/** Where a human reviews a staged write. */
const STAGED_WHERE = 'review in the hermes-evolve panel (/hermes-evolve → Pending review)'

/** Answer for a write that was staged instead of applied. */
function stagedApprovalEnvelope (row, subsystem) {
  return json({
    success: true,
    done: true,
    staged: true,
    proposal_staged: true,
    pending_id: row.id,
    message: `Staged for approval (${subsystem}.write_approval is on). Not yet saved — ${STAGED_WHERE}.`,
  })
}

/** `_frontmatter_description` from tools/write_approval.py (<=140 chars). */
function frontmatterDescription (content) {
  const match = /^description:\s*(.+)$/m.exec(String(content || ''))
  if (match === null) return ''
  return match[1].trim().replace(/^['"]|['"]$/g, '').slice(0, 140)
}

/** Hermes' `skill_gist`: a one-line, model-free summary of a staged write. */
function skillGist (op) {
  if (op === null || typeof op !== 'object') return 'unknown operation'
  const action = String(op.action || '')
  const name = String(op.name || '')
  const content = typeof op.content === 'string' ? op.content : ''
  if ((action === 'create' || action === 'edit') && content !== '') {
    const desc = frontmatterDescription(content)
    const size = content.length >= 1024 ? `${Math.floor(content.length / 1024) + 1} KB` : `${content.length} chars`
    return `${action === 'create' ? 'create' : 'rewrite'} '${name}'${desc === '' ? '' : ` — ${desc}`} (${size})`
  }
  if (action === 'patch') {
    const oldString = typeof op.old_string === 'string' ? op.old_string : ''
    const newString = typeof op.new_string === 'string' ? op.new_string : ''
    const removed = oldString === '' ? 0 : oldString.split('\n').length
    const added = newString === '' ? 0 : newString.split('\n').length
    const filePath = typeof op.file_path === 'string' && op.file_path !== '' ? op.file_path : 'SKILL.md'
    return `patch '${name}' ${filePath} (+${added}/-${removed} lines)`
  }
  const templates = {
    write_file: `write {file_path} in '{name}'`,
    remove_file: `remove {file_path} from '{name}'`,
    delete: "delete skill '{name}'",
  }
  const template = templates[action] || "{action} '{name}'"
  return template.replace('{action}', action).replace('{name}', name)
    .replace('{file_path}', typeof op.file_path === 'string' ? op.file_path : '')
}

/**
 * Persist a skill batch for human approval. Every op is kept verbatim so the
 * panel can replay it through `applyOperation` — the same code path a direct
 * write takes — instead of re-deriving a diff.
 */
async function stageSkillOperations (ops, ctx) {
  const gist = ops.length === 1
    ? skillGist(ops[0])
    : `${ops.length} skill operations: ${ops.map(skillGist).join('; ')}`
  let row
  try {
    row = await store.stagePending({
      kind: 'skill',
      operations: ops,
      gist,
      // Provenance crosses the approval boundary: a skill the review created is
      // still agent-created (and curator-managed) when it is finally written.
      agentCreated: ctx.agentCreated === true,
      actor: ctx.actor || (ctx.agentCreated === true ? 'background-review' : 'write-approval'),
    })
  } catch (error) {
    return fail(`Could not stage the change for approval: ${error && error.message ? error.message : error}`)
  }
  if (!row || row.id === undefined) return fail('Could not stage the change for approval.')
  return json({
    success: true,
    staged: true,
    pending_id: row.id,
    gist,
    message: `Staged for approval (skills.write_approval is on). Not yet saved — ${STAGED_WHERE}.`,
  })
}

/**
 * Replay an approved skill batch. The human already read the payload, so the
 * read-before-write guard is off; everything else (validation, limits, atomic
 * writes, ledger, archive, rollback) is the direct-write machinery.
 */
async function applyStagedSkillOperations (operations, overrides = {}) {
  const ctx = toolContext({
    requireReadBeforeWrite: false,
    writeApproval: false,
    actor: 'panel-approval',
    ...overrides,
  })
  const bag = { touched: new Map(), created: [], lintNotes: [] }
  const results = []
  for (const op of Array.isArray(operations) ? operations : []) {
    const outcome = await applyOperation(op, ctx, bag)
    if (outcome.ok !== true) {
      await rollbackTouched(bag.touched, bag.created)
      return { ok: false, error: outcome.error, failed_op: op && op.action, failed_skill: op && op.name, rolled_back: true }
    }
    results.push({ action: outcome.action, name: outcome.name, message: outcome.message })
  }
  return {
    ok: true,
    applied: results.length,
    results,
    ...(bag.lintNotes.length > 0 ? { lint: bag.lintNotes } : {}),
  }
}

// ── skills_list ────────────────────────────────────────────────────────────

async function handleSkillsList (args, ctx) {
  try {
    const category = args && typeof args.category === 'string' ? args.category : undefined
    let skills = await store.scanSkills()
    skills = skills.map((s) => ({ name: s.name, description: s.description, ...(s.category ? { category: s.category } : {}) }))
    if (category !== undefined) skills = skills.filter((s) => s.category === category)
    if (skills.length === 0) {
      return json({ success: true, skills: [], categories: [], message: 'No skills found in skills/ directory.' })
    }
    const categories = [...new Set(skills.map((s) => s.category).filter(Boolean))].sort()
    return json({
      success: true,
      skills,
      categories,
      count: skills.length,
      hint: 'Use skill_view(name) to see full content, tags, and linked files',
    })
  } catch (error) {
    return fail(String(error && error.message ? error.message : error))
  }
}

// ── skill_view ─────────────────────────────────────────────────────────────

async function handleSkillView (args, ctx) {
  try {
    const name = String((args && args.name) || '').trim()
    const filePath = args && typeof args.file_path === 'string' && args.file_path.trim() !== ''
      ? args.file_path.trim()
      : undefined
    if (name === '') return fail('name is required')
    const skill = await store.findSkill(name)
    if (skill === undefined) {
      return fail(`Skill '${name}' not found. Use skills_list to see available skills.`,
        { hint: "Call skills_list() to see the names this library actually contains." })
    }
    if (filePath !== undefined) {
      const pathError = store.validateRelativeSupportPath(filePath)
      if (pathError !== undefined) return fail(pathError)
      const target = store.supportPathOf(skill.dir, filePath)
      const raw = await readFileSafe(target)
      if (raw === undefined) {
        const linked = await store.listLinkedFiles(skill.dir)
        return fail(`File '${filePath}' not found in skill '${skill.name}'.`,
          { available: linked })
      }
      store.markRead(ctx.marks, `${skill.name}:${filePath.replace(/\\/g, '/')}`)
      await usage.recordLoaded(skill.name, { file: filePath })
      return json({
        success: true,
        name: skill.name,
        file_path: filePath,
        content: raw,
        path: skill.relPath,
      })
    }

    const linked = await store.listLinkedFiles(skill.dir)
    store.markRead(ctx.marks, skill.name)
    await usage.recordLoaded(skill.name, { file: 'SKILL.md' })
    const fm = skill.frontmatter || {}
    const meta = fm.metadata && typeof fm.metadata === 'object' ? (fm.metadata.hermes || {}) : {}
    const tags = parseList(meta.tags !== undefined ? meta.tags : fm.tags)
    const related = parseList(meta.related_skills !== undefined ? meta.related_skills : fm.related_skills)
    const result = {
      success: true,
      name: skill.name,
      description: skill.description,
      tags,
      related_skills: related,
      content: skill.content,
      path: skill.relPath,
      skill_dir: skill.dir,
      linked_files: Object.keys(linked).length > 0 ? linked : null,
      usage_hint: Object.keys(linked).length > 0
        ? "To view linked files, call skill_view(name, file_path) where file_path is e.g. 'references/api.md' or 'assets/config.yaml'"
        : null,
    }
    return json(result)
  } catch (error) {
    return fail(String(error && error.message ? error.message : error))
  }
}

function parseList (value) {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean)
  if (typeof value === 'string' && value.trim() !== '') {
    return value.split(',').map((v) => v.trim()).filter(Boolean)
  }
  return []
}

// ── skill_manage ───────────────────────────────────────────────────────────

/**
 * One `operations` batch, applied all-or-nothing. Each op names its own target
 * skill; a `create` must come before that skill's other ops.
 */
async function handleSkillManage (args, ctx) {
  try {
    const ops = Array.isArray(args && args.operations) ? args.operations : []
    if (ops.length === 0) {
      return fail("skill_manage requires a non-empty 'operations' array; a single edit is a list of one.")
    }
    // Snapshot every file the batch may touch so a later failure restores it.
    const touched = new Map()
    const created = []
    const results = []
    const lintNotes = []
    // Hermes stages gated skill writes and replays them on approval; refusing
    // here would make approval mode a capability regression (D6).
    if (ctx.writeApproval === true) return stageSkillOperations(ops, ctx)
    for (const op of ops) {
      const outcome = await applyOperation(op, ctx, { touched, created, lintNotes })
      if (outcome.ok !== true) {
        await rollbackTouched(touched, created)
        return json({
          success: false,
          error: outcome.error,
          failed_op: op && op.action,
          failed_skill: op && op.name,
          rolled_back: true,
          ...(outcome.extra || {}),
        })
      }
      results.push({ action: outcome.action, name: outcome.name, message: outcome.message })
    }
    const payload = { success: true, applied: results.length, results }
    if (lintNotes.length > 0) {
      payload.lint = lintNotes
      payload.hint = 'Advisory lints only — the write is saved. Fix what you agree with in a later op.'
    }
    return json(payload)
  } catch (error) {
    return fail(String(error && error.message ? error.message : error))
  }
}

async function applyOperation (op, ctx, bag) {
  if (op === null || typeof op !== 'object') return { ok: false, error: 'Each operation must be an object.' }
  const action = String(op.action || '')
  const name = String(op.name || '').trim()
  const nameError = store.validateName(name)
  if (nameError !== undefined) return { ok: false, error: nameError }
  switch (action) {
    case 'create': return opCreate(op, name, ctx, bag)
    case 'patch': return opPatch(op, name, ctx, bag)
    case 'write_file': return opWriteFile(op, name, ctx, bag)
    case 'remove_file': return opRemoveFile(op, name, ctx, bag)
    case 'delete': return opDelete(op, name, ctx, bag)
    default:
      return { ok: false, error: `Unknown action '${action}'. Use: create, patch, write_file, remove_file, delete` }
  }
}

async function snapshotFile (bag, path) {
  if (bag.touched.has(path)) return
  const raw = await readFileSafe(path)
  bag.touched.set(path, raw === undefined ? null : raw)
}

async function rollbackTouched (touched, created) {
  for (const [path, raw] of touched.entries()) {
    try {
      if (raw === null) await fsP.rm(path, { force: true })
      else {
        await ensureDir(dirname(path))
        await atomicWrite(path, raw)
      }
    } catch { /* best effort rollback */ }
  }
  for (const dir of created.reverse()) {
    try { await fsP.rm(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

async function opCreate (op, name, ctx, bag) {
  const content = String(op.content || '')
  const invalid = store.validateSkillMd(content, name)
  if (invalid !== undefined) return { ok: false, error: invalid }
  const existing = await store.findSkill(name)
  if (existing !== undefined) {
    return { ok: false, error: `Skill '${name}' already exists (at ${existing.relPath}). Use patch to change it.` }
  }
  const category = typeof op.category === 'string' ? op.category.trim() : ''
  if (category !== '' && !/^[A-Za-z0-9._-]+$/.test(category)) {
    return { ok: false, error: `Invalid category '${category}': single path segment, no slashes.` }
  }
  const dir = join(skillsDir(), ...(category === '' ? [name] : [category, name]))
  const mdPath = join(dir, 'SKILL.md')
  if (await exists(mdPath)) {
    return { ok: false, error: `Skill directory already exists at ${dir}.` }
  }
  bag.touched.set(mdPath, null)
  await ensureDir(dir)
  bag.created.push(dir)
  await atomicWrite(mdPath, content)
  await usage.recordCreated(name, { agentCreated: ctx.agentCreated === true })
  if (ctx.linterEnabled) {
    const findings = linter.lintContent(content, { skillDir: dir })
    if (findings.length > 0) bag.lintNotes.push({ skill: name, findings })
  }
  if (ctx.ledgerEnabled) {
    await store.ledgerAppend({ action: 'create', skill: name, before: null, after: sha256(content), actor: ctx.actor || 'review' })
  }
  return { ok: true, action: 'create', name, message: `Created skill '${name}'.` }
}

async function opPatch (op, name, ctx, bag) {
  const skill = await store.findSkill(name)
  if (skill === undefined) return { ok: false, error: `Skill '${name}' not found.` }
  const filePath = typeof op.file_path === 'string' && op.file_path.trim() !== '' ? op.file_path.trim() : undefined
  const pathError = filePath === undefined ? undefined : store.validateRelativeSupportPath(filePath)
  if (pathError !== undefined) return { ok: false, error: pathError }
  const target = filePath === undefined ? skill.mdPath : store.supportPathOf(skill.dir, filePath)
  const mark = filePath === undefined ? skill.name : `${skill.name}:${filePath.replace(/\\/g, '/')}`
  if (ctx.requireReadBeforeWrite !== false && !store.hasRead(ctx.marks, mark)) {
    return { ok: false, error: store.READ_BEFORE_WRITE_MESSAGE(filePath === undefined ? `SKILL.md of '${name}'` : `'${filePath}' of '${name}'`) }
  }
  const current = await readFileSafe(target)
  if (current === undefined) return { ok: false, error: `File '${filePath || 'SKILL.md'}' not found in skill '${name}'.` }

  const contentReplace = typeof op.content === 'string' && op.content !== ''
  const hasPair = typeof op.old_string === 'string' && typeof op.new_string === 'string'
  if (!contentReplace && !hasPair) {
    return { ok: false, error: 'patch requires either {old_string, new_string} (preferred) or {content} (full-file rewrite).' }
  }
  let next
  if (hasPair) {
    if (op.old_string === '') return { ok: false, error: 'old_string cannot be empty; use {content} to rewrite the whole file.' }
    const occurrences = countOccurrences(current, op.old_string)
    if (occurrences === 0) {
      return { ok: false, error: `old_string was not found in ${filePath || 'SKILL.md'}. Re-read the file with skill_view and copy the exact text.` }
    }
    if (occurrences > 1 && op.replace_all !== true) {
      return { ok: false, error: `old_string appears ${occurrences} times in ${filePath || 'SKILL.md'}; pass replace_all=true or include more surrounding text.` }
    }
    next = op.replace_all === true
      ? current.split(op.old_string).join(op.new_string)
      : current.replace(op.old_string, op.new_string)
  } else {
    next = String(op.content)
    if (filePath === undefined) {
      const invalid = store.validateSkillMd(next, name)
      if (invalid !== undefined) return { ok: false, error: invalid }
    }
  }
  if (String(next).length > (filePath === undefined ? ctx.maxBodyChars : ctx.maxSupportFileChars)) {
    return { ok: false, error: `Resulting file is ${String(next).length} chars, over the ${filePath === undefined ? ctx.maxBodyChars : ctx.maxSupportFileChars}-char limit.` }
  }
  await snapshotFile(bag, target)
  await atomicWrite(target, next)
  await usage.recordPatched(name)

  if (ctx.linterEnabled) {
    const beforeFindings = linter.lintContent(current, { skillDir: skill.dir })
    const afterRaw = filePath === undefined ? next : current
    const afterFindings = linter.lintContent(afterRaw, { skillDir: skill.dir })
    const fresh = linter.newlyIntroduced(beforeFindings, afterFindings)
    if (fresh.length > 0) bag.lintNotes.push({ skill: name, findings: fresh })
  }
  if (ctx.ledgerEnabled) {
    await store.ledgerAppend({
      action: 'patch', skill: name, file: filePath || 'SKILL.md',
      before: sha256(current), after: sha256(next), actor: ctx.actor || 'review',
    })
  }
  return { ok: true, action: 'patch', name, message: `Patched ${filePath || 'SKILL.md'} in '${name}'.` }
}

function countOccurrences (haystack, needle) {
  if (needle === '') return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

async function opWriteFile (op, name, ctx, bag) {
  if (ctx.supportFilesEnabled === false) return { ok: false, error: 'Supporting files are disabled in settings.' }
  const skill = await store.findSkill(name)
  if (skill === undefined) return { ok: false, error: `Skill '${name}' not found.` }
  const filePath = op.file_path
  const pathError = store.validateRelativeSupportPath(filePath)
  if (pathError !== undefined) return { ok: false, error: pathError }
  const content = String(op.file_content === undefined ? '' : op.file_content)
  if (content === '') return { ok: false, error: 'file_content is required (and cannot be empty).' }
  if (content.length > ctx.maxSupportFileChars) {
    return { ok: false, error: `file_content is ${content.length} chars, over the ${ctx.maxSupportFileChars}-char limit.` }
  }
  const target = store.supportPathOf(skill.dir, filePath)
  if (await exists(target) && ctx.requireReadBeforeWrite !== false
    && !store.hasRead(ctx.marks, `${skill.name}:${String(filePath).replace(/\\/g, '/')}`)) {
    return { ok: false, error: store.READ_BEFORE_WRITE_MESSAGE(`'${filePath}' of '${name}'`) }
  }
  const prior = await readFileSafe(target)
  await snapshotFile(bag, target)
  await ensureDir(dirname(target))
  await atomicWrite(target, content)
  if (prior === undefined) await usage.recordPatched(name)
  if (ctx.linterEnabled) {
    // Re-lint the body: a written or removed support file can fix or create a
    // dangling reference (hermes re-runs the linter on write_file for that reason).
    const body = await readFileSafe(skill.mdPath)
    if (body !== undefined) {
      const findings = linter.lintContent(body, { skillDir: skill.dir })
      if (findings.length > 0) bag.lintNotes.push({ skill: name, findings })
    }
  }
  if (ctx.ledgerEnabled) {
    await store.ledgerAppend({
      action: 'write_file', skill: name, file: String(filePath),
      before: prior === undefined ? null : sha256(prior), after: sha256(content), actor: ctx.actor || 'review',
    })
  }
  return { ok: true, action: 'write_file', name, message: `Wrote ${filePath} in '${name}'.` }
}

async function opRemoveFile (op, name, ctx, bag) {
  const skill = await store.findSkill(name)
  if (skill === undefined) return { ok: false, error: `Skill '${name}' not found.` }
  const pathError = store.validateRelativeSupportPath(op.file_path)
  if (pathError !== undefined) return { ok: false, error: pathError }
  const target = store.supportPathOf(skill.dir, op.file_path)
  const prior = await readFileSafe(target)
  if (prior === undefined) return { ok: false, error: `File '${op.file_path}' not found in skill '${name}'.` }
  if (ctx.requireReadBeforeWrite !== false && !store.hasRead(ctx.marks, `${skill.name}:${String(op.file_path).replace(/\\/g, '/')}`)) {
    return { ok: false, error: store.READ_BEFORE_WRITE_MESSAGE(`'${op.file_path}' of '${name}'`) }
  }
  await snapshotFile(bag, target)
  await fsP.rm(target, { force: true })
  await removeDirIfEmpty(dirname(target))
  if (ctx.ledgerEnabled) {
    await store.ledgerAppend({ action: 'remove_file', skill: name, file: String(op.file_path), before: sha256(prior), actor: ctx.actor || 'review' })
  }
  return { ok: true, action: 'remove_file', name, message: `Removed ${op.file_path} from '${name}'.` }
}

/**
 * `delete` is an ARCHIVE, never an unlink. Four independent layers in hermes
 * enforce this; the reason is that a self-maintaining library that can delete
 * has no recovery story, and consolidation mistakes look exactly like cleanup.
 */
async function opDelete (op, name, ctx, bag) {
  const skill = await store.findSkill(name)
  if (skill === undefined) return { ok: false, error: `Skill '${name}' not found.` }
  const absorbedInto = typeof op.absorbed_into === 'string' ? op.absorbed_into.trim() : ''
  if (absorbedInto !== '') {
    const umbrella = await store.findSkill(absorbedInto)
    if (umbrella === undefined) {
      return { ok: false, error: `absorbed_into='${absorbedInto}' does not exist; a consolidation must name a skill that is really there.` }
    }
    if (umbrella.name === skill.name) {
      return { ok: false, error: 'absorbed_into must name a DIFFERENT skill than the one being archived.' }
    }
  }
  const before = await store.captureBefore(skill, true)
  const archRoot = archiveDir()
  await ensureDir(archRoot)
  let dest = join(archRoot, skill.name)
  if (await exists(dest)) {
    dest = join(archRoot, `${skill.name}-${isoNow().replace(/[-:TZ.]/g, '').slice(0, 14)}`)
  }
  try {
    await fsP.rename(skill.dir, dest)
    // `curator purge` ages archives by mtime; a rename keeps the skill's last-edit
    // mtime, so a freshly-consolidated skill would look ancient. Age it explicitly.
    const now = new Date()
    await fsP.utimes(dest, now, now)
  } catch (error) {
    return { ok: false, error: `failed to archive '${name}': ${error.message}` }
  }
  await usage.markArchived(name)
  if (ctx.ledgerEnabled) {
    await store.ledgerAppend({
      action: 'archive', skill: name, dir: skill.dir, dest,
      complete_package: true, absorbed_into: absorbedInto || null, before,
      actor: ctx.actor || 'review',
    })
  }
  return {
    ok: true,
    action: 'archive',
    name,
    message: `Archived '${name}' to ${dest} (recoverable; nothing was deleted).`,
  }
}

// ── memory ─────────────────────────────────────────────────────────────────

const BG_DELETE_ACTIONS = new Set(['replace', 'remove'])
const BG_DELETE_REFUSAL = "Background review may not delete memory entries ('replace'/'remove', including in a batch); 'add' is still available."

/** hermes `stage_write` response for an unattended destructive memory edit. */
function stagedMemoryEnvelope (row) {
  return json({
    success: true,
    done: true,
    staged: true,
    proposal_staged: true,
    pending_id: row.id,
    message: 'Background review may not delete memory entries unattended. The proposed change was staged for your approval — open the hermes-evolve panel to approve (apply) or reject (drop) it.',
  })
}

async function handleMemory (args, ctx) {
  try {
    const approval = ctx.writeApproval === true
    const target = args && args.target ? String(args.target) : 'memory'
    if (target !== 'memory' && target !== 'user') {
      return fail(`Invalid memory target '${target}'. Use 'memory' or 'user'.`)
    }
    const limit = target === 'user' ? ctx.userCharLimit : ctx.memoryCharLimit
    if (limit === undefined) return fail('Memory limits are not configured.')
    let content = args && typeof args.content === 'string' ? args.content : ''
    const newText = args && typeof args.new_text === 'string' ? args.new_text : ''
    if (content === '' && newText !== '') content = newText
    const oldText = args && typeof args.old_text === 'string' ? args.old_text : ''
    const operations = Array.isArray(args && args.operations) ? args.operations : undefined

    if (operations !== undefined) {
      const normalized = operations.map((op) => ({
        action: String(op.action || ''),
        text: typeof op.content === 'string' ? op.content : (typeof op.new_text === 'string' ? op.new_text : ''),
        oldText: typeof op.old_text === 'string' ? op.old_text : '',
      }))
      // Approval mode stages EVERY batch, as `evaluate_gate` does for a gated
      // subsystem; an unattended review stages only the destructive ones.
      if (approval || (ctx.unattendedMemory === true && normalized.some((op) => BG_DELETE_ACTIONS.has(op.action)))) {
        let row
        try {
          row = await store.stagePending({
            kind: 'memory',
            target,
            limit,
            operations: normalized,
            actor: approval ? 'write-approval' : 'background-review',
          })
        } catch (error) {
          return fail(approval ? `Could not stage the change for approval: ${error.message}` : BG_DELETE_REFUSAL)
        }
        if (!row || row.id === undefined) return fail(approval ? 'Could not stage the change for approval.' : BG_DELETE_REFUSAL)
        return approval ? stagedApprovalEnvelope(row, 'memory') : stagedMemoryEnvelope(row)
      }
      const outcome = await memory.writeMemory(memoryDir(), target, normalized, { limit })
      if (outcome.ok) notifyMemoryWrite(ctx, target, outcome)
      return json(outcome.ok ? successEnvelope('batch') : failureEnvelope(outcome, target))
    }
    if (args && typeof args.action !== 'string') {
      return fail("Missing required parameter: provide 'action' (add/replace/remove) or 'operations' (batch list). Got neither.")
    }
    const action = String(args.action)
    if (!['add', 'replace', 'remove'].includes(action)) {
      return fail(`Unknown action '${action}'. Use: add, replace, remove`)
    }
    if (action !== 'add' && oldText.trim() === '') {
      return fail(`old_text is required for '${action}': a short unique substring identifying the existing entry.`)
    }
    if (approval || (ctx.unattendedMemory === true && BG_DELETE_ACTIONS.has(action))) {
      let row
      try {
        row = await store.stagePending({
          kind: 'memory',
          target,
          limit,
          operations: [{ action, text: content, oldText }],
          actor: approval ? 'write-approval' : 'background-review',
        })
      } catch (error) {
        return fail(approval ? `Could not stage the change for approval: ${error.message}` : BG_DELETE_REFUSAL)
      }
      if (!row || row.id === undefined) return fail(approval ? 'Could not stage the change for approval.' : BG_DELETE_REFUSAL)
      return approval ? stagedApprovalEnvelope(row, 'memory') : stagedMemoryEnvelope(row)
    }
    const outcome = await memory.writeMemory(memoryDir(), target, [{ action, text: content, oldText }], { limit })
    if (outcome.ok) notifyMemoryWrite(ctx, target, outcome)
    return json(outcome.ok ? successEnvelope(action) : failureEnvelope(outcome, target))
  } catch (error) {
    return fail(String(error && error.message ? error.message : error))
  }
}

/** hermes `on_memory_write(action, target, content, metadata)` — one call per
 *  applied operation, each seeing the preceding operation's result. No-ops and
 *  failed writes are not announced; the provider must never learn a change that
 *  did not land. */
function notifyMemoryWrite (ctx, target, outcome) {
  if (typeof ctx.onMemoryWrite !== 'function') return
  const rows = []
  for (const operation of Array.isArray(outcome.applied) ? outcome.applied : []) {
    if (operation.noop === true) continue
    const action = typeof operation.action === 'string' ? operation.action : ''
    if (!['add', 'replace', 'remove'].includes(action)) continue
    rows.push({
      action,
      target,
      content: typeof operation.text === 'string' ? operation.text : '',
      previous_content: typeof operation.previous === 'string' ? operation.previous : '',
    })
  }
  if (rows.length === 0) return
  try {
    ctx.onMemoryWrite(rows)
  } catch { /* a mirror is never worth failing the write for */ }
}

function successEnvelope (action) {
  return {
    success: true,
    done: true,
    message: action === 'batch' ? 'Applied operation batch.' : 'Write saved.',
    note: 'Write saved. This update is complete — do not repeat it.',
  }
}

/** Memory failures echo the current entries so the model can consolidate in ONE
 *  corrective batch; a wasted corrective round trip is worse than the tokens. */
function failureEnvelope (outcome, target) {
  const payload = { success: false, error: outcome.detail || 'Memory write failed.' }
  if (outcome.currentEntries !== undefined) payload.current_entries = outcome.currentEntries
  if (outcome.used !== undefined) payload.usage = `${outcome.used}/${outcome.limit}`
  if (outcome.candidates !== undefined) payload.candidates = outcome.candidates
  return payload
}

// ── DSH tool definitions ───────────────────────────────────────────────────

function toolDefinition (schema, handler, context) {
  return {
    name: schema.name,
    description: schema.description,
    parameters: schema.parameters,
    output: {
      schema: { type: 'string' },
      render (args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : json(value) }]
      },
    },
    async execute (args, exec) {
      // A host-registered tool serves MANY agents, so its read-before-write
      // ledger must be resolved per call; a fork passes one static context.
      const active = typeof context === 'function' ? context(exec) : context
      return handler(args === null || typeof args !== 'object' ? {} : args, active)
    },
  }
}

/**
 * Build the four tools bound to one review pass. `context.marks` is the
 * read-before-write ledger for THIS pass; nothing leaks between passes.
 */
function buildToolSet (options = {}) {
  // `resolveContext` gives each call its own ledger (host-global registration);
  // the default binds one ledger for the lifetime of the set (review fork).
  const context = typeof options.resolveContext === 'function'
    ? options.resolveContext
    : toolContext(options)
  const tools = [
    toolDefinition(SCHEMAS.skills_list, handleSkillsList, context),
    toolDefinition(SCHEMAS.skill_view, handleSkillView, context),
    toolDefinition(SCHEMAS.skill_manage, handleSkillManage, context),
  ]
  if (!(options.includeMemory === false)) tools.push(toolDefinition(SCHEMAS.memory, handleMemory, context))
  return tools
}

const TOOL_NAMES = ['skills_list', 'skill_view', 'skill_manage', 'memory']

module.exports = {
  TOOL_NAMES,
  successEnvelope,
  handleSkillsList,
  handleSkillView,
  handleSkillManage,
  handleMemory,
  buildToolSet,
  toolContext,
  applyStagedSkillOperations,
  skillGist,
  json,
}