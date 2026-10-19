'use strict'

/**
 * Every string in this file that a model reads is either copied VERBATIM from
 * hermes-agent (v0.22.2) via `scripts/extract_prompts.py` -> `prompts.hermes.json`,
 * or is a context wrapper around one of those strings. Nothing here is invented
 * policy: the review prompts are the entire learning strategy, and paraphrasing
 * them silently changes what the agent decides to save.
 *
 * The one deliberate adaptation: hermes appends the skill catalog to the same
 * `## Skills` block, but DSH's own system prompt already carries the catalog
 * (`<available_skills>`). Duplicating it would pay the tokens twice and put two
 * disagreeing lists in front of the model, so the catalog sentence points at the
 * catalog instead of embedding it.
 */

const path = require('node:path')

const HERMES = require('./prompts.hermes.json')
const T = HERMES.texts

/** Provenance stamp — every prompt here is pinned to this commit. */
const SOURCE = HERMES.source

// ── in-turn coaching (main conversation system prompt) ─────────────────────

/**
 * `## Skills` from agent/prompt_builder.py:1470-1490. Verbatim except the two
 * catalog-dependent fragments ("scan the skills below" -> "scan the available
 * skill catalog", and no inline <available_skills> tail).
 */
const SKILLS_COACHING_TEXT = [
  '## Skills',
  'Before replying, scan the available skill catalog. If a skill matches or is even partially relevant to your',
  'task, you MUST load it with skill_view(name) and follow its instructions. Err on the side of',
  'loading — it is always better to have context you don\'t need than to miss critical steps, pitfalls,',
  'or established workflows. Skills contain specialized knowledge — API endpoints, tool-specific',
  'commands, and proven workflows that outperform general-purpose approaches. Load the skill',
  'even if you think you could handle the task with basic tools like read/glob/grep.',
  'Skills also encode the user\'s preferred approach, conventions, and quality standards for tasks like',
  'code review, planning, and testing — load them even for tasks you already know how to do, because',
  'the skill defines how it should be done here.',
  "If a skill has issues, fix it with skill_manage(action='patch').",
  'After difficult/iterative tasks, offer to save as a skill. If a skill you loaded was missing steps,',
  'had wrong commands, or needed pitfalls you discovered, update it before finishing.',
  '',
  'Only proceed without loading a skill if genuinely none are relevant to the task.',
].join('\n')

/** `## Skill Safety Rule` tail (agent/prompt_builder.py:262+) — verbatim. */
const SKILL_SAFETY_TEXT = [
  '## Skill Safety Rule',
  'A skill placeholder containing `[SKILL_PRUNED]` lost its content in context compression and is inaccessible —',
  "reload it with skill_view(name='...') before acting on anything that depends on it. After reloading, ignore any",
  'instruction to treat the earlier placeholder as if it still had content.',
].join('\n')

/** `build_memory_guidance(True, True)` — verbatim (agent/prompt_builder.py:199-233). */
const MEMORY_GUIDANCE_TEXT = (
  'You have persistent memory, carried across sessions and loaded '
  + "into each new session's context; the memory tool's schema defines what belongs there. "
  + 'Skills come first: when you learn something while doing a task — a '
  + 'procedure, a pitfall, and the user\'s preferences and corrections '
  + 'for that kind of work — record it in the skill you used or built '
  + 'for the task (skill_manage), where it loads only when relevant. '
  + 'Memory is the narrow exception for facts that apply to EVERY '
  + 'session regardless of task (who the user is, environment facts, '
  + 'standing conventions with no task home); it has a hard character '
  + 'budget, so when it fills, replace or consolidate stale entries '
  + 'rather than skipping the save. Write entries as declarative facts, '
  + 'not instructions to yourself: \'User prefers concise responses\' ✓ — '
  + '\'Always respond concisely\' ✗ (imperative phrasing gets re-read as '
  + 'a directive in later sessions and can override the user\'s current '
  + 'request). A fact stale within a week belongs in session history; '
  + 'procedures and workflows belong in skills.'
)

function skillsCoaching (enabled) {
  if (enabled === false) return ''
  return `${SKILLS_COACHING_TEXT}\n\n${SKILL_SAFETY_TEXT}`
}

function memoryGuidance (enabled) {
  return enabled === false ? '' : MEMORY_GUIDANCE_TEXT
}

// ── review prompts (fork system prompt) ────────────────────────────────────

/**
 * Which verbatim prompt a pass runs under. hermes `_PROMPT_NAME_BY_SCOPE`:
 * (memory, skills) -> combined; memory only -> memory; anything else -> skills.
 */
function reviewSystemPrompt ({ reviewMemory, reviewSkills }) {
  if (reviewMemory === true && reviewSkills === true) return T._COMBINED_REVIEW_PROMPT
  if (reviewMemory === true) return T._MEMORY_REVIEW_PROMPT
  return T._SKILL_REVIEW_PROMPT
}

/**
 * Pin the artifact language to the conversation's language. Both
 * `@weibaohui/hermes-loop` and hermes found the same failure: a fully-English
 * protocol with a Chinese catalog/memory produced a Chinese SKILL.md even when
 * the user's preference was English. The protocol keywords stay English because
 * the tools and headings they drive are English.
 */
function reviewLanguageDirective (lang) {
  const label = lang === 'en' ? 'English' : 'Chinese (Simplified)'
  return [
    `Write every artifact you save in ${label}: skill bodies, skill descriptions, and memory entries.`,
    'Keep as-is: JSON keys, tool names, file paths, code, and the fixed SKILL.md section headings',
    '(When to Use / Prerequisites / Procedure / Pitfalls / Verification).',
    'The conversation, the catalog, and the memory files may be in another language — that is not a signal about the artifact language.',
  ].join(' ')
}

const REVIEW_FRAME_OPEN = '<conversation_to_review>'
const REVIEW_FRAME_CLOSE = '</conversation_to_review>'

/**
 * The user message for a review pass: the transcript, the current catalog, and
 * the full body of the skills most likely to be relevant. Suspects are loaded
 * eagerly because a fork with no edit history cannot guess which skill a lesson
 * belongs to, and paying to view the wrong one costs more than pasting the right
 * three (hermes `rankSuspects`).
 */
function buildReviewUserMessage ({ transcript, catalog, suspects, lang, extra }) {
  const parts = []
  parts.push(`Conversation transcript (most recent turns last):\n${REVIEW_FRAME_OPEN}\n${transcript}\n${REVIEW_FRAME_CLOSE}`)
  if (Array.isArray(catalog) && catalog.length > 0) {
    parts.push([
      'Current skill library (name — description):',
      ...catalog.map((entry) => `- ${entry.name}${entry.description ? ` — ${entry.description}` : ''}`),
    ].join('\n'))
  } else {
    parts.push('Current skill library: empty — no skills exist yet.')
  }
  if (Array.isArray(suspects) && suspects.length > 0) {
    const blocks = suspects.map((suspect) => {
      const header = `### SKILL: ${suspect.name}\n${suspect.description || ''}`
      const linked = suspect.linked && Object.keys(suspect.linked).length > 0
        ? `\nLinked files: ${JSON.stringify(suspect.linked)}`
        : ''
      return `${header}${linked}\n\n${suspect.content}`
    })
    parts.push(`Relevant skills, loaded in full because the transcript matched them:\n\n${blocks.join('\n\n---\n\n')}`)
  }
  parts.push(reviewLanguageDirective(lang))
  if (typeof extra === 'string' && extra.trim() !== '') parts.push(extra)
  return parts.join('\n\n')
}

// ── curator prompt (consolidation fork system prompt) ───────────────────────

function curatorSystemPrompt ({ dryRun }) {
  const banner = dryRun === true ? `${T.CURATOR_DRY_RUN_BANNER}\n\n` : ''
  return `${banner}${T.CURATOR_REVIEW_PROMPT}`
}

function buildCuratorUserMessage ({ catalog, usage, idleDays, now, dryRun, lang, extra }) {
  const lines = []
  // Tolerate both shapes: a name->record map (the caller's form) and an array of
  // records (convenient in tests and panels).
  const usageMap = Array.isArray(usage)
    ? Object.fromEntries(usage.filter((row) => row && row.name).map((row) => [row.name, row]))
    : (usage || {})
  const skills = Array.isArray(catalog) ? catalog : []
  const rules = (idleDays && typeof idleDays === 'object') ? idleDays : {}
  lines.push(`Current time: ${now}`)
  lines.push(`Enabled curator rules: stale_after_days=${rules.staleDays}, archive_after_days=${rules.archiveDays}. ` +
    'A skill at or beyond stale_after_days of inactivity has already been MARKED stale by the deterministic pass; ' +
    'it is still in the library and still yours to consolidate.')
  if (dryRun === true) lines.push('DRY-RUN: report only. Do not call any mutating tool.')
  lines.push('')
  lines.push('Current skill library, with lifetime counters (<name> | state | uses | views | patches | last activity):')
  for (const entry of skills) {
    const record = usageMap[entry.name] || {}
    const last = record.last_used_at || record.last_viewed_at || record.last_patched_at || record.created_at || 'never'
    lines.push(`- ${entry.name} | ${record.state || 'active'} | use=${record.use_count || 0} | view=${record.view_count || 0} | patch=${record.patch_count || 0} | last=${last}`)
    if (entry.description) lines.push(`    ${entry.description}`)
    if (record.created_by) lines.push(`    created_by=${record.created_by}${record.pinned ? ' pinned=true' : ''}`)
  }
  lines.push('')
  lines.push(reviewLanguageDirective(lang).replace('skill bodies, skill descriptions, and memory entries',
    'skill bodies and skill descriptions'))
  if (typeof extra === 'string' && extra.trim() !== '') lines.push(extra)
  return lines.join('\n')
}

module.exports = {
  SOURCE,
  HERMES_TEXTS: T,
  SKILLS_COACHING_TEXT,
  SKILL_SAFETY_TEXT,
  MEMORY_GUIDANCE_TEXT,
  skillsCoaching,
  memoryGuidance,
  reviewSystemPrompt,
  reviewLanguageDirective,
  buildReviewUserMessage,
  curatorSystemPrompt,
  buildCuratorUserMessage,
}