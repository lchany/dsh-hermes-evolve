'use strict'

/**
 * Advisory lints — ported 1:1 from hermes `tools/skill_linter.py`.
 *
 * "The hard validator (skill_manager_tool._validate_frontmatter) blocks the
 * non-negotiables; this is the advisory companion encoding the CONTRIBUTING.md
 * 'Skill authoring standards' a human reviewer would otherwise catch. Findings
 * never block by themselves."
 *
 * Hermes only reports rules NEWLY introduced by a write (the "standing diff"),
 * so a skill that already violates one is not re-nagged on every patch.
 */

const { parseFrontmatter, SUPPORT_ROOTS } = require('./skill_store')

const ERROR = 'error'
const WARNING = 'warning'

// hermes `agent/skill_utils.SKILL_PROMPT_DESC_LIMIT` (the index appends "...").
const SKILL_PROMPT_DESC_LIMIT = 60

// Shell utilities already wrapped as native tools; naming them in prose steers
// the model to a raw shell call. banned token -> native tool to name instead.
const SHELL_UTIL_TO_TOOL = {
  grep: 'search_files', rg: 'search_files', cat: 'read_file', head: 'read_file',
  tail: 'read_file', sed: 'patch', awk: 'patch',
  find: "search_files (target='files')", ls: "search_files (target='files')",
}
const MARKETING_WORDS = [
  'powerful', 'comprehensive', 'seamless', 'advanced', 'cutting-edge', 'state-of-the-art',
  'revolutionary', 'robust',
]
// POSIX-only primitives that require `platforms:` when a bundled script uses them.
const POSIX_PRIMITIVES = [
  'fcntl', 'termios', 'os.setsid', 'signal.SIGKILL', 'osascript', '/proc/', 'apt-get', 'systemctl',
]
// Scaffolding files a skill should not ship (noise, not skill content).
const FORBIDDEN_FILES = ['README.md', 'CHANGELOG.md', 'install.sh', '.env', '.env.example', '.gitignore']
// Presence of the load-bearing section is checked, not exact ordering.
const EXPECTED_SECTIONS = ['When to Use', 'When to use']

// incident-log-shape: at least this many PR/issue refs AND this density per 1k chars.
const INCIDENT_REF_MIN = 4
const INCIDENT_REF_PER_KCHAR = 0.5
// references-sprawl: more reference files than this is hoarding per-session notes.
const MAX_REFERENCE_FILES = 60
// oversized-body: SKILL.md is loaded whole and rides in context for every later call.
const BODY_SOFT_BUDGET_CHARS = 24000

const RULES = {
  NAME_FORMAT: 'name-format',
  NAME_DIR_MISMATCH: 'name-dir-mismatch',
  DESCRIPTION_LENGTH: 'description-length',
  DESCRIPTION_MARKETING: 'description-marketing',
  MISSING_METADATA: 'missing-metadata',
  AUTHOR_CAPS: 'author-caps',
  PLATFORMS_VALUE: 'platforms-value',
  OVERSIZED_BODY: 'oversized-body',
  SHELL_UTILITY_REFERENCE: 'shell-utility-reference',
  MISSING_SECTION: 'missing-section',
  INCIDENT_LOG_SHAPE: 'incident-log-shape',
  DANGLING_REFERENCE: 'dangling-reference',
  PLATFORMS_GATING: 'platforms-gating',
  FORBIDDEN_FILE: 'forbidden-file',
  REFERENCES_SPRAWL: 'references-sprawl',
}

const err = (rule, message) => ({ severity: ERROR, rule, message })
const warn = (rule, message) => ({ severity: WARNING, rule, message })

/** Remove fenced code blocks so prose-only checks don't fire on examples. */
function stripCodeBlocks (body) {
  return String(body || '').replace(/```.*?```/gs, '')
}

function wordsOf (value) {
  return String(value === undefined || value === null ? '' : value).trim().replace(/^['"]|['"]$/g, '')
}

function checkFrontmatter (frontmatter, skillDir, fsSafe) {
  const findings = []
  const name = String(frontmatter.name === undefined ? '' : frontmatter.name).trim()
  if (name !== '' && !/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    findings.push(err(RULES.NAME_FORMAT, `name '${name}' must be lowercase letters, digits, hyphens, and underscores only.`))
  }
  if (skillDir !== undefined && name !== '' && name !== fsSafe.basename(skillDir)) {
    findings.push(err(RULES.NAME_DIR_MISMATCH,
      `frontmatter name '${name}' does not match directory '${fsSafe.basename(skillDir)}'; they must be identical.`))
  }
  // Measure the raw authored value: extraction already truncates to the prompt budget.
  const description = wordsOf(frontmatter.description)
  if (description.length > SKILL_PROMPT_DESC_LIMIT) {
    findings.push(warn(RULES.DESCRIPTION_LENGTH,
      `description is ${description.length} chars; the skill index truncates past ${SKILL_PROMPT_DESC_LIMIT} chars + '...', losing routing signal. Keep it to one sentence.`))
  }
  const hits = MARKETING_WORDS.filter((word) => new RegExp(`\\b${escapeRe(word)}\\b`).test(description.toLowerCase()))
  if (hits.length > 0) {
    findings.push(warn(RULES.DESCRIPTION_MARKETING,
      `description contains marketing words ${JSON.stringify(hits)}; state the capability, not adjectives.`))
  }
  for (const key of ['version', 'author', 'license']) {
    if (!(key in frontmatter)) findings.push(warn(RULES.MISSING_METADATA, `frontmatter is missing '${key}'; every peer skill has it.`))
  }
  const meta = frontmatter.metadata
  const hermesMeta = meta !== null && typeof meta === 'object' && !Array.isArray(meta) ? meta.hermes : undefined
  if (hermesMeta === undefined || hermesMeta === null || typeof hermesMeta !== 'object' || Array.isArray(hermesMeta)) {
    findings.push(warn(RULES.MISSING_METADATA, 'frontmatter is missing metadata.hermes.{tags, related_skills}.'))
  } else if (!('tags' in hermesMeta)) {
    findings.push(warn(RULES.MISSING_METADATA, 'metadata.hermes.tags is missing.'))
  }
  const author = String(frontmatter.author === undefined ? '' : frontmatter.author)
  if (author !== '' && ['hermes', 'agent', 'hermes agent'].includes(author.trim().toLowerCase()) && author !== 'Hermes Agent') {
    findings.push(warn(RULES.AUTHOR_CAPS, `author '${author}' should be 'Hermes Agent' (proper caps) or a real contributor name.`))
  }
  const platforms = frontmatter.platforms
  if (platforms !== undefined && platforms !== null && platforms !== '' && !(Array.isArray(platforms) && platforms.length === 0)) {
    const valid = ['linux', 'macos', 'windows', 'darwin']
    const items = Array.isArray(platforms) ? platforms : [platforms]
    const bad = items.filter((item) => !valid.includes(String(item).toLowerCase()))
    if (bad.length > 0) {
      findings.push(warn(RULES.PLATFORMS_VALUE, `platforms contains unrecognized value(s) ${JSON.stringify(bad)}; expected a subset of ${JSON.stringify(valid)}.`))
    }
  }
  return findings
}

function escapeRe (text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function countIncidentRefs (prose) {
  const matches = prose.match(/(?<![\w/])#\d{3,6}\b|\b(?:PR|issue)\s*#?\d{3,6}\b/g)
  return matches === null ? 0 : matches.length
}

function checkBody (body, skillDir, fsSafe) {
  const findings = []
  const text = String(body || '')
  if (text.length > BODY_SOFT_BUDGET_CHARS) {
    findings.push(warn(RULES.OVERSIZED_BODY,
      `SKILL.md body is ${text.length.toLocaleString('en-US')} chars (~${Math.floor(text.length / 4).toLocaleString('en-US')} tokens); skill_view loads all of it and it stays in context for every later call of the session. Keep the always-on rules here (~200 lines) and move topic depth into references/<topic>.md, linked from the body.`))
  }
  // Only backtick-wrapped mentions in PROSE (not fenced code): bare words are too noisy.
  const prose = stripCodeBlocks(text)
  for (const [util, tool] of Object.entries(SHELL_UTIL_TO_TOOL)) {
    if (prose.includes(`\`${util}\``)) {
      findings.push(warn(RULES.SHELL_UTILITY_REFERENCE, `prose references \`${util}\`; name the native tool \`${tool}\` instead.`))
    }
  }
  if (!EXPECTED_SECTIONS.some((section) => new RegExp(`^#+\\s+${escapeRe(section)}`, 'm').test(text))) {
    findings.push(warn(RULES.MISSING_SECTION, "no '## When to Use' section found; skills need explicit trigger conditions near the top."))
  }
  const refs = countIncidentRefs(prose)
  if (refs >= INCIDENT_REF_MIN && (refs / Math.max(prose.length, 1)) * 1000 >= INCIDENT_REF_PER_KCHAR) {
    findings.push(warn(RULES.INCIDENT_LOG_SHAPE, `${refs} PR/issue references in prose; write the generalizable rule + why and drop the incident numbers — the rule must stand without the story.`))
  }
  if (skillDir === undefined) return findings
  // Dangling links. Only references/, templates/, assets/ are reliably skill-owned;
  // `scripts/` is excluded because dev skills legitimately cite repo-root scripts.
  const seen = new Set()
  for (const match of text.matchAll(/(references|templates|assets)\/[\w./-]+/g)) {
    const rel = match[0]
    if (seen.has(rel) || rel.includes('*') || rel.endsWith('/')) continue
    seen.add(rel)
    if (!fsSafe.existsSync(fsSafe.join(skillDir, rel))) {
      findings.push(warn(RULES.DANGLING_REFERENCE, `body references '${rel}' but that file does not exist in the skill directory.`))
    }
  }
  return findings
}

function checkFiles (frontmatter, skillDir, fsSafe) {
  const findings = []
  // Bundled scripts using POSIX-only primitives require a platforms: declaration.
  const scriptsDir = fsSafe.join(skillDir, 'scripts')
  const hasPlatforms = Boolean(frontmatter.platforms) && !(Array.isArray(frontmatter.platforms) && frontmatter.platforms.length === 0)
  if (!hasPlatforms && fsSafe.existsSync(scriptsDir) && fsSafe.statSync(scriptsDir).isDirectory()) {
    const offenders = {}
    for (const script of fsSafe.walkFiles(scriptsDir)) {
      if (!['.py', '.sh', '.bash'].includes(fsSafe.extname(script))) continue
      let content = ''
      try { content = fsSafe.readFileSync(script, 'utf8') } catch { continue }
      const hit = POSIX_PRIMITIVES.filter((primitive) => content.includes(primitive))
      if (hit.length > 0) offenders[fsSafe.basename(script)] = hit
    }
    if (Object.keys(offenders).length > 0) {
      const detail = Object.entries(offenders).map(([name, hits]) => `${name}: ${JSON.stringify(hits)}`).join('; ')
      findings.push(warn(RULES.PLATFORMS_GATING,
        `scripts use POSIX-only primitives (${detail}) but no 'platforms:' frontmatter is declared. Fix cross-platform or gate with platforms: [linux, macos].`))
    }
  }
  for (const fname of FORBIDDEN_FILES) {
    if (fsSafe.existsSync(fsSafe.join(skillDir, fname))) {
      findings.push(warn(RULES.FORBIDDEN_FILE, `skill ships '${fname}'; skills should not include scaffolding/config files.`))
    }
  }
  const refsDir = fsSafe.join(skillDir, 'references')
  if (fsSafe.existsSync(refsDir) && fsSafe.statSync(refsDir).isDirectory()) {
    const nRefs = fsSafe.walkFiles(refsDir).filter((file) => file.endsWith('.md') && !fsSafe.basename(file).startsWith('_')).length
    if (nRefs > MAX_REFERENCE_FILES) {
      findings.push(warn(RULES.REFERENCES_SPRAWL,
        `${nRefs} files under references/; that is a per-session log, not topical depth. Merge same-topic files into one rule set and drop incident narration.`))
    }
  }
  return findings
}

function defaultFs () {
  const fs = require('node:fs')
  const path = require('node:path')
  const walkFiles = (dir) => {
    const out = []
    const stack = [dir]
    while (stack.length > 0) {
      const current = stack.pop()
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) stack.push(full)
        else if (entry.isFile()) out.push(full)
      }
    }
    return out
  }
  return {
    join: path.join,
    basename: path.basename,
    extname: path.extname,
    existsSync: fs.existsSync,
    statSync: fs.statSync,
    readFileSync: (file, encoding) => fs.readFileSync(file, encoding),
    walkFiles,
  }
}

/**
 * Lint raw SKILL.md *content*. `skillDir` enables on-disk checks (name/dir match,
 * dangling links, POSIX gating, forbidden files); without it only content checks
 * run, which is what the create path needs before the file exists.
 */
function lintContent (content, { skillDir, fsSafe } = {}) {
  const io = fsSafe || defaultFs()
  const { frontmatter, body } = parseFrontmatter(content)
  const findings = [...checkFrontmatter(frontmatter, skillDir, io), ...checkBody(body, skillDir, io)]
  if (skillDir !== undefined) findings.push(...checkFiles(frontmatter, skillDir, io))
  return findings
}

/** Lint a SKILL.md file on disk, with all on-disk checks enabled. */
function lintSkill (skillMdPath, { fsSafe } = {}) {
  const io = fsSafe || defaultFs()
  const path = require('node:path')
  return lintContent(io.readFileSync(skillMdPath, 'utf8'), { skillDir: path.dirname(skillMdPath), fsSafe: io })
}

/** Rules that are new in `after` but not in `before` (the standing diff). */
function newlyIntroduced (before, after) {
  const seen = new Set((before || []).map((finding) => finding.rule))
  return (after || []).filter((finding) => !seen.has(finding.rule))
}

module.exports = {
  ERROR,
  WARNING,
  RULES,
  SKILL_PROMPT_DESC_LIMIT,
  lintContent,
  lintSkill,
  newlyIntroduced,
  _internals: { stripCodeBlocks, checkFrontmatter, checkBody, checkFiles, countIncidentRefs },
}
