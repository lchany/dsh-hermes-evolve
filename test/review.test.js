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
  mode: 'log-only',
  memoryMode: 'inherit',
  skillsMode: 'inherit',
  memoryEnabled: true,
  turnInterval: 2,
  toolCallInterval: 2,
  language: 'en',
}

function event (type, data) {
  return { type, data, seq: 0, at: new Date().toISOString() }
}

test('a review fires only after the iteration threshold and a completed turn', async () => {
  const logs = []
  const { session } = fakeSession()
  const scheduler = review.createScheduler({
    hostCtx: null,
    settings: SETTINGS,
    logger: { info: (line) => logs.push(line), debug: () => {} },
  })

  // One tool iteration is not enough.
  await scheduler.onEvent(session, event('step/end', {}))
  await scheduler.onEvent(session, event('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
  await scheduler.onEvent(session, event('assistant/message', { message: { content: [{ type: 'text', text: 'done' }] } }))
  await scheduler.onEvent(session, event('turn/end', { reason: { kind: 'completed' } }))
  assert.equal(logs.length, 0)

  // The second iteration crosses turnInterval=2.
  await scheduler.onEvent(session, event('step/end', {}))
  await scheduler.onEvent(session, event('step/end', {}))
  await scheduler.onEvent(session, event('user/message', { content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
  await scheduler.onEvent(session, event('assistant/message', { message: { content: [{ type: 'text', text: 'done again' }] } }))
  await scheduler.onEvent(session, event('turn/end', { reason: { kind: 'completed' } }))
  assert.equal(logs.length, 1)
  assert.match(logs[0], /log-only: would review/)
})

test('an interrupted or empty turn never triggers a review', async () => {
  const logs = []
  const { session } = fakeSession()
  const scheduler = review.createScheduler({
    hostCtx: null,
    settings: { ...SETTINGS, turnInterval: 1 },
    logger: { info: (line) => logs.push(line), debug: () => {} },
  })
  await scheduler.onEvent(session, event('step/end', {}))
  await scheduler.onEvent(session, event('user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
  await scheduler.onEvent(session, event('turn/end', { reason: { kind: 'aborted', reason: 'user' } }))
  assert.equal(logs.length, 0)
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
  const rendered = review.renderTranscript(messages, { maxChars: 2000, maxMessages: 10, lang: 'en' })
  assert.match(rendered, /message 59/)
  assert.doesNotMatch(rendered, /message 0\n/)
  assert.ok(rendered.length <= 2100)
})

test('suspect ranking prefers skills named in the transcript', () => {
  const catalog = [
    { name: 'pdf-toolkit', description: 'extract text from PDF files' },
    { name: 'deploy-ops', description: 'deploy services with kubernetes' },
    { name: 'unrelated', description: 'nothing in common' },
  ]
  const ranked = review.rankSuspects(catalog, 'the pdf-toolkit skill broke when parsing', { topN: 2 })
  assert.equal(ranked[0].name, 'pdf-toolkit')
  assert.ok(ranked.length <= 2)
  assert.ok(!ranked.some((entry) => entry.name === 'unrelated'))
  assert.deepEqual(review.rankSuspects(catalog, 'completely orthogonal words', { topN: 2 }), [])
})