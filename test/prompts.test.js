'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const prompts = require('../src/prompts')

test('prompt provenance points at the pinned hermes commit', () => {
  assert.match(prompts.SOURCE, /hermes-agent@[0-9a-f]{40}|hermes-agent@d923a5eb48/)
  assert.match(prompts.SOURCE, /v0\.22\.2/)
})

test('the three review prompts are the verbatim hermes texts', () => {
  const skills = prompts.reviewSystemPrompt({ reviewMemory: false, reviewSkills: true })
  const memory = prompts.reviewSystemPrompt({ reviewMemory: true, reviewSkills: false })
  const both = prompts.reviewSystemPrompt({ reviewMemory: true, reviewSkills: true })

  assert.match(skills, /Be ACTIVE/)
  assert.match(skills, /references\//)
  assert.doesNotMatch(memory, /Be ACTIVE/)
  assert.match(memory, /Nothing to save/)
  assert.notEqual(both, skills)
  assert.notEqual(both, memory)
  assert.ok(memory.length < 1500)

  // Same scope pair must select the same prompt every time (hermes
  // _PROMPT_NAME_BY_SCOPE).
  assert.equal(both, prompts.reviewSystemPrompt({ reviewMemory: true, reviewSkills: true }))
})

test('every review prompt carries the do-not-capture negative list', () => {
  const skills = prompts.reviewSystemPrompt({ reviewMemory: false, reviewSkills: true })
  assert.match(skills, /not durable rules|DO NOT/i)
  assert.match(skills, /read-before-write|read it first|skill_view/i)
})

test('the curator prompt is umbrella-building, not a duplicate finder', () => {
  const prompt = prompts.curatorSystemPrompt({ dryRun: false })
  assert.match(prompt, /UMBRELLA/)
  assert.match(prompt, /human maintainer/)
  assert.match(prompt, /references\//)
  const dry = prompts.curatorSystemPrompt({ dryRun: true })
  assert.match(dry, /DRY-RUN/)
  assert.ok(dry.length > prompt.length)
})

test('language directive pins the artifact language', () => {
  assert.match(prompts.reviewLanguageDirective('en'), /English/)
  assert.match(prompts.reviewLanguageDirective('zh'), /Chinese/)
})

test('review user message frames the transcript and the catalog', () => {
  const message = prompts.buildReviewUserMessage({
    transcript: '### User\nfix the bug\n\n### Assistant\nfixed',
    catalog: [{ name: 'pdf-toolkit', description: 'extract text from PDFs' }],
    suspects: [],
    lang: 'en',
  })
  assert.match(message, /<conversation_to_review>/)
  assert.match(message, /pdf-toolkit/)
  assert.match(message, /fix the bug/)
})

test('curator user message reports usage columns and rules', () => {
  const message = prompts.buildCuratorUserMessage({
    catalog: [{ name: 'old-skill', description: 'stale helper' }],
    usage: [{ name: 'old-skill', state: 'active', use_count: 3, view_count: 1, patch_count: 0, last_used_at: '2026-01-01T00:00:00Z', created_by: 'agent' }],
    idleDays: { staleDays: 14, archiveDays: 30 },
    now: Date.parse('2026-02-01T00:00:00Z'),
    dryRun: false,
    lang: 'en',
  })
  assert.match(message, /stale_after_days=14/)
  assert.match(message, /archive_after_days=30/)
  assert.match(message, /old-skill/)
  assert.match(message, /use=3/)
})

test('the always-on guidance is short enough to sit in every system prompt', () => {
  assert.ok(prompts.SKILLS_COACHING_TEXT.length < 2000)
  assert.ok(prompts.MEMORY_GUIDANCE_TEXT.length < 1500)
  assert.match(prompts.SKILLS_COACHING_TEXT, /skill_view/)
  assert.match(prompts.MEMORY_GUIDANCE_TEXT, /declarative facts/)
  assert.equal(prompts.skillsCoaching(false), '')
  assert.equal(prompts.memoryGuidance(false).length, 0)
})