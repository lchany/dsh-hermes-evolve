'use strict'

/**
 * The five Hermes Desktop commands: `/skills`, `/memory`, `/curator`,
 * `/refine`, `/learn`. Each test drives the registered handler exactly the way
 * the host does (inline `rawInput`, no model), so the asserted text is what the
 * user would read in the chat.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { join } = require('node:path')

const { withHome } = require('./helpers')
const commands = require('../src/commands')
const store = require('../src/skill_store')
const memory = require('../src/memory')
const learnPrompt = require('../src/learn_prompt')
const skillUsage = require('../src/skill_usage')
const { readFile } = require('node:fs/promises')

const SKILL_MD = `---
name: pdf-toolkit
description: Extract text and tables from PDF files without losing layout.
---

# PDF toolkit

## When to Use

When the user hands you a PDF and wants its text.
`

function makeDeps (overrides = {}) {
  const persisted = []
  const curatorRuns = []
  const reviews = []
  const deps = {
    settings: {
      skillsWriteApproval: false,
      memoryWriteApproval: false,
      curatorEnabled: true,
      curatorIntervalHours: 168,
      curatorStaleDays: 14,
      curatorArchiveDays: 30,
      curatorConsolidate: false,
    },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    hostCtx: {},
    persistSettings: async (patch) => {
      persisted.push(patch)
      Object.assign(deps.settings, patch)
    },
    runCuratorNow: async (options) => {
      curatorRuns.push(options)
      return { ok: true, automatic: { ok: true, checked: 2, markedStale: 1, archived: [], reactivated: 0 } }
    },
    runReview: async (hostCtx, options) => {
      reviews.push(options)
      return { ok: true }
    },
    hasSkillManage: () => true,
    learnPrompt,
    randomId: () => 'learn-message-1',
    ...overrides,
  }
  return { deps, persisted, curatorRuns, reviews }
}

async function run (deps, name, rawInput, agent = undefined) {
  const definition = commands.definitions(deps).find((entry) => entry.name === name)
  assert.ok(definition, `/${name} must be registered`)
  return definition.handler({ rawInput, agent })
}

/** Seed a memory store the way the tool path would have. */
async function seedMemory (home, entries) {
  const outcome = await memory.writeMemory(join(home, 'memories'), 'memory',
    entries.map((text) => ({ action: 'add', text })), { limit: 2200 })
  assert.equal(outcome.ok, true)
}

test('the five Hermes-surface commands are registered in order', () => {
  const { deps } = makeDeps()
  const names = commands.definitions(deps).map((definition) => definition.name)
  assert.deepEqual(names, ['skills', 'memory', 'curator', 'refine', 'learn'])
  for (const definition of commands.definitions(deps)) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 0)
  }
})

test('/skills with no arguments reports the gate and the empty queue', async () => {
  await withHome(async () => {
    const { deps } = makeDeps()
    const result = await run(deps, 'skills', '')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /^skills\.write_approval = off\n/)
    assert.match(result.text, /No pending skills writes\./)
  })
})

test('/skills approval on persists the boolean through the settings document', async () => {
  await withHome(async () => {
    const { deps, persisted } = makeDeps()
    const result = await run(deps, 'skills', ' approval on')
    assert.equal(result.kind, 'success')
    assert.equal(result.text, "skills.write_approval set to 'on'.")
    assert.deepEqual(persisted, [{ skillsWriteApproval: true }])
    assert.equal(deps.settings.skillsWriteApproval, true)
    assert.equal((await run(deps, 'skills', ' approval')).text,
      'skills.write_approval = on\nSet with: /skills approval <on|off>')
  })
})

test('/memory approval rejects an unknown value', async () => {
  await withHome(async () => {
    const { deps, persisted } = makeDeps()
    const result = await run(deps, 'memory', ' approval sometimes')
    assert.equal(result.kind, 'success')
    assert.equal(result.text, "Invalid value 'sometimes'. Use: on or off.")
    assert.deepEqual(persisted, [])
  })
})

test('/memory approve applies a pinned replace and prints the whole overwritten entry', async () => {
  await withHome(async (home) => {
    await seedMemory(home, ['Old fact about the project', 'Another fact'])
    const row = await store.stagePending({
      kind: 'memory',
      target: 'memory',
      limit: 2200,
      actor: 'background-review',
      summary: 'replace one note',
      operations: [{
        action: 'replace',
        oldText: 'Old fact',
        text: 'New fact about the project',
        matched_entry: 'Old fact about the project',
      }],
    })

    const { deps } = makeDeps()
    const result = await run(deps, 'memory', ` approve ${row.id}`)
    assert.equal(result.kind, 'success')
    assert.equal(result.text, 'Approved 1 memory write(s).\nOverwrote entire entry (re-add anything you still need):\n  ' + row.id + ': Old fact about the project')

    const loaded = await memory.readStore(join(home, 'memories'), 'memory')
    assert.deepEqual(loaded.entries, ['New fact about the project', 'Another fact'])
    const rows = await store.listPending()
    assert.equal(rows.find((entry) => entry.id === row.id).status, 'approved')
  })
})

test('/memory approve refuses a pinned entry that changed after staging', async () => {
  await withHome(async (home) => {
    await seedMemory(home, ['Pinned fact', 'Other'])
    const row = await store.stagePending({
      kind: 'memory',
      target: 'memory',
      limit: 2200,
      actor: 'background-review',
      summary: 'remove pinned fact',
      operations: [{ action: 'remove', oldText: 'Pinned fact', matched_entry: 'Pinned fact' }],
    })
    // The user edited the entry between staging and approval.
    await memory.writeMemory(join(home, 'memories'), 'memory', [
      { action: 'replace', oldText: 'Pinned fact', text: 'Pinned fact, now longer' },
    ], { limit: 2200 })

    const { deps } = makeDeps()
    const result = await run(deps, 'memory', ` approve ${row.id}`)
    assert.match(result.text, /^Approved 0 memory write\(s\)\./)
    assert.match(result.text, /Failed:\n {2}/)
    assert.match(result.text, /no longer exists/)
    assert.deepEqual((await memory.readStore(join(home, 'memories'), 'memory')).entries, ['Pinned fact, now longer', 'Other'])
    const rows = await store.listPending()
    assert.equal(rows.find((entry) => entry.id === row.id).status, 'pending', 'a failed approval stays pending')
  })
})

test('/memory pending lists the matched entry so the approver sees the target', async () => {
  await withHome(async (home) => {
    await seedMemory(home, ['Secret plan'])
    await store.stagePending({
      kind: 'memory',
      target: 'memory',
      limit: 2200,
      actor: 'background-review',
      summary: 'remove the plan',
      operations: [{ action: 'remove', oldText: 'Secret plan', matched_entry: 'Secret plan' }],
    })
    const { deps } = makeDeps()
    const result = await run(deps, 'memory', ' pending')
    assert.match(result.text, /^Pending memory writes \(1\):/)
    assert.match(result.text, /\[auto\]  remove the plan/)
    assert.match(result.text, /removes entry: Secret plan/)
  })
})

test('/memory reject all closes the queue without touching the store', async () => {
  await withHome(async (home) => {
    await seedMemory(home, ['Kept'])
    await store.stagePending({
      kind: 'memory',
      target: 'memory',
      limit: 2200,
      actor: 'background-review',
      summary: 'drop it',
      operations: [{ action: 'remove', oldText: 'Kept', matched_entry: 'Kept' }],
    })
    const { deps } = makeDeps()
    const result = await run(deps, 'memory', ' reject all')
    assert.equal(result.text, 'Rejected 1 pending memory write(s).')
    assert.deepEqual((await memory.readStore(join(home, 'memories'), 'memory')).entries, ['Kept'])
    assert.equal((await store.listPending()).every((row) => row.status === 'rejected'), true)
  })
})

test('/skills diff renders the staged edit as a unified diff', async () => {
  await withHome(async () => {
    const row = await store.stagePending({
      kind: 'skill',
      summary: 'edit demo skill',
      operations: [{ action: 'edit', name: 'demo', file_path: 'SKILL.md', content: '---\nname: demo\n---\nnew body' }],
    })
    const { deps } = makeDeps()
    const result = await run(deps, 'skills', ` diff ${row.id}`)
    assert.equal(result.kind, 'success')
    assert.match(result.text, /^# Pending skill write .*: edit demo skill/)
    assert.match(result.text, /^\+\+\+ b\/SKILL\.md$/m)
    assert.match(result.text, /^\+new body$/m)
  })
})

test('/skills approve replays a staged create and keeps its provenance', async () => {
  await withHome(async (home) => {
    const row = await store.stagePending({
      kind: 'skill',
      operations: [{ action: 'create', name: 'pdf-toolkit', content: SKILL_MD }],
      gist: "create 'pdf-toolkit'",
      agentCreated: true,
      actor: 'background-review',
    })
    const { deps } = makeDeps()
    const result = await run(deps, 'skills', ` approve ${row.id}`)
    assert.equal(result.kind, 'success')
    assert.equal(result.text, 'Approved 1 skills write(s).')
    assert.match(await readFile(join(home, 'skills', 'pdf-toolkit', 'SKILL.md'), 'utf8'), /# PDF toolkit/)
    const usage = await skillUsage.loadUsage()
    assert.equal(usage['pdf-toolkit'].created_by, 'agent')
    assert.equal((await store.listPending())[0].status, 'approved')
  })
})

test('/skills approve all reports the ids it could not land', async () => {
  await withHome(async () => {
    const good = await store.stagePending({
      kind: 'skill',
      operations: [{ action: 'create', name: 'ok-skill', content: SKILL_MD.replace(/pdf-toolkit/g, 'ok-skill') }],
      gist: "create 'ok-skill'",
    })
    const bad = await store.stagePending({
      kind: 'skill',
      // An edit of a skill that no longer exists cannot be replayed.
      operations: [{ action: 'patch', name: 'gone-skill', file_path: 'SKILL.md', old_string: 'a', new_string: 'b' }],
      gist: "patch 'gone-skill'",
    })
    const { deps } = makeDeps()
    const result = await run(deps, 'skills', ' approve all')
    assert.match(result.text, /^Approved 1 skills write\(s\)\./)
    assert.match(result.text, new RegExp(`Failed:\n {2}${bad.id}: `))
    const rows = await store.listPending()
    assert.equal(rows.find((row) => row.id === good.id).status, 'approved')
    assert.equal(rows.find((row) => row.id === bad.id).status, 'pending')
  })
})

test('/curator status prints the gate, counters and no managed skills', async () => {
  await withHome(async () => {
    const { deps } = makeDeps()
    const result = await run(deps, 'curator', '')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /^curator: ENABLED\n {2}runs: {11}0/)
    assert.match(result.text, /last run: {7}never/)
    assert.match(result.text, /interval: {7}every 7d/)
    assert.match(result.text, /consolidate: {4}off \(prune-only; LLM merge pass opt-in\)/)
    assert.match(result.text, /no curator-managed skills/)
  })
})

test('/curator run forwards the dry-run flag and reports the preview', async () => {
  await withHome(async () => {
    const { deps, curatorRuns } = makeDeps()
    const result = await run(deps, 'curator', ' run --dry-run')
    assert.equal(curatorRuns.length, 1)
    assert.equal(curatorRuns[0].dryRun, true)
    assert.match(result.text, /running DRY-RUN/)
    assert.match(result.text, /auto \(preview\): 2 candidate skill\(s\)/)
    assert.match(result.text, /no changes applied/)
  })
})

test('/curator run refuses when curation is disabled', async () => {
  await withHome(async () => {
    const { deps, curatorRuns } = makeDeps()
    deps.settings.curatorEnabled = false
    const result = await run(deps, 'curator', ' run')
    assert.match(result.text, /^curator: disabled via config/)
    assert.equal(curatorRuns.length, 0)
  })
})

test('/curator pause and resume persist the paused flag', async () => {
  await withHome(async () => {
    const { deps } = makeDeps()
    assert.equal((await run(deps, 'curator', ' pause')).text, 'curator: paused')
    assert.equal((await run(deps, 'curator', ' status')).text.includes('curator: PAUSED'), true)
    assert.equal((await run(deps, 'curator', ' resume')).text, 'curator: resumed')
    assert.equal((await run(deps, 'curator', ' status')).text.includes('curator: ENABLED'), true)
  })
})

test('/curator pin rejects a skill the curator does not manage', async () => {
  await withHome(async () => {
    const { deps } = makeDeps()
    const result = await run(deps, 'curator', ' pin human-made')
    assert.equal(result.text, "curator: 'human-made' is bundled or hub-installed — cannot pin (only agent-created skills participate in curation).")
  })
})

test('/refine says there is nothing to refine when the conversation is empty', async () => {
  await withHome(async () => {
    const { deps, reviews } = makeDeps()
    const agent = { session: { deriveMessages: () => [], header: { cwd: '/tmp' } } }
    const result = await run(deps, 'refine', '', agent)
    assert.equal(result.text, 'Nothing to refine yet — the conversation is empty.')
    assert.equal(reviews.length, 0)
  })
})

test('/refine starts a background review with the focus text', async () => {
  await withHome(async () => {
    const { deps, reviews } = makeDeps()
    const agent = {
      session: {
        deriveMessages: () => [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }],
        header: { cwd: '/tmp/project' },
      },
    }
    const result = await run(deps, 'refine', ' the deploy bug', agent)
    assert.equal(result.kind, 'success')
    assert.equal(result.text, '  ⚗ Reviewing this conversation in the background (focus: the deploy bug) — any memory/skill updates will be reported when done.')
    assert.equal(reviews.length, 1)
    assert.equal(reviews[0].focus, 'the deploy bug')
    assert.equal(reviews[0].cwd, '/tmp/project')
    assert.equal(reviews[0].reviewMemory, true)
    assert.equal(reviews[0].reviewSkills, true)
  })
})

test('/learn queues the authoring prompt as an ordinary user turn', async () => {
  await withHome(async () => {
    const { deps } = makeDeps()
    const queued = []
    const agent = { followup: (message) => queued.push(message), session: { deriveMessages: () => [] } }
    const result = await run(deps, 'learn', ' how to bisect a kernel regression', agent)
    assert.equal(result.text, 'Learning a skill from what you described…')
    assert.equal(queued.length, 1)
    assert.equal(queued[0].role, 'user')
    assert.equal(queued[0].id, 'learn-message-1')
    assert.deepEqual(queued[0].source, { kind: 'user' })
    assert.equal(queued[0].content[0].type, 'text')
    assert.ok(queued[0].content[0].text.includes('how to bisect a kernel regression'))
    assert.ok(queued[0].content[0].text.includes('skill_manage'))
  })
})

test('/learn without a request uses the default prompt and the conversation wording', async () => {
  await withHome(async () => {
    const { deps } = makeDeps()
    const queued = []
    const agent = { followup: (message) => queued.push(message) }
    const result = await run(deps, 'learn', '', agent)
    assert.equal(result.text, 'Learning a skill from this conversation…')
    assert.ok(queued[0].content[0].text.length > 100)
  })
})

test('/learn reports a missing session instead of throwing', async () => {
  await withHome(async () => {
    const { deps } = makeDeps()
    const result = await run(deps, 'learn', ' something', undefined)
    assert.equal(result.kind, 'success')
    assert.equal(result.text, '/learn needs an active chat session to run.')
  })
})