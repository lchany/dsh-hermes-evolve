'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { readFile, access } = require('node:fs/promises')

const { buildToolSet } = require('../src/skill_tools')
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