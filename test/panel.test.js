'use strict'

/**
 * The panel is plain routes on the host web server, so it can be exercised
 * without a browser: register it against a stub server, then drive the handler
 * with fake requests. Covers the two behaviours that only exist here — the
 * status payload and an approved memory write actually reaching disk.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')

const { withHome } = require('./helpers')
const panel = require('../src/panel')
const memory = require('../src/memory')
const store = require('../src/skill_store')
const util = require('../src/util')
const curator = require('../src/curator')

function fakeServer () {
  const routes = []
  return {
    routes,
    webServer: {
      register (route) { routes.push(route); return () => {} },
    },
  }
}

function fakeRequest (method, url, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const stream = Readable.from(payload === '' ? [] : [Buffer.from(payload)])
  stream.method = method
  stream.url = url
  return stream
}

function fakeResponse () {
  const out = { status: 0, headers: {}, body: '' }
  return {
    out,
    writeHead (status, headers) { out.status = status; out.headers = headers },
    end (body) { out.body = body || '' },
  }
}

async function call (routes, method, url, body) {
  const route = [...routes].sort((a, b) => b.path.length - a.path.length).find((entry) => url.startsWith(entry.path))
  assert.ok(route, `no route for ${url}`)
  const res = fakeResponse()
  await route.handler(fakeRequest(method, url, body), res)
  const json = res.out.body.trimStart().startsWith('{') ? JSON.parse(res.out.body) : undefined
  return { status: res.out.status, json, body: res.out.body }
}

function deps (pluginServer) {
  return {
    pluginCtx: { settings: { update: async () => {} } },
    settings: { enabled: true, mode: 'auto' },
    settingsNs: 'hermes-evolve',
    logger: { warn () {}, info () {} },
    refreshMemoryCache: async () => {},
    readMemoryText: () => '',
    curatorStatus: { running: false, lastActivityAt: null, lastResult: null },
    runCuratorNow: async () => ({ ok: true }),
    curatorModule: curator,
  }
}

test('panel serves status and the HTML page', async () => {
  await withHome(async () => {
    const server = fakeServer()
    panel.registerPanelRoutes(server, deps())
    assert.deepEqual(server.routes.map((route) => route.path).sort(),
      ['/hermes-evolve', '/hermes-evolve/api'])
    const status = await call(server.routes, 'GET', '/hermes-evolve/api/status')
    assert.equal(status.status, 200)
    assert.equal(status.json.plugin, 'hermes-evolve')
    assert.match(status.json.version, /^\d+\.\d+\.\d+$/)
    assert.equal(status.json.store.skills, util.skillsDir())
    const page = await call(server.routes, 'GET', '/hermes-evolve')
    assert.equal(page.status, 200)
    assert.match(page.body, /<title>hermes-evolve<\/title>/)
  })
})

test('an approved memory pending write reaches MEMORY.md', async () => {
  await withHome(async () => {
    await memory.writeMemory(util.memoryDir(), 'memory', [{ action: 'add', text: 'Old fact', oldText: '' }], { limit: 2200 })
    const row = await store.stagePending({
      kind: 'memory',
      target: 'memory',
      limit: 2200,
      operations: [{ action: 'replace', text: 'New fact', oldText: 'Old fact' }],
      actor: 'background-review',
    })
    const server = fakeServer()
    panel.registerPanelRoutes(server, deps())
    const outcome = await call(server.routes, 'POST', '/hermes-evolve/api/pending', { id: row.id, decision: 'approved' })
    assert.equal(outcome.status, 200)
    assert.equal(outcome.json.applied, true)
    const stored = await memory.readStore(util.memoryDir(), 'memory')
    assert.deepEqual(stored.entries, ['New fact'])
    const pending = await store.listPending()
    assert.equal(pending[0].status, 'approved')
  })
})

test('a rejected pending write changes nothing', async () => {
  await withHome(async () => {
    const row = await store.stagePending({
      kind: 'memory',
      target: 'memory',
      limit: 2200,
      operations: [{ action: 'add', text: 'Never lands', oldText: '' }],
    })
    const server = fakeServer()
    panel.registerPanelRoutes(server, deps())
    const outcome = await call(server.routes, 'POST', '/hermes-evolve/api/pending', { id: row.id, decision: 'rejected' })
    assert.equal(outcome.status, 200)
    const stored = await memory.readStore(util.memoryDir(), 'memory')
    assert.deepEqual(stored.entries, [])
    const pending = await store.listPending()
    assert.equal(pending[0].status, 'rejected')
  })
})