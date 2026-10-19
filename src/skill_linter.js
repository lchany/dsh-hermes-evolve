'use strict'

/**
 * Advisory lints — ported from hermes `tools/skill_linter.py`.
 *
 * Advisory means exactly that: these never block a write. They catch the two
 * shapes a self-writing skill library reliably produces when nobody watches:
 * a body that has become an incident log (dates, PR numbers, "step 5: that
 * didn't work either"), and a references/ directory that turned into one file
 * per session instead of one file per topic.
 *
 * Hermes only reports rules NEWLY introduced by this write (the "standing
 * diff"), so a skill that already violates one is not re-nagged on every patch.
 */

const { SUPPORT_ROOTS } = require('./skill_store')

const RULES = {
  OVERSIZED_BODY: 'oversized-body',
  INCIDENT_LOG_SHAPE: 'incident-log-shape',
  REFERENCES_SPRAWL: 'references-sprawl',
  DANGLING_REFERENCE: 'dangling-reference',
  DESCRIPTION_TRIGGER: 'description-trigger',
}

const LINT_BODY_SOFT_BUDGET = 24000
const LINT_MAX_REFERENCE_FILES = 60
const LINT_INCIDENT_REF_MIN = 4
const LINT_INCIDENT_REF_PER_KCHAR = 0.5
const TRIGGER_WINDOW = 57

/** References that look like an incident: a date, a PR/issue number, a ticket id. */
const INCIDENT_REF_RE = /(?:\b(?:19|20)\d{2}-\d{2}-\d{2}\b|\b#\d{3,6}\b|\b(?:PR|issue|ticket|GH)[-\s]?\d{2,6}\b)/gi

function refDensity (body) {
  const text = String(body || '')
  const matches = text.match(INCIDENT_REF_RE)
  const count = matches === null ? 0 : matches.length
  const perKchar = text.length === 0 ? 0 : (count / text.length) * 1000
  return { count, perKchar }
}

/**
 * Lint one skill package.
 * @param {object} skill  {name, description, content, body, dir}
 * @param {string[]} files  linked relative support paths (e.g. 'references/a.md')
 * @returns {{rule: string, severity: string, message: string}[]}
 */
function lintSkill (skill, files, { bodyBudget = LINT_BODY_SOFT_BUDGET, maxReferenceFiles = LINT_MAX_REFERENCE_FILES } = {}) {
  const findings = []
  const content = String((skill && skill.content) || '')
  const body = String((skill && (skill.body || content)) || '')
  const list = Array.isArray(files) ? files : []

  if (content.length > bodyBudget) {
    findings.push({
      rule: RULES.OVERSIZED_BODY,
      severity: 'advisory',
      message: `SKILL.md is ${content.length} chars (soft budget ${bodyBudget}). `
        + 'skill_view loads the WHOLE file and it then stays in context for the session: '
        + 'move depth into references/<topic>.md and leave the imperative rules in SKILL.md.',
    })
  }

  const { count, perKchar } = refDensity(body)
  if (count >= LINT_INCIDENT_REF_MIN && perKchar >= LINT_INCIDENT_REF_PER_KCHAR) {
    findings.push({
      rule: RULES.INCIDENT_LOG_SHAPE,
      severity: 'advisory',
      message: `Body carries ${count} incident references (${perKchar.toFixed(2)}/kchar): this reads as an incident log, `
        + 'not instructions. Keep the rule (imperative + one clause of why) and drop the dates, PR numbers and narration.',
    })
  }

  const referenceCount = list.filter((f) => String(f).startsWith('references/')).length
  if (referenceCount > maxReferenceFiles) {
    findings.push({
      rule: RULES.REFERENCES_SPRAWL,
      severity: 'advisory',
      message: `references/ holds ${referenceCount} files (limit ${maxReferenceFiles}). Fold them into one file per TOPIC — `
        + 'a per-session file library is the shape the curator exists to merge.',
    })
  }

  const description = String((skill && skill.description) || '')
  if (description !== '' && !/^use when|^when |^use for/i.test(description)) {
    findings.push({
      rule: RULES.DESCRIPTION_TRIGGER,
      severity: 'advisory',
      message: 'Description does not start with a trigger class. The system prompt truncates descriptions to '
        + `${TRIGGER_WINDOW} chars and matching happens on that window — start with "Use when <trigger>."`,
    })
  }

  return findings
}

/** Dangling relative links in SKILL.md body that point at support files that do not exist.
 *  Hermes deliberately does not scan scripts/ (generated names are common there). */
function lintReferences (body, files) {
  const findings = []
  const present = new Set((files || []).map((f) => String(f)))
  const seen = new Set()
  const re = /(?:^|[\s(])((?:references|templates|assets)\/[A-Za-z0-9._/-]+)/g
  let match
  while ((match = re.exec(String(body || ''))) !== null) {
    const ref = match[1]
    if (seen.has(ref)) continue
    seen.add(ref)
    if (present.has(ref)) continue
    findings.push({
      rule: RULES.DANGLING_REFERENCE,
      severity: 'advisory',
      message: `SKILL.md links '${ref}', which does not exist in the skill package. `
        + 'A future session will follow that link into nothing.',
    })
  }
  return findings
}

/** Split findings into those this write introduced vs those already standing. */
function newlyIntroduced (before, after) {
  const prior = new Set((before || []).map((f) => f.rule))
  return (after || []).filter((f) => !prior.has(f.rule))
}

function formatFindings (findings) {
  if (!Array.isArray(findings) || findings.length === 0) return ''
  return findings.map((f) => `- [${f.rule}] ${f.message}`).join('\n')
}

module.exports = {
  RULES,
  LINT_BODY_SOFT_BUDGET,
  LINT_MAX_REFERENCE_FILES,
  INCIDENT_REF_RE,
  SUPPORT_ROOTS,
  lintSkill,
  lintReferences,
  newlyIntroduced,
  formatFindings,
  refDensity,
}