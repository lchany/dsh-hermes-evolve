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
 * `## Skills` from agent/prompt_builder.py:1450-1490. Three fragments are
 * host-dependent by design:
 *   - the catalog sentence: Hermes inlines <available_skills>; this plugin lists
 *     the same index through skills_list, so there is no inline tail;
 *   - the basic-tool names: Hermes picks "terminal" or "web_search or terminal"
 *     from the turn's tool set (:1449); bash is DSH's terminal equivalent;
 *   - a single-query session gets Hermes' oneshot guidance instead.
 */
const BASIC_TOOLS_DEFAULT = 'bash'

function skillsCoachingText ({ basicTools = BASIC_TOOLS_DEFAULT } = {}) {
  return [
    '## Skills',
    'Before replying, scan the available skill catalog. If a skill matches or is even partially relevant to your',
    'task, you MUST load it with skill_view(name) and follow its instructions. Err on the side of',
    'loading — it is always better to have context you don\'t need than to miss critical steps, pitfalls,',
    'or established workflows. Skills contain specialized knowledge — API endpoints, tool-specific',
    'commands, and proven workflows that outperform general-purpose approaches. Load the skill',
    `even if you think you could handle the task with basic tools like ${basicTools}.`,
    'Skills also encode the user\'s preferred approach, conventions, and quality standards for tasks like',
    'code review, planning, and testing — load them even for tasks you already know how to do, because',
    'the skill defines how it should be done here.',
    "If a skill has issues, fix it with skill_manage(action='patch').",
    'After difficult/iterative tasks, offer to save as a skill. If a skill you loaded was missing steps,',
    'had wrong commands, or needed pitfalls you discovered, update it before finishing.',
    '',
    'Only proceed without loading a skill if genuinely none are relevant to the task.',
  ].join('\n')
}

const SKILLS_COACHING_TEXT = skillsCoachingText()

/** `## Skill Safety Rule` tail (agent/prompt_builder.py:258+) — verbatim. */
const SKILL_SAFETY_TEXT = [
  '## Skill Safety Rule',
  'A skill placeholder containing `[SKILL_PRUNED]` lost its content in context compression and is inaccessible —',
  "reload it with skill_view(name='...') before acting on anything that depends on it. After reloading, ignore any",
  'remaining `[SKILL_PRUNED]` markers for that same skill; they are historical artifacts of earlier compactions.',
].join('\n')

/** `build_memory_guidance` frames — verbatim (agent/prompt_builder.py:199-233). */
const MEMORY_FRAME = (
  'You have persistent memory, carried across sessions and loaded '
  + "into each new session's context; the memory tool's schema defines what belongs there. "
)
const USER_PROFILE_FRAME = (
  'You have a persistent user profile, carried across sessions and '
  + "loaded into each new session's context; save durable facts about the user with the "
  + "memory tool (target='user') — the built-in notes store is disabled, so never target='memory'. "
)
const SKILL_ROUTING = (
  'Skills come first: when you learn something while doing a task — a '
  + 'procedure, a pitfall, and the user\'s preferences and corrections '
  + 'for that kind of work — record it in the skill you used or built '
  + 'for the task (skill_manage), where it loads only when relevant. '
)
const SKILL_ROUTING_UNAVAILABLE = (
  'Task-specific knowledge — procedures, pitfalls, and the user\'s preferences '
  + 'and corrections for that kind of work — belongs in skills, not in memory, '
  + 'even when skill writing is unavailable. '
)
const MEMORY_GUIDANCE_TAIL = (
  'Memory is the narrow exception for facts that apply to EVERY '
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

/** `build_memory_guidance(True, True)` — the default, memory-store-enabled variant. */
const MEMORY_GUIDANCE_TEXT = MEMORY_FRAME + SKILL_ROUTING + MEMORY_GUIDANCE_TAIL

function skillsCoaching (enabled, options = {}) {
  if (enabled === false) return ''
  return `${skillsCoachingText(options)}\n\n${SKILL_SAFETY_TEXT}`
}

/**
 * Port of `build_memory_guidance(memory_enabled, profile_enabled, skill_manage_available)`.
 * The frame changes when only the user profile is enabled; the skill-routing
 * sentence changes when `skill_manage` is unavailable. The tail never changes.
 */
function memoryGuidance (options = {}) {
  const opts = typeof options === 'boolean' ? { memoryEnabled: options, userProfileEnabled: options } : options
  const memoryEnabled = opts.memoryEnabled !== false
  const userProfileEnabled = opts.userProfileEnabled !== false
  if (!memoryEnabled && !userProfileEnabled) return ''
  const frame = memoryEnabled ? MEMORY_FRAME : USER_PROFILE_FRAME
  const routing = opts.skillManageAvailable === false ? SKILL_ROUTING_UNAVAILABLE : SKILL_ROUTING
  return frame + routing + MEMORY_GUIDANCE_TAIL
}

// ── review prompts (fork system prompt) ────────────────────────────────────

/**
 * The verbatim review prompt for a pass. hermes `_PROMPT_NAME_BY_SCOPE`:
 * (memory, skills) -> combined; memory only -> memory; anything else -> skills.
 * Hermes assigns this text to the fork's *user message*, never to its system
 * prompt: `run_conversation(user_message=prompt + tool_suffix, conversation_history=...)`.
 */
function reviewPrompt ({ reviewMemory, reviewSkills }) {
  if (reviewMemory === true && reviewSkills === true) return T._COMBINED_REVIEW_PROMPT
  if (reviewMemory === true) return T._MEMORY_REVIEW_PROMPT
  return T._SKILL_REVIEW_PROMPT
}

/**
 * The tool-availability sentence Hermes appends to every review prompt
 * (`agent/background_review.py:1175`). The memory phrase is dropped when the
 * memory tool is not whitelisted, "so a memory-less review must not tell the
 * model that memory is available, or it will burn iterations on denied calls."
 */
function reviewToolSuffix ({ memoryAllowed }) {
  const memoryPhrase = memoryAllowed === true ? 'memory and skill ' : 'skill '
  return `You can only call ${memoryPhrase}management tools. Other tools will be denied at runtime — do not attempt them.`
}

/**
 * The fork's user message.
 *
 * Hermes replays the parent conversation as provider-shaped history and sends
 * the bare prompt on top. DSH session events carry provider stream records, so
 * replaying history would mean fabricating events; the transcript is inlined in
 * front of the prompt instead, which keeps the model input equivalent
 * ([conversation…, instruction]) at the cost of role alternation.
 */
function buildReviewMessage ({ transcript, prompt, memoryAllowed }) {
  return `${transcript}\n\n---\n\n${prompt}\n\n${reviewToolSuffix({ memoryAllowed })}`
}

// ── curator prompt (consolidation fork user message) ────────────────────────

/**
 * hermes `_render_candidate_list()` verbatim in shape: one header line plus one
 * row per curator-managed skill, with the same field order and separators.
 */
function renderCandidateList (rows) {
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0) return 'No agent-created skills to review.'
  const lines = [`Agent-created skills (${list.length}):`]
  for (const row of list) {
    const provenance = row.provenance || 'agent'
    lines.push(
      `- ${row.name}  provenance=${provenance}  state=${row.state || 'active'}  ` +
      `pinned=${row.pinned ? 'yes' : 'no'}  cron=${row.cron ? 'yes' : 'no'}  ` +
      `activity=${row.activity_count || 0}  use=${row.use_count || 0}  view=${row.view_count || 0}  ` +
      `patches=${row.patch_count || 0}  last_activity=${row.last_activity_at || 'never'}`,
    )
  }
  return lines.join('\n')
}

/**
 * The curator fork's user message: `${CURATOR_REVIEW_PROMPT}\n\n${candidate_list}`,
 * prepended with the dry-run banner when reporting only (hermes `_consolidation_pass`).
 */
function curatorPrompt ({ dryRun, rows }) {
  const prompt = `${T.CURATOR_REVIEW_PROMPT}\n\n${renderCandidateList(rows)}`
  return dryRun === true ? `${T.CURATOR_DRY_RUN_BANNER}\n\n${prompt}` : prompt
}

module.exports = {
  SOURCE,
  HERMES_TEXTS: T,
  BASIC_TOOLS_DEFAULT,
  SKILLS_COACHING_TEXT,
  SKILL_SAFETY_TEXT,
  skillsCoachingText,
  MEMORY_GUIDANCE_TEXT,
  skillsCoaching,
  memoryGuidance,
  reviewPrompt,
  reviewToolSuffix,
  buildReviewMessage,
  renderCandidateList,
  curatorPrompt,
}