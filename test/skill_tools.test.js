'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { readFile, access } = require('node:fs/promises')

const { buildToolSet } = require('../src/skill_tools')
const store = require('../src/skill_store')
const { withHome } = require('./helpers')

const SKILL_MD = `---
name: pdf-toolkit
description: Extract text and tables from PDF files without losing layout.
---

# PDF toolkit

## When to Use

When the user hands you a PDF and wants its text.

## Procedure

1. Run \`pdftotext -layout input.pdf -\`.
`

function toolset () {
  const tools = buildToolSet({ agentCreated: true })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return async (name, args) => {
    const tool = byName.get(name)
    assert.ok(tool, `missing tool ${name}`)
    return JSON.parse(await tool.execute(args, { signal: new AbortController().signal }))
  }
}

test('create, duplicate-create, read-before-write, patch, write_file, archive', async () => {
  await withHome(async (home) => {
    const call = toolset()

    let result = await call('skill_manage', {
      operations: [{ action: 'create', name: 'pdf-toolkit', content: SKILL_MD }],
    })
    assert.equal(result.success, true, JSON.stringify(result))
    assert.equal(await exists(join(home, 'skills', 'pdf-toolkit', 'SKILL.md')), true)

    result = await call('skill_manage', {
      operations: [{ action: 'create', name: 'pdf-toolkit', content: SKILL_MD }],
    })
    assert.equal(result.success, false)
    assert.match(result.error, /already exists/)

    // A patch without a skill_view in this turn is refused.
    result = await call('skill_manage', {
      operations: [{ action: 'patch', name: 'pdf-toolkit', old_string: 'pdftotext -layout', new_string: 'pdftotext -raw' }],
    })
    assert.equal(result.success, false)
    assert.match(result.error, /has not been loaded/)

    result = await call('skill_view', { name: 'pdf-toolkit' })
    assert.equal(result.success, true)
    assert.match(result.content, /PDF toolkit/)

    result = await call('skill_manage', {
      operations: [{ action: 'patch', name: 'pdf-toolkit', old_string: 'pdftotext -layout', new_string: 'pdftotext -raw' }],
    })
    assert.equal(result.success, true, JSON.stringify(result))
    const body = await readFile(join(home, 'skills', 'pdf-toolkit', 'SKILL.md'), 'utf8')
    assert.match(body, /pdftotext -raw/)

    result = await call('skill_manage', {
      operations: [{ action: 'write_file', name: 'pdf-toolkit', file_path: 'references/api.md', file_content: '# API\n' }],
    })
    assert.equal(result.success, true, JSON.stringify(result))
    result = await call('skill_view', { name: 'pdf-toolkit' })
    assert.deepEqual(result.linked_files.references, ['api.md'])

    result = await call('skill_manage', {
      operations: [{ action: 'delete', name: 'pdf-toolkit' }],
    })
    assert.equal(result.success, true, JSON.stringify(result))
    assert.equal(await exists(join(home, 'skills', 'pdf-toolkit')), false)
    assert.equal(await exists(join(home, 'skills', '.archive', 'pdf-toolkit', 'SKILL.md')), true)
  })
})

test('support-file paths are confined to the skill directory', async () => {
  await withHome(async (home) => {
    const call = toolset()
    await call('skill_manage', { operations: [{ action: 'create', name: 'safe-skill', content: SKILL_MD.replace(/pdf-toolkit/g, 'safe-skill') }] })
    const result = await call('skill_manage', {
      operations: [{ action: 'write_file', name: 'safe-skill', file_path: '../../escape.md', file_content: 'x' }],
    })
    assert.equal(result.success, false)
    assert.equal(await exists(join(home, 'escape.md')), false)
  })
})

test('memory tool writes the named store with a limit', async () => {
  await withHome(async (home) => {
    const call = toolset()
    const result = await call('memory', { target: 'user', action: 'add', content: 'User prefers Chinese, terse answers.' })
    assert.equal(result.success, true, JSON.stringify(result))
    const raw = await readFile(join(home, 'memories', 'USER.md'), 'utf8')
    assert.match(raw, /prefers Chinese/)
  })
})

test('skills_list reports the catalog in hermes shape', async () => {
  await withHome(async () => {
    const call = toolset()
    let result = await call('skills_list', {})
    assert.equal(result.success, true)
    assert.equal(result.skills.length, 0)
    await call('skill_manage', { operations: [{ action: 'create', name: 'pdf-toolkit', content: SKILL_MD }] })
    result = await call('skills_list', {})
    assert.equal(result.skills[0].name, 'pdf-toolkit')
    assert.match(result.hint, /skill_view/)
  })
})

async function exists (path) {
  try { await access(path); return true } catch { return false }
}
test('an unattended fork may add memory but never replace/remove it', async () => {
  await withHome(async (home) => {
    const tools = buildToolSet({ unattendedMemory: true, memoryCharLimit: 2200, userCharLimit: 1375 })
    const memoryTool = tools.find((tool) => tool.name === 'memory')
    const exec = { signal: undefined, agent: undefined, name: 'memory' }

    const added = JSON.parse(await memoryTool.execute({ target: 'user', action: 'add', content: 'Prefers terse answers.' }, exec))
    assert.equal(added.success, true)
    assert.equal(added.staged, undefined)

    const staged = JSON.parse(await memoryTool.execute({ target: 'user', action: 'replace', old_text: 'terse', content: 'Prefers verbose answers.' }, exec))
    assert.equal(staged.success, true)
    assert.equal(staged.staged, true)
    assert.equal(staged.proposal_staged, true)
    assert.match(staged.message, /staged for your approval/)

    const pending = await store.listPending()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].kind, 'memory')
    assert.equal(pending[0].target, 'user')
    assert.equal(pending[0].operations[0].action, 'replace')
    assert.equal(pending[0].operations[0].matched_entry, 'Prefers terse answers.', 'an unattended stage pins the entry too (memory_tool.py:199)')

    // The entry on disk is unchanged: staging never applies silently.
    const raw = await readFile(join(home, 'memories', 'USER.md'), 'utf8')
    assert.match(raw, /Prefers terse answers\./)
    assert.doesNotMatch(raw, /verbose/)
  })
})

test('includeMemory=false removes the memory tool from the fork surface', () => {
  const names = buildToolSet({ includeMemory: false }).map((tool) => tool.name)
  assert.deepEqual(names, ['skills_list', 'skill_view', 'skill_manage'])
})

test('approval mode stages a replayable skill batch instead of refusing', async () => {
  await withHome(async (home) => {
    const tools = buildToolSet({ writeApproval: true, agentCreated: true })
    const manage = tools.find((tool) => tool.name === 'skill_manage')
    const staged = JSON.parse(await manage.execute({
      operations: [{ action: 'create', name: 'pdf-toolkit', content: SKILL_MD }],
    }, { signal: undefined }))

    assert.equal(staged.success, true, JSON.stringify(staged))
    assert.equal(staged.staged, true)
    assert.match(staged.message, /^Staged for approval \(skills\.write_approval is on\)\. Not yet saved — review in the hermes-evolve panel/)
    // Hermes' `skill_gist`: frontmatter description plus a size bucket.
    assert.match(staged.gist, /^create 'pdf-toolkit' — Extract text and tables from PDF files without losing layout\. \(\d+ chars\)$/)
    // Staging never applies.
    assert.equal(await exists(join(home, 'skills', 'pdf-toolkit', 'SKILL.md')), false)

    const pending = await store.listPending()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].kind, 'skill')
    assert.equal(pending[0].agentCreated, true)
    assert.deepEqual(pending[0].operations, [{ action: 'create', name: 'pdf-toolkit', content: SKILL_MD }])

    // The panel replays the same payload through the direct-write machinery.
    const { applyStagedSkillOperations } = require('../src/skill_tools')
    const applied = await applyStagedSkillOperations(pending[0].operations, { agentCreated: pending[0].agentCreated })
    assert.equal(applied.ok, true, JSON.stringify(applied))
    assert.equal(applied.applied, 1)
    assert.equal(await exists(join(home, 'skills', 'pdf-toolkit', 'SKILL.md')), true)

    // Provenance crossed the approval boundary: still curator-managed.
    const usageMod = require('../src/skill_usage')
    const usage = await usageMod.loadUsage()
    assert.equal(usage['pdf-toolkit'].created_by, 'agent')
  })
})

test('approval mode stages memory writes through the pending store', async () => {
  await withHome(async (home) => {
    const tools = buildToolSet({ writeApproval: true })
    const memoryTool = tools.find((tool) => tool.name === 'memory')
    const staged = JSON.parse(await memoryTool.execute({ target: 'memory', action: 'add', content: 'A durable fact.' }, { signal: undefined }))
    assert.equal(staged.success, true, JSON.stringify(staged))
    assert.equal(staged.staged, true)
    assert.match(staged.message, /^Staged for approval \(memory\.write_approval is on\)\. Not yet saved/)
    assert.equal(await exists(join(home, 'memories', 'MEMORY.md')), false, 'staging must not write')
    const pending = await store.listPending()
    assert.equal(pending[0].kind, 'memory')
    assert.equal(pending[0].target, 'memory')
    assert.equal(pending[0].actor, 'write-approval')
  })
})
