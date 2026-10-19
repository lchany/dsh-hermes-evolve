'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const usage = require('../src/skill_usage')
const { withHome } = require('./helpers')

const DAY = 86_400_000
const iso = (offsetDays, now = Date.now()) => new Date(now - offsetDays * DAY).toISOString()

function record (overrides = {}) {
  return { ...usage.emptyRecord(), ...overrides }
}

test('a never-used skill younger than the stale line is left alone', async () => {
  await withHome(async () => {
    const now = Date.now()
    const records = new Map([['fresh', record({ created_at: iso(2, now), first_seen_at: iso(2, now) })]])
    const result = await usage.applyAutomaticTransitions({
      records, now, staleDays: 14, archiveDays: 30,
      archive: () => { throw new Error('must not archive a young, never-used skill') },
    })
    assert.equal(result.marked_stale, 0)
    assert.equal(result.archived, 0)
  })
})

test('inactivity crosses stale then archive', async () => {
  await withHome(async () => {
    const now = Date.now()
    const stale = record({ created_at: iso(20, now), last_used_at: iso(20, now), use_count: 2 })
    const old = record({ created_at: iso(60, now), last_used_at: iso(40, now), use_count: 5 })
    const records = new Map([['stale-one', stale], ['old-one', old]])
    const archived = []
    const result = await usage.applyAutomaticTransitions({
      records, now, staleDays: 14, archiveDays: 30,
      archive: (name) => { archived.push(name); return true },
    })
    assert.equal(result.marked_stale, 1)
    assert.deepEqual(archived, ['old-one'])
    assert.equal(result.archived, 1)
    const persisted = await usage.loadUsage()
    assert.equal(persisted['stale-one'].state, 'stale')
    assert.equal(persisted['old-one'].state, 'archived')
  })
})

test('pinned and unmanaged records never transition', async () => {
  await withHome(async () => {
    const now = Date.now()
    const records = new Map([
      ['pinned', record({ last_used_at: iso(90, now), use_count: 1, pinned: true })],
      ['unmanaged', record({ last_used_at: iso(90, now), use_count: 1, created_by: 'learn' })],
    ])
    const archived = []
    const result = await usage.applyAutomaticTransitions({
      records, now, staleDays: 14, archiveDays: 30,
      isManaged: (name) => name !== 'unmanaged',
      archive: (name) => { archived.push(name); return true },
    })
    assert.deepEqual(archived, [])
    assert.equal(result.archived, 0)
  })
})

test('a corrupt timestamp fails safe instead of transitioning', async () => {
  await withHome(async () => {
    const now = Date.now()
    const records = new Map([['bad', record({ last_used_at: 'not-a-date', use_count: 3 })]])
    const result = await usage.applyAutomaticTransitions({
      records, now, staleDays: 14, archiveDays: 30,
      archive: () => { throw new Error('must not archive on a corrupt timestamp') },
    })
    assert.equal(result.archived, 0)
    assert.equal(result.marked_stale, 0)
  })
})

test('created_at alone is not activity', () => {
  const rec = usage.emptyRecord()
  rec.created_at = iso(100)
  assert.equal(usage.latestActivityAt(rec), null)
})

test('isCuratorManagedRecord tracks created_by/agent_created', () => {
  assert.equal(usage.isCuratorManagedRecord({ created_by: 'agent' }), true)
  assert.equal(usage.isCuratorManagedRecord({ created_by: 'learn' }), false)
  assert.equal(usage.isCuratorManagedRecord({ created_by: 'learn', agent_created: true }), true)
  assert.equal(usage.isCuratorManagedRecord(null), false)
})