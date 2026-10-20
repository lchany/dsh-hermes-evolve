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
const { mkdir, readFile, utimes, writeFile } = require('node:fs/promises')
const { join } = require('node:path')

const { withHome } = require('./helpers')
const panel = require('../src/panel')
const memory = require('../src/memory')
const store = require('../src/skill_store')
const util = require('../src/util')
const curator = require('../src/curator')
const usageMod = require('../src/skill_usage')

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
const STAGED_SKILL_MD = `---
name: pdf-toolkit
description: Extract text and tables from PDF files without losing layout.
---

# PDF toolkit

## When to Use

When the user hands you a PDF and wants its text.
`

test('an approved staged skill batch is replayed and marked approved', async () => {
  await withHome(async (home) => {
    const row = await store.stagePending({
      kind: 'skill',
      operations: [{ action: 'create', name: 'pdf-toolkit', content: STAGED_SKILL_MD }],
      gist: "create 'pdf-toolkit'",
      agentCreated: true,
      actor: 'background-review',
    })
    const server = fakeServer()
    panel.registerPanelRoutes(server, deps())
    const outcome = await call(server.routes, 'POST', '/hermes-evolve/api/pending', { id: row.id, decision: 'approved' })
    assert.equal(outcome.status, 200, JSON.stringify(outcome.json))
    assert.equal(outcome.json.applied, true)
    assert.equal(outcome.json.result.applied, 1)
    assert.match(await readFile(join(home, 'skills', 'pdf-toolkit', 'SKILL.md'), 'utf8'), /# PDF toolkit/)
    assert.equal((await store.listPending())[0].status, 'approved')
    // Provenance survives the approval boundary.
    const usage = await usageMod.loadUsage()
    assert.equal(usage['pdf-toolkit'].created_by, 'agent')
  })
})

test('a staged skill batch that no longer applies stays pending with the error', async () => {
  await withHome(async () => {
    const row = await store.stagePending({
      kind: 'skill',
      operations: [{ action: 'patch', name: 'ghost', old_string: 'a', new_string: 'b' }],
      agentCreated: true,
    })
    const server = fakeServer()
    panel.registerPanelRoutes(server, deps())
    const outcome = await call(server.routes, 'POST', '/hermes-evolve/api/pending', { id: row.id, decision: 'approved' })
    assert.equal(outcome.status, 409)
    assert.match(outcome.json.error, /Skill 'ghost' not found/)
    // Still pending: a human must read the error and decide.
    assert.equal((await store.listPending())[0].status, 'pending')
  })
})

test('the panel pins and unpins agent-created skills', async () => {
  await withHome(async () => {
    await usageMod.recordCreated('pdf-toolkit', { agentCreated: true })
    const server = fakeServer()
    panel.registerPanelRoutes(server, deps())

    let outcome = await call(server.routes, 'POST', '/hermes-evolve/api/skills/pin', { name: 'pdf-toolkit', pinned: true })
    assert.equal(outcome.status, 200, JSON.stringify(outcome.json))
    assert.equal(outcome.json.pinned, true)
    assert.equal(outcome.json.message, "pinned 'pdf-toolkit' (will bypass auto-transitions)")
    assert.equal((await usageMod.loadUsage())['pdf-toolkit'].pinned, true)

    outcome = await call(server.routes, 'POST', '/hermes-evolve/api/skills/pin', { name: 'pdf-toolkit', pinned: false })
    assert.equal(outcome.json.message, "unpinned 'pdf-toolkit'")
    assert.equal((await usageMod.loadUsage())['pdf-toolkit'].pinned, false)

    // Bundled / unmanaged skills are refused, as the CLI does.
    outcome = await call(server.routes, 'POST', '/hermes-evolve/api/skills/pin', { name: 'not-a-skill', pinned: true })
    assert.equal(outcome.status, 409)
    assert.match(outcome.json.error, /bundled or hub-installed — cannot pin/)
  })
})

test('purge refuses without a TTL and removes archives past it', async () => {
  await withHome(async (home) => {
    const archive = join(home, 'skills', '.archive', 'old-skill')
    await mkdir(archive, { recursive: true })
    await writeFile(join(archive, 'SKILL.md'), '---\nname: old-skill\ndescription: Old skill.\n---\n\n# old\n')
    await utimes(archive, new Date(0), new Date(0))

    const server = fakeServer()
    panel.registerPanelRoutes(server, deps())

    let outcome = await call(server.routes, 'POST', '/hermes-evolve/api/skills/purge', { days: 0 })
    assert.equal(outcome.status, 400)
    assert.match(outcome.json.error, /^curator: purge disabled \(curator\.archive_ttl_days is 0\)/)

    outcome = await call(server.routes, 'POST', '/hermes-evolve/api/skills/purge', { days: 30, dryRun: true })
    assert.equal(outcome.status, 200)
    assert.deepEqual(outcome.json.candidates, ['old-skill'])
    assert.deepEqual(outcome.json.purged, [])
    assert.equal(await exists(join(archive, 'SKILL.md')), true, 'a dry run deletes nothing')

    outcome = await call(server.routes, 'POST', '/hermes-evolve/api/skills/purge', { days: 30 })
    assert.equal(outcome.status, 200)
    assert.deepEqual(outcome.json.purged, ['old-skill'])
    assert.equal(await exists(join(archive, 'SKILL.md')), false)
  })
})

async function exists (path) {
  try { await require('node:fs/promises').access(path); return true } catch { return false }
}
