'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const prompts = require('../src/prompts')

test('prompt provenance points at the pinned hermes commit', () => {
  assert.match(prompts.SOURCE, /hermes-agent@[0-9a-f]{40}|hermes-agent@d923a5eb48/)
  assert.match(prompts.SOURCE, /v0\.22\.2/)
})

test('the three review prompts are the verbatim hermes texts', () => {
  const skills = prompts.reviewPrompt({ reviewMemory: false, reviewSkills: true })
  const memory = prompts.reviewPrompt({ reviewMemory: true, reviewSkills: false })
  const both = prompts.reviewPrompt({ reviewMemory: true, reviewSkills: true })

  assert.match(skills, /Be ACTIVE/)
  assert.match(skills, /references\//)
  assert.doesNotMatch(memory, /Be ACTIVE/)
  assert.match(memory, /Nothing to save/)
  assert.notEqual(both, skills)
  assert.notEqual(both, memory)
  assert.ok(memory.length < 1500)

  // Same scope pair must select the same prompt every time (hermes
  // _PROMPT_NAME_BY_SCOPE).
  assert.equal(both, prompts.reviewPrompt({ reviewMemory: true, reviewSkills: true }))
})

test('every review prompt carries the do-not-capture negative list', () => {
  const skills = prompts.reviewPrompt({ reviewMemory: false, reviewSkills: true })
  assert.match(skills, /not durable rules|DO NOT/i)
  assert.match(skills, /read-before-write|read it first|skill_view/i)
})

test('the curator prompt is umbrella-building and renders hermes candidate rows', () => {
  const rows = [{
    name: 'old-skill', provenance: 'agent', state: 'stale', pinned: false, cron: false,
    activity_count: 4, use_count: 3, view_count: 1, patch_count: 0, last_activity_at: '2026-01-01T00:00:00Z',
  }]
  const prompt = prompts.curatorPrompt({ dryRun: false, rows })
  assert.match(prompt, /UMBRELLA/)
  assert.match(prompt, /human maintainer/)
  assert.match(prompt, /references\//)
  // hermes `_render_candidate_list` row: two-space separated, fixed field order.
  assert.match(prompt, /Agent-created skills \(1\):/)
  assert.match(prompt, /- old-skill  provenance=agent  state=stale  pinned=no  cron=no  activity=4  use=3  view=1  patches=0  last_activity=2026-01-01T00:00:00Z/)
  const dry = prompts.curatorPrompt({ dryRun: true, rows })
  assert.match(dry, /DRY-RUN/)
  assert.ok(dry.length > prompt.length)
  assert.equal(prompts.curatorPrompt({ dryRun: false, rows: [] }).endsWith('No agent-created skills to review.'), true)
})

test('review user message carries hermes transcript + prompt + tool suffix', () => {
  const message = prompts.buildReviewMessage({
    transcript: '### User\nfix the bug\n\n### Assistant\nfixed',
    prompt: prompts.reviewPrompt({ reviewMemory: false, reviewSkills: true }),
    memoryAllowed: false,
  })
  assert.match(message, /^### User\nfix the bug/)
  assert.match(message, /Be ACTIVE/)
  assert.match(message, /You can only call skill management tools\. Other tools will be denied at runtime — do not attempt them\.$/)
  const withMemory = prompts.buildReviewMessage({ transcript: 'x', prompt: 'p', memoryAllowed: true })
  assert.match(withMemory, /You can only call memory and skill management tools\./)
})

test('the always-on guidance is short enough to sit in every system prompt', () => {
  assert.ok(prompts.SKILLS_COACHING_TEXT.length < 2000)
  assert.ok(prompts.MEMORY_GUIDANCE_TEXT.length < 1500)
  assert.match(prompts.SKILLS_COACHING_TEXT, /skill_view/)
  assert.match(prompts.MEMORY_GUIDANCE_TEXT, /declarative facts/)
  assert.equal(prompts.skillsCoaching(false), '')
  assert.equal(prompts.memoryGuidance(false).length, 0)
})