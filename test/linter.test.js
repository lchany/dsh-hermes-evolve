'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const linter = require('../src/skill_linter')

const GOOD = `---
name: pdf-toolkit
description: Extract text and tables from PDF files.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [pdf]
---

# PDF toolkit

## When to Use

When the user hands you a PDF.
`

function rules (findings) {
  return findings.map((finding) => finding.rule)
}

test('a clean skill lints clean', () => {
  assert.deepEqual(linter.lintContent(GOOD), [])
})

test('frontmatter rules match hermes verbatim', () => {
  const bad = GOOD.replace('name: pdf-toolkit', 'name: PDF_Toolkit')
  const findings = linter.lintContent(bad)
  assert.ok(rules(findings).includes('name-format'))
  assert.match(findings.find((f) => f.rule === 'name-format').message,
    /must be lowercase letters, digits, hyphens, and underscores only\./)

  const marketing = GOOD.replace('Extract text and tables from PDF files.',
    'A powerful, comprehensive and seamless PDF extraction toolkit')
  const marketingFindings = linter.lintContent(marketing)
  assert.ok(rules(marketingFindings).includes('description-marketing'))

  const truncated = GOOD.replace('Extract text and tables from PDF files.',
    'Extract text and tables from PDF files without losing layout or reading order across columns.')
  assert.ok(rules(linter.lintContent(truncated)).includes('description-length'))
})

test('body rules catch shell-utility prose, missing sections and incident logs', () => {
  const shell = `${GOOD}\nUse \`grep\` to find the line.\n`
  assert.ok(rules(linter.lintContent(shell)).includes('shell-utility-reference'))

  const noSection = GOOD.replace('## When to Use', '## Usage')
  assert.ok(rules(linter.lintContent(noSection)).includes('missing-section'))

  const incident = `${GOOD}\n${'Fixes #12345 #23456 and PR #34567, see issue #45678 again. '.repeat(3)}\n`
  assert.ok(rules(linter.lintContent(incident)).includes('incident-log-shape'))

  const big = `${GOOD}\n${'x'.repeat(25000)}\n`
  assert.ok(rules(linter.lintContent(big)).includes('oversized-body'))
})

test('on-disk checks cover name/dir mismatch, dangling links and forbidden files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hevo-lint-'))
  try {
    const dir = join(home, 'pdf-toolkit')
    await mkdir(join(dir, 'references'), { recursive: true })
    await writeFile(join(dir, 'README.md'), 'scaffolding')
    await writeFile(join(dir, 'references', 'api.md'), '# api')
    const body = `${GOOD}\nSee references/api.md and references/missing.md.\n`
    await writeFile(join(dir, 'SKILL.md'), body)
    const findings = linter.lintSkill(join(dir, 'SKILL.md'))
    const found = rules(findings)
    assert.ok(found.includes('dangling-reference'))
    assert.ok(found.includes('forbidden-file'))
    assert.ok(!found.includes('name-dir-mismatch'))

    const renamed = await mkdtemp(join(tmpdir(), 'hevo-lint2-'))
    try {
      const dir2 = join(renamed, 'other-name')
      await mkdir(dir2, { recursive: true })
      await writeFile(join(dir2, 'SKILL.md'), GOOD)
      assert.ok(rules(linter.lintSkill(join(dir2, 'SKILL.md'))).includes('name-dir-mismatch'))
    } finally {
      await rm(renamed, { recursive: true, force: true })
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('newlyIntroduced reports only the standing diff', () => {
  const before = [{ rule: 'oversized-body', message: 'x' }]
  const after = [{ rule: 'oversized-body', message: 'x' }, { rule: 'dangling-reference', message: 'y' }]
  assert.deepEqual(linter.newlyIntroduced(before, after).map((f) => f.rule), ['dangling-reference'])
})
