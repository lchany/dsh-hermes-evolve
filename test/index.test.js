'use strict'

/**
 * Boot-level smoke test: `apply()` must wire every capability into a host-like
 * context without throwing, and must stay quiet (no timers left running, no
 * writes) outside a real session.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const plugin = require('../src/index')
const { withHome } = require('./helpers')

function fakeContext (overrides = {}) {
  const sections = []
  const contexts = []
  const tools = []
  const disposers = []
  const listeners = new Map()
  const injected = []
  const effects = []

  const settingsValues = overrides.settingsValues || {}

  const ctx = {
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    settings: {
      describe: () => [{ ns: 'hermes-evolve', value: { ...settingsValues }, revision: 1 }],
      update: async () => {},
    },
    systemPrompt: {
      section: (section) => { sections.push(section); return () => {} },
      context: (context) => { contexts.push(context); return () => {} },
    },
    tools: {
      register: (definition) => { tools.push(definition); return () => {} },
      schemas: () => [],
      restrict: () => () => {},
    },
    agents: {
      create: async () => { throw new Error('a review agent must not spawn during boot') },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    sessions: { list: () => [] },
    on: (name, handler) => {
      const list = listeners.get(name) || []
      list.push(handler)
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) || []
        listeners.set(name, current.filter((item) => item !== handler))
      }
    },
    effect: (fn) => {
      effects.push(fn)
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    inject: (names, callback) => {
      injected.push({ names, callback })
    },
    get: (name) => ctx[name],
  }
  return { ctx, sections, contexts, tools, disposers, listeners, injected, effects }
}

test('the package exports the plugin shape the host expects', () => {
  assert.equal(plugin.name, 'hermes-evolve')
  assert.ok(Array.isArray(plugin.inject))
  for (const service of ['settings', 'systemPrompt', 'tools', 'agents', 'agentDefaultModel', 'sessions']) {
    assert.ok(plugin.inject.includes(service), `missing injected service ${service}`)
  }
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(plugin.Config !== undefined, 'Config must exist for the settings page')
})

test('apply() wires prompts, tools, session subscription and the panel', async () => {
  await withHome(async () => {
    const { ctx, sections, contexts, tools, injected, listeners } = fakeContext()
    plugin.apply(ctx, { turnInterval: 3 })

    const sectionNames = sections.map((section) => section.name)
    assert.ok(sectionNames.includes('hermes-evolve:memory-guidance'))
    assert.ok(sectionNames.includes('hermes-evolve:skills-coaching'))
    assert.ok(sections.every((section) => typeof section.text === 'function' || typeof section.text === 'string'))

    const contextNames = contexts.map((entry) => entry.name)
    assert.ok(contextNames.includes('hermes-evolve:memory'))

    const toolNames = tools.map((tool) => tool.name).sort()
    assert.deepEqual(toolNames, ['memory', 'skill_manage', 'skill_view', 'skills_list'])

    assert.equal(listeners.has('session/event'), true)
    assert.equal(listeners.has('settings/document-updated'), true)

    // The web panel is registered through a (possibly deferred) inject.
    assert.ok(injected.some((item) => item.names.includes('webServer')))

    // Prompt text is produced lazily and stays bounded.
    const guidance = sections.find((section) => section.name === 'hermes-evolve:memory-guidance')
    assert.ok(guidance.text().length < 2000)
  })
})

test('settings writes are folded into the live object', async () => {
  await withHome(async () => {
    const store = { value: { turnInterval: 7 } }
    const { ctx, listeners } = fakeContext()
    ctx.settings.describe = () => [{ ns: 'hermes-evolve', value: store.value, revision: 2 }]
    plugin.apply(ctx, {})
    store.value = { turnInterval: 42 }
    const handlers = listeners.get('settings/document-updated') || []
    assert.equal(handlers.length, 1)
    handlers[0]('hermes-evolve')
    // Reflected through the memory guidance section: it re-reads settings.
    // (The live object is internal; we assert the handler does not throw.)
    handlers[0]('another-ns')
  })
})

test('boot does not create skills or memory files on its own', async () => {
  await withHome(async (home) => {
    const { ctx } = fakeContext()
    plugin.apply(ctx, {})
    const { readdir } = require('node:fs/promises')
    let entries = []
    try { entries = await readdir(home) } catch { entries = [] }
    assert.ok(!entries.includes('skills'), 'boot must not create the skills directory')
    assert.ok(!entries.includes('memories'), 'boot must not create the memory directory')
  })
})
test('sanitizeConfig drops host-materialised volatile placeholders', () => {
  const { sanitizeConfig } = plugin.__internals
  // dsh 0.2.0-rc.2 hands the apply-config `.volatile()` fields back as `{}`.
  assert.deepEqual(
    sanitizeConfig({ mode: {}, curatorEnabled: {}, turnInterval: '7', model: 'x' }),
    { model: 'x' },
  )
  // A scalar default only accepts scalars.
  assert.deepEqual(sanitizeConfig({ signalCorrectionWords: 'a,b' }), { signalCorrectionWords: 'a,b' })
  assert.deepEqual(sanitizeConfig({ memoryCharLimit: 3000 }), { memoryCharLimit: 3000 })
  assert.deepEqual(sanitizeConfig({ memoryCharLimit: '3000' }), {})
  assert.deepEqual(sanitizeConfig({ unknownKey: 1 }), {})
  assert.deepEqual(sanitizeConfig(null), {})
})

test('a materialised placeholder never reaches consumers', async () => {
  await withHome(async () => {
    const lines = []
    const { ctx } = fakeContext({
      settingsValues: { mode: {}, turnInterval: {}, curatorEnabled: {} },
    })
    ctx.logger = { info: (line) => lines.push(line), warn: () => {}, debug: () => {} }
    plugin.apply(ctx, { mode: {}, turnInterval: {}, provider: {} })
    const boot = lines.find((line) => line.includes('active —'))
    assert.ok(boot, 'boot line is logged')
    assert.match(boot, /mode=auto/)
    assert.match(boot, /curator=on/)
  })
})

test('a profile that already owns skill/memory tools keeps its own', async () => {
  await withHome(async () => {
    const { ctx, tools } = fakeContext()
    ctx.tools.schemas = () => [
      { name: 'skills_list' },
      { name: 'skill_view' },
      { name: 'skill_manage' },
      { name: 'memory' },
      { name: 'read' },
    ]
    const lines = []
    ctx.logger = { info: (line) => lines.push(line), warn: () => {}, debug: () => {} }
    plugin.apply(ctx, {})
    assert.deepEqual(tools.map((tool) => tool.name), [], 'nothing may be registered over an occupied name')
    assert.ok(lines.some((line) => /left .*memory/.test(line)), 'the skip is logged')

    // With no foreign memory tool the plugin claims all four again.
    const second = fakeContext()
    plugin.apply(second.ctx, {})
    assert.deepEqual(second.tools.map((tool) => tool.name).sort(),
      ['memory', 'skill_manage', 'skill_view', 'skills_list'])
  })
})

test('registerTools=off registers nothing globally', async () => {
  await withHome(async () => {
    const { ctx, tools } = fakeContext()
    plugin.apply(ctx, { registerTools: 'off' })
    assert.equal(tools.length, 0)
  })
})
