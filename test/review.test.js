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
      deriveMessages: () => [],
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
  review.__reviewBudgets.set(id, { used: 0, max: 2, usedInputTokens: 0, maxInputTokens: 100 })
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

test('a trigger colliding with a running pass is spent, not retried (hermes rule)', async () => {
  let fired = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { session } = fakeSession()
  const scheduler = review.createScheduler({
    hostCtx: null,
    settings: { ...SETTINGS, skillNudgeInterval: 1, memoryNudgeInterval: 1000 },
    logger: { info: () => {}, debug: () => {} },
    runReview: async () => { fired += 1; await gate; return { ok: false, skipped: 'test' } },
  })
  const turn = async () => {
    await scheduler.onEvent(session, event('step/end', {}))
    await scheduler.onEvent(session, event('assistant/message', { message: { content: [{ type: 'text', text: 'done' }] } }))
    await scheduler.onEvent(session, event('turn/end', { reason: { kind: 'completed' } }))
  }

  const first = turn()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fired, 1)
  await turn()
  assert.equal(fired, 1, 'the second trigger collided with the live pass')
  release()
  await first
  // hermes zeroed the skill counter at the finalizer, so the lost trigger does
  // not fire later: only a fresh threshold does.
  await turn()
  assert.equal(fired, 2)
})

test('counters are hydrated from persisted history like hermes', async () => {
  const calls = []
  const session = {
    id: 'resumed-1',
    header: { cwd: '/tmp/project' },
    deriveMessages: () => [
      { role: 'user', content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }], source: { kind: 'model' } },
      { role: 'user', content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }], source: { kind: 'model' } },
      { role: 'user', content: [{ type: 'text', text: 'three' }], source: { kind: 'user' } },
      { role: 'user', content: [{ type: 'text', text: 'four — the current turn' }], source: { kind: 'user' } },
    ],
    append: () => {},
  }
  const scheduler = review.createScheduler({
    hostCtx: null,
    settings: { ...SETTINGS, skillNudgeInterval: 1000, memoryNudgeInterval: 2 },
    logger: { info: () => {}, debug: () => {} },
    runReview: async (_ctx, options) => { calls.push(options); return { ok: false, skipped: 'test' } },
  })
  // Hydration: 4 persisted human turns, current one included → (4-1) % 2 = 1.
  await scheduler.onEvent(session, event('user/message', { content: [{ type: 'text', text: 'four — the current turn' }], source: { kind: 'user' } }))
  await scheduler.onEvent(session, event('assistant/message', { message: { content: [{ type: 'text', text: 'ok' }] } }))
  await scheduler.onEvent(session, event('turn/end', { reason: { kind: 'completed' } }))
  assert.equal(calls.length, 1, 'the hydrated counter reached the interval')
  assert.equal(calls[0].reviewMemory, true)
  assert.equal(calls[0].reviewSkills, false)
})

test('the fork input-token budget denies further tool calls', async () => {
  const id = 'hermes-evolve-review-tokens'
  review.__reviewBudgets.set(id, { used: 0, max: 16, usedInputTokens: 0, maxInputTokens: 100 })
  try {
    const scheduler = review.createScheduler({
      hostCtx: null,
      settings: SETTINGS,
      logger: { info: () => {}, debug: () => {} },
    })
    await scheduler.onEvent({ id, header: { origin: 'subagent' } }, event('assistant/message', {
      message: { content: [{ type: 'text', text: 'step' }] },
      usage: { inputTokens: 150, outputTokens: 5 },
    }))
    const budget = review.consumeReviewIteration(id)
    assert.equal(budget.tokenHit, true)
    assert.equal(budget.allowed, false)
    assert.equal(budget.tokens, 150)
    assert.match(review.reviewTokenBudgetReason(budget.tokens, budget.maxTokens), /100-token input budget \(150 used\)/)
  } finally {
    review.__reviewBudgets.delete(id)
  }
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
  // hermes zeroes the skill counter at the finalizer even for an aborted turn:
  // the next iteration alone must not reach the threshold again.
  await scheduler.onEvent(session, event('step/end', {}))
  await scheduler.onEvent(session, event('assistant/message', { message: { content: [{ type: 'text', text: 'done' }] } }))
  await scheduler.onEvent(session, event('turn/end', { reason: { kind: 'completed' } }))
  assert.equal(logs.length, 0, 'the aborted turn consumed the skill trigger')
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

// ── self-improvement recap (hermes `_action_lines`) ──────────────────────

function toolCall (callId, name, args) {
  return { type: 'tool/call', data: { callId, name, arguments: JSON.stringify(args) } }
}

function toolResult (callId, payload, isError = false) {
  return {
    type: 'tool/result',
    data: { message: { role: 'tool', toolCallId: callId, isError, content: [{ type: 'text', text: JSON.stringify(payload) }] } },
  }
}

test('the recap names what the review actually wrote', () => {
  const agent = {
    session: {
      snapshotEvents: () => [
        toolCall('c1', 'skill_manage', { operations: [{ action: 'patch', name: 'demo' }] }),
        toolResult('c1', { success: true, applied: 1, results: [{ action: 'patch', name: 'demo', message: 'Patched skill demo.' }] }),
        toolCall('c2', 'memory', { target: 'user', operations: [{ action: 'add', content: 'x' }] }),
        toolResult('c2', { success: true, applied: 1, results: [{ action: 'add' }] }),
      ],
    },
  }
  assert.deepEqual(review.collectReviewActions(agent, 'zh'), ["技能 'demo' 已修补", '用户画像已更新'])
  assert.deepEqual(review.collectReviewActions(agent, 'en'), ["Skill 'demo' patched", 'User profile updated'])
})

test('the recap ignores staged writes, failed calls, and memory targets left alone', () => {
  const agent = {
    session: {
      snapshotEvents: () => [
        toolCall('c1', 'skill_manage', { operations: [{ action: 'create', name: 'draft' }] }),
        toolResult('c1', { success: true, staged: true, pending_id: 'p1' }),
        toolCall('c2', 'memory', { target: 'memory' }),
        toolResult('c2', { success: true, applied: 1 }, true),
        toolCall('c3', 'memory', { target: 'memory' }),
        toolResult('c3', { success: true, staged: true, proposal_staged: true }),
        toolCall('c4', 'memory', { target: 'memory' }),
        toolResult('c4', { success: true, applied: 0, results: [] }),
      ],
    },
  }
  assert.deepEqual(review.collectReviewActions(agent, 'zh'), [])
})

test('the recap survives a fork that exposes no session events', () => {
  assert.deepEqual(review.collectReviewActions({ session: { snapshotEvents: () => { throw new Error('gone') } } }, 'zh'), [])
  assert.deepEqual(review.collectReviewActions({}, 'zh'), [])
})

test('the notice reports the recap when something landed', () => {
  const { session, appended } = fakeSession()
  review.appendReviewNotice(session, {
    scope: { reviewSkills: true, reviewMemory: true },
    durationMs: 27000,
    actions: ["技能 'demo' 已修补", '记忆已更新'],
    lang: 'zh',
  })
  assert.equal(appended.length, 1)
  assert.equal(appended[0].type, 'user/message')
  assert.equal(appended[0].data.source.form, 'notice')
  assert.equal(appended[0].data.source.summary, "💾 自我改进回顾：技能 'demo' 已修补 · 记忆已更新")
  assert.match(appended[0].data.content[0].text, /自我改进回顾/)
})

test('a quiet review still leaves the plain completion line', () => {
  const { session, appended } = fakeSession()
  review.appendReviewNotice(session, {
    scope: { reviewSkills: true, reviewMemory: false },
    durationMs: 3000,
    actions: [],
    lang: 'zh',
  })
  assert.equal(appended[0].data.source.summary, '背景复盘完成（skills，3s）')
})

test('delegated sessions and review forks never trigger a review', async () => {
  let fired = 0
  const { session } = fakeSession('sub-1')
  session.header.origin = 'subagent'
  const scheduler = review.createScheduler({
    hostCtx: null,
    settings: { ...SETTINGS, skillNudgeInterval: 1, memoryNudgeInterval: 1 },
    logger: { info: () => {}, debug: () => {} },
    runReview: async () => { fired += 1; return { ok: false, skipped: 'test' } },
  })
  await scheduler.onEvent(session, event('step/end', {}))
  await scheduler.onEvent(session, event('user/message', { content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await scheduler.onEvent(session, event('assistant/message', { message: { content: [{ type: 'text', text: 'done' }] } }))
  await scheduler.onEvent(session, event('turn/end', { reason: { kind: 'completed' } }))
  assert.equal(fired, 0)
})

test('writing through the tools defers the matching nudge like hermes', async () => {
  let fired = 0
  const { session } = fakeSession('tools-1')
  const scheduler = review.createScheduler({
    hostCtx: null,
    settings: { ...SETTINGS, skillNudgeInterval: 2, memoryNudgeInterval: 2 },
    logger: { info: () => {}, debug: () => {} },
    runReview: async () => { fired += 1; return { ok: false, skipped: 'test' } },
  })
  const call = (name) => event('tool/call', { callId: `c-${name}`, name, arguments: '{}' })
  const finish = async (text) => {
    await scheduler.onEvent(session, event('assistant/message', { message: { content: [{ type: 'text', text }] } }))
    await scheduler.onEvent(session, event('turn/end', { reason: { kind: 'completed' } }))
  }

  // Two iterations would fire, but the model already patched a skill.
  await scheduler.onEvent(session, event('step/end', {}))
  await scheduler.onEvent(session, call('skill_manage'))
  await scheduler.onEvent(session, event('step/end', {}))
  await finish('done')
  assert.equal(fired, 0)

  // Two user turns would fire, but the model already wrote memory.
  await scheduler.onEvent(session, event('user/message', { content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } }))
  await scheduler.onEvent(session, call('memory'))
  await scheduler.onEvent(session, event('user/message', { content: [{ type: 'text', text: 'b' }], source: { kind: 'user' } }))
  await finish('done again')
  assert.equal(fired, 0)

  // Without the tool writes the counters reach their thresholds.
  await scheduler.onEvent(session, event('step/end', {}))
  await scheduler.onEvent(session, event('user/message', { content: [{ type: 'text', text: 'c' }], source: { kind: 'user' } }))
  await finish('third')
  assert.equal(fired, 1)
})
