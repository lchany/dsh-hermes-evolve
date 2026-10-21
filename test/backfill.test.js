'use strict'

/**
 * Backfill behaviour: message reconstruction, option parsing, and the review
 * loop's stop conditions. The host is stubbed (a session store plus a review
 * function), so these tests describe the contract the plugin relies on rather
 * than the agent runtime itself.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const { mkdir, writeFile } = require('node:fs/promises')
const { dirname } = require('node:path')

const backfill = require('../src/backfill')
const { withHome } = require('./helpers')

function userEvent (text, seq = 1, kind = 'user') {
  return { type: 'user/message', seq, time: '', data: { content: [{ type: 'text', text }], source: { kind } } }
}

function assistantEvent (text, seq = 2) {
  return { type: 'assistant/message', seq, time: '', data: { message: { content: [{ type: 'reasoning', text: 'secret' }, { type: 'text', text }] } } }
}

function presentation (id, events) {
  return { header: { id, cwd: '/work', title: id }, eventCount: events.length, sizeBytes: events.length * 64 }
}

function stubHost (sessions) {
  return {
    get (name) {
      if (name !== 'sessionPersistence') return undefined
      return {
        async list () { return sessions.map((session) => presentation(session.id, session.events)) },
        async open (id) {
          const session = sessions.find((candidate) => candidate.id === id)
          if (session === undefined) throw new Error(`no session ${id}`)
          return {
            async read () { return { eventState: { revision: 1 }, events: session.events } },
            async close () {},
          }
        },
      }
    },
  }
}

function stubLogger () {
  const lines = []
  return { lines, info (line) { lines.push(line) }, warn (line) { lines.push(`warn ${line}`) }, debug () {} }
}

async function waitForStatus (predicate, timeoutMs = 5000) {
  const startedAt = Date.now()
  for (;;) {
    const status = await backfill.readStatus()
    if (predicate(status)) return status
    if (Date.now() - startedAt > timeoutMs) throw new Error(`status never matched: ${JSON.stringify(status)}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('buildMessages keeps user/assistant text and drops reasoning and foreign sources', () => {
  const messages = backfill.buildMessages([
    userEvent('hello', 1),
    assistantEvent('hi there', 2),
    { type: 'user/message', seq: 3, time: '', data: { content: [{ type: 'text', text: 'skill prompt' }], source: { kind: 'plugin' } } },
    { type: 'tool/call', seq: 4, time: '', data: { name: 'bash' } },
    { type: 'assistant/message', seq: 5, time: '', data: { message: { content: [{ type: 'reasoning', text: 'skip me' }] } } },
  ])
  assert.deepEqual(messages.map((message) => [message.role, message.content[0].text]), [
    ['user', 'hello'],
    ['assistant', 'hi there'],
  ])
})

test('parseArgs reads sub-commands and flags', () => {
  assert.deepEqual(backfill.parseArgs('status'), { sub: 'status', options: {} })
  const parsed = backfill.parseArgs('--limit 5 --workspace mapQr --no-consolidate --idle-stop 0 --dry-run')
  assert.equal(parsed.options.limit, 5)
  assert.equal(parsed.options.workspace, 'mapQr')
  assert.equal(parsed.options.consolidate, false)
  assert.equal(parsed.options.idleStop, 0)
  assert.equal(parsed.options.dryRun, true)
})

test('start() reviews sessions in turn order and stops at the limit', async () => {
  await withHome(async () => {
    const sessions = [
      { id: 's-small', events: [userEvent('q1', 1), assistantEvent('a1', 2)] },
      { id: 's-big', events: [userEvent('q1', 1), assistantEvent('a1', 2), userEvent('q2', 3), assistantEvent('a2', 4)] },
    ]
    const calls = []
    const outcome = await backfill.start({
      hostCtx: stubHost(sessions),
      settings: {},
      logger: stubLogger(),
      runReview: async (hostCtx, options) => {
        calls.push({ cwd: options.cwd, messages: options.messages.length, rewrite: options.allowMemoryRewrite })
        return { ok: true, actions: [{ tool: 'memory' }], durationMs: 5 }
      },
    }, { limit: 1 })
    assert.equal(outcome.started, true)
    const status = await waitForStatus((value) => value.running === false)
    assert.equal(status.reviewed, 1)
    assert.equal(status.stopReason, 'limit')
    assert.equal(status.actions, 1)
    // Richest session first, and the review ran with consolidation enabled.
    assert.equal(calls.length, 1)
    assert.equal(calls[0].messages, 4)
    assert.equal(calls[0].cwd, '/work')
    assert.equal(calls[0].rewrite, true)
  })
})

test('start() stops once memory reviews keep returning no actions', async () => {
  await withHome(async () => {
    const sessions = ['a', 'b', 'c'].map((name) => ({
      id: `s-${name}`,
      events: [userEvent('q', 1), assistantEvent('a', 2)],
    }))
    const outcome = await backfill.start({
      hostCtx: stubHost(sessions),
      settings: {},
      logger: stubLogger(),
      runReview: async () => ({ ok: true, actions: [], durationMs: 1 }),
    }, { idleStop: 2 })
    assert.equal(outcome.started, true)
    const status = await waitForStatus((value) => value.running === false)
    assert.equal(status.reviewed, 2)
    assert.equal(status.stopReason, 'idle-2')
  })
})

test('a finished session is not reviewed twice unless forced', async () => {
  await withHome(async () => {
    const sessions = [{ id: 's-one', events: [userEvent('q', 1), assistantEvent('a', 2)] }]
    let reviews = 0
    const deps = {
      hostCtx: stubHost(sessions),
      settings: {},
      logger: stubLogger(),
      runReview: async () => { reviews += 1; return { ok: true, actions: [{ tool: 'memory' }], durationMs: 1 } },
    }
    await backfill.start(deps, {})
    await waitForStatus((value) => value.running === false)
    await backfill.start(deps, {})
    const second = await waitForStatus((value) => value.running === false)
    assert.equal(reviews, 1)
    assert.equal(second.skipped, 1)
    await backfill.start(deps, { force: true })
    await waitForStatus((value) => value.running === false && value.reviewed === 1)
    assert.equal(reviews, 2)
  })
})

test('sessions without a real user turn are skipped, and review failures are counted', async () => {
  await withHome(async () => {
    const sessions = [
      { id: 's-empty', events: [{ type: 'user/message', seq: 1, time: '', data: { content: [{ type: 'text', text: 'plugin' }], source: { kind: 'plugin' } } }] },
      { id: 's-broken', events: [userEvent('q', 1), assistantEvent('a', 2)] },
    ]
    const outcome = await backfill.start({
      hostCtx: stubHost(sessions),
      settings: {},
      logger: stubLogger(),
      runReview: async () => ({ ok: false, error: 'model unavailable' }),
    }, { idleStop: 0 })
    assert.equal(outcome.started, true)
    const status = await waitForStatus((value) => value.running === false)
    assert.equal(status.reviewed, 1)
    assert.equal(status.failed, 1)
    assert.equal(status.skipped, 1)
    assert.equal(status.lastError, 'model unavailable')
  })
})

test('a second start while one runs is refused', async () => {
  await withHome(async () => {
    const sessions = [{ id: 's-one', events: [userEvent('q', 1), assistantEvent('a', 2)] }]
    const deps = {
      hostCtx: stubHost(sessions),
      settings: {},
      logger: stubLogger(),
      runReview: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100))
        return { ok: true, actions: [{ tool: 'memory' }], durationMs: 1 }
      },
    }
    const first = await backfill.start(deps, {})
    assert.equal(first.started, true)
    const second = await backfill.start(deps, {})
    assert.equal(second.started, false)
    await waitForStatus((value) => value.running === false)
  })
})

test('resumeRequest starts the queued run once and consumes the request', async () => {
  await withHome(async () => {
    const sessions = [{ id: 's-one', events: [userEvent('q', 1), assistantEvent('a', 2)] }]
    let reviews = 0
    const deps = {
      hostCtx: stubHost(sessions),
      settings: {},
      logger: stubLogger(),
      runReview: async () => { reviews += 1; return { ok: true, actions: [{ tool: 'memory' }], durationMs: 1 } },
    }
    await mkdir(dirname(backfill.requestPath()), { recursive: true })
    await writeFile(backfill.requestPath(), JSON.stringify({ limit: 1 }), 'utf8')
    const outcome = await backfill.resumeRequest(deps, { delayMs: 0 })
    assert.equal(outcome.started, true)
    const status = await waitForStatus((value) => value.running === false)
    assert.equal(status.reviewed, 1)
    assert.equal(reviews, 1)
    const second = await backfill.resumeRequest(deps, { delayMs: 0 })
    assert.equal(second.started, false)
    assert.match(second.error, /no queued/)
  })
})
