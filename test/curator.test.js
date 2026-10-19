'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { mkdir, writeFile, readFile, access } = require('node:fs/promises')

const curator = require('../src/curator')
const usage = require('../src/skill_usage')
const { withHome } = require('./helpers')

const DAY = 86_400_000
const iso = (daysAgo, now = Date.now()) => new Date(now - daysAgo * DAY).toISOString()

const SETTINGS = {
  curatorEnabled: true,
  curatorIntervalHours: 24 * 7,
  curatorConsolidate: false,
  curatorStaleDays: 14,
  curatorArchiveDays: 30,
  curatorBackupKeep: 2,
}

async function mkSkill (home, name, description = 'Test skill.') {
  const dir = join(home, 'skills', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n## Procedure\n\n1. Do the thing.\n`, 'utf8')
}

test('refuses an archive window shorter than the stale window', async () => {
  await withHome(async () => {
    const result = await curator.deterministicPass({ settings: { curatorStaleDays: 30, curatorArchiveDays: 14 } })
    assert.equal(result.ok, false)
    assert.match(result.error, /must be >=/)
  })
})

test('the first run only seeds the clock; the second is not due yet', async () => {
  await withHome(async (home) => {
    await mkSkill(home, 'seed-me')
    const first = await curator.runCurator({ settings: SETTINGS })
    assert.equal(first.ok, true)
    assert.equal(first.skipped, 'seeded')
    assert.match(first.summary, /deferred first run/)

    const second = await curator.runCurator({ settings: SETTINGS })
    assert.equal(second.ok, false)
    assert.equal(second.skipped, 'not-due')

    const state = await curator.loadState()
    assert.notEqual(state.last_run_at, null)
    assert.equal(state.paused, false)
  })
})

test('a forced run archives an inactive managed skill and keeps the fresh one', async () => {
  await withHome(async (home) => {
    await mkSkill(home, 'old-skill')
    await mkSkill(home, 'fresh-skill')
    await usage.saveUsage({
      'old-skill': {
        ...usage.emptyRecord(),
        created_by: 'agent',
        use_count: 4,
        created_at: iso(60),
        first_seen_at: iso(60),
        last_used_at: iso(40),
        state: 'active',
      },
    })

    await curator.runCurator({ settings: SETTINGS }) // seeds
    const result = await curator.runCurator({ settings: SETTINGS, force: true })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.automatic.archived.length, 1)
    assert.equal(result.automatic.archived[0].name, 'old-skill')

    assert.equal(await exists(join(home, 'skills', 'old-skill')), false)
    assert.equal(await exists(join(home, 'skills', '.archive', 'old-skill', 'SKILL.md')), true)
    assert.equal(await exists(join(home, 'skills', 'fresh-skill', 'SKILL.md')), true)

    const persisted = await usage.loadUsage()
    assert.equal(persisted['old-skill'].state, 'archived')
    assert.equal(persisted['fresh-skill'].state, 'active')

    const report = await readFile(result.reportPath, 'utf8')
    assert.match(report, /Deterministic transitions/)
    assert.match(report, /old-skill/)

    const state = await curator.loadState()
    assert.equal(state.run_count, 1)
    assert.equal(state.last_automatic.archived[0], 'old-skill')
  })
})

test('an unmanaged skill is never archived by the curator', async () => {
  await withHome(async (home) => {
    await mkSkill(home, 'hand-written')
    await usage.saveUsage({
      'hand-written': {
        ...usage.emptyRecord(),
        created_by: 'learn',
        use_count: 2,
        created_at: iso(90),
        first_seen_at: iso(90),
        last_used_at: iso(90),
        state: 'active',
      },
    })
    await curator.runCurator({ settings: SETTINGS })
    const result = await curator.runCurator({ settings: SETTINGS, force: true })
    assert.equal(result.automatic.archived.length, 0)
    assert.equal(await exists(join(home, 'skills', 'hand-written', 'SKILL.md')), true)
  })
})

test('reconcile separates verified consolidations from unexplained removals', () => {
  const before = ['a', 'b', 'c', 'd', 'e', 'f']
  const after = ['umbrella', 'e', 'f']
  const deletes = [
    { skill: 'a', absorbedInto: 'umbrella' },
    { skill: 'b', absorbedInto: '' },
    { skill: 'c', absorbedInto: 'umbrella' },
  ]
  const result = curator.reconcile({ before, after, deletes })
  assert.deepEqual(result.removed, ['a', 'b', 'c', 'd'])
  assert.deepEqual(result.consolidated, [{ from: 'a', into: 'umbrella' }, { from: 'c', into: 'umbrella' }])
  assert.deepEqual(result.pruned, [{ name: 'b' }])
  assert.deepEqual(result.unexplained, ['d'])
  assert.equal(result.suspicious, false)

  const bad = curator.reconcile({ before: ['a', 'b', 'c', 'd', 'e', 'f'], after: ['f'], deletes: [] })
  assert.equal(bad.suspicious, true)
})

test('pinning keeps a skill out of the archive', async () => {
  await withHome(async (home) => {
    await mkSkill(home, 'pinned-skill')
    await usage.saveUsage({
      'pinned-skill': {
        ...usage.emptyRecord(),
        created_by: 'agent',
        pinned: true,
        use_count: 1,
        created_at: iso(90),
        first_seen_at: iso(90),
        last_used_at: iso(90),
        state: 'active',
      },
    })
    await curator.runCurator({ settings: SETTINGS })
    const result = await curator.runCurator({ settings: SETTINGS, force: true })
    assert.equal(result.automatic.archived.length, 0)
  })
})

async function exists (path) {
  try { await access(path); return true } catch { return false }
}