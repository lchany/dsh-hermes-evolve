'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const review = require('../src/review')

function fakeSession (id = 'sess-1') {
  const appended = []
  return {
    appended,
    session: {
      id,
      seq: 0,
      header: { cwd: '/tmp/project' },
      deriveMessages: () => [
        { id: 'm1', role: 'user', content: [{ type: 'text', text: 'fix the parser bug' }], source: { kind: 'user' } },
        { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Fixed it by escaping the delimiter.' }], source: { kind: 'model' } },
      ],
      append: (type, data) => { appended.push({ type, data }) },
    },
  }
}

const SETTINGS = {
  enabled: true,
  memoryWriteApproval: false,
  skillsWriteApproval: false,
  memoryEnabled: true,
  skillNudgeInterval: 2,
  memoryNudgeInterval: 2,
  language: 'en',
}

function event (type, data) {
  return { type, data, seq: 0, at: new Date().toISOString() }
}

test('a review fires only after the iteration threshold and a completed turn', async () => {
  let fired = 0
  const { session } = fakeSession()
  const scheduler = review.createScheduler({
    hostCtx: null,
    settings: SETTINGS,
    logger: { info: () => {}, debug: () => {} },
    runReview: async () => { fired += 1; return { ok: false, skipped: 'test' } },
  })

  // One tool iteration is not enough.
  await scheduler.onEvent(session, event('step/end', {}))
  await scheduler.onEvent(session, event('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
  await scheduler.onEvent(session, event('assistant/message', { message: { content: [{ type: 'text', text: 'done' }] } }))
  await scheduler.onEvent(session, event('turn/end', { reason: { kind: 'completed' } }))
  assert.equal(fired, 0)

  // The second iteration crosses skillNudgeInterval=2.
  await scheduler.onEvent(session, event('step/end', {}))
  await scheduler.onEvent(session, event('step/end', {}))
  await scheduler.onEvent(session, event('user/message', { content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
  await scheduler.onEvent(session, event('assistant/message', { message: { content: [{ type: 'text', text: 'done again' }] } }))
  await scheduler.onEvent(session, event('turn/end', { reason: { kind: 'completed' } }))
  assert.equal(fired, 1)
})

test('a review fork budget denies tool calls past its limit', async () => {
  const id = 'hermes-evolve-review-budget'
  review.__reviewBudgets.set(id, { used: 0, max: 2 })
  try {
    assert.equal(review.consumeReviewIteration(id).allowed, true)
    assert.equal(review.consumeReviewIteration(id).allowed, true)
    const over = review.consumeReviewIteration(id)
    assert.equal(over.allowed, false)
    assert.equal(over.used, 3)
    assert.match(review.reviewBudgetReason(over.used, over.max), /2-step tool budget \(3 used\)/)
    assert.equal(review.consumeReviewIteration('not-a-review-session'), null)
  } finally {
    review.__reviewBudgets.delete(id)
  }
})

test('a second review inside 30 minutes is throttled and keeps its trigger', async () => {
  let fired = 0
  let clock = 10_000_000
  const { session } = fakeSession()
  const scheduler = review.createScheduler({
    hostCtx: null,
    settings: { ...SETTINGS, skillNudgeInterval: 1, memoryNudgeInterval: 1000 },
    logger: { info: () => {}, debug: () => {} },
    now: () => clock,
    runReview: async () => { fired += 1; return { ok: false, skipped: 'test' } },
  })

  const turn = async () => {
    await scheduler.onEvent(session, event('step/end', {}))
    await scheduler.onEvent(session, event('assistant/message', { message: { content: [{ type: 'text', text: 'done' }] } }))
    await scheduler.onEvent(session, event('turn/end', { reason: { kind: 'completed' } }))
  }

  await turn()
  assert.equal(fired, 1)
  clock += 60_000
  await turn()
  assert.equal(fired, 1, 'throttled inside the 30 minute window')
  clock += 30 * 60_000
  await turn()
  assert.equal(fired, 2, 'the kept trigger fires once the window passes')
})

test('an interrupted or empty turn never triggers a review', async () => {
  const logs = []
  const { session } = fakeSession()
  const scheduler = review.createScheduler({
    hostCtx: null,
    settings: { ...SETTINGS, skillNudgeInterval: 1 },
    logger: { info: (line) => logs.push(line), debug: () => {} },
  })
  await scheduler.onEvent(session, event('step/end', {}))
  await scheduler.onEvent(session, event('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
  await scheduler.onEvent(session, event('turn/end', { reason: { kind: 'aborted', reason: 'user' } }))
  assert.equal(logs.length, 0)
})

test('recall blocks and review notices stay out of the review transcript', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'how do we deploy?' }], source: { kind: 'user' } },
    { role: 'user', content: [{ type: 'text', text: '<memory-context>\n- deploy: token\n</memory-context>' }], source: { kind: 'agentmemory', form: 'recall' } },
    { role: 'assistant', content: [{ type: 'text', text: 'use the token' }], source: { kind: 'model' } },
    { role: 'user', content: [{ type: 'text', text: '[hermes-evolve] 背景复盘完成' }], source: { kind: 'hermes-evolve', form: 'notice' } },
  ]
  const rendered = review.renderTranscript(messages, { maxChars: 2000, maxMessages: 10 })
  assert.match(rendered, /how do we deploy\?/)
  assert.match(rendered, /use the token/)
  assert.doesNotMatch(rendered, /memory-context/)
  assert.doesNotMatch(rendered, /背景复盘完成/)
})

test('transcript rendering keeps the newest turns and labels roles', () => {
  const messages = []
  for (let index = 0; index < 60; index += 1) {
    messages.push({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `message ${index}` }],
      source: { kind: index % 2 === 0 ? 'user' : 'model' },
    })
  }
  const rendered = review.renderTranscript(messages, { maxChars: 2000, maxMessages: 10 })
  assert.match(rendered, /message 59/)
  assert.doesNotMatch(rendered, /message 0\n/)
  assert.ok(rendered.length <= 2100)
})
