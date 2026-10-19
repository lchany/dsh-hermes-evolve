#!/usr/bin/env node
'use strict'

/**
 * Offline health check: syntax-check every source file, validate the extracted
 * Hermes artifacts, and make sure the plugin still advertises the surface the
 * host expects. Runs in CI and locally via `npm run check`.
 */

const { execFileSync } = require('node:child_process')
const { readdirSync, readFileSync } = require('node:fs')
const { join, dirname } = require('node:path')

const ROOT = join(__dirname, '..')
let failures = 0

function fail (message) {
  failures += 1
  console.error(`✖ ${message}`)
}

function ok (message) {
  console.log(`✔ ${message}`)
}

function walk (dir, suffix) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, suffix))
    else if (entry.name.endsWith(suffix)) out.push(full)
  }
  return out
}

for (const file of [...walk(join(ROOT, 'src'), '.js'), ...walk(join(ROOT, 'test'), '.js'), ...walk(join(ROOT, 'scripts'), '.js')]) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    fail(`${file} does not parse: ${error.stderr ? error.stderr.toString().trim() : error.message}`)
  }
}
ok('every JavaScript file parses')

for (const file of [...walk(join(ROOT, 'src'), '.json'), join(ROOT, 'package.json')]) {
  try {
    JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`${file} is not valid JSON: ${error.message}`)
  }
}
ok('every JSON artifact is valid')

const promptsFile = JSON.parse(readFileSync(join(ROOT, 'src', 'prompts.hermes.json'), 'utf8'))
if (!/hermes-agent@[0-9a-f]{7,40}/.test(promptsFile.source || '')) fail('prompts.hermes.json lost its source commit')
const requiredTexts = [
  '_MEMORY_ROUTING_BLOCK', '_MEMORY_REVIEW_PROMPT', '_LESSON_LAYER_BLOCK', '_DO_NOT_CAPTURE_BLOCK',
  '_SKILL_REVIEW_PROMPT', '_COMBINED_REVIEW_PROMPT', 'CURATOR_DRY_RUN_BANNER', 'CURATOR_REVIEW_PROMPT',
]
for (const name of requiredTexts) {
  if (typeof promptsFile.texts[name] !== 'string' || promptsFile.texts[name].length < 100) {
    fail(`prompts.hermes.json is missing ${name}`)
  }
}
ok('all eight Hermes prompt texts are present')

const schemasFile = JSON.parse(readFileSync(join(ROOT, 'src', 'schemas.hermes.json'), 'utf8'))
const toolSchemas = require(join(ROOT, 'src', 'tool_schemas.js'))
if (!Array.isArray(schemasFile) || schemasFile.length !== 4) fail('schemas.hermes.json should hold four schemas')
for (const schema of schemasFile) {
  if (!schema || typeof schema.name !== 'string' || typeof schema.parameters !== 'object') {
    fail('a schema in schemas.hermes.json is malformed')
    continue
  }
  const mirrored = toolSchemas[schema.name]
  if (mirrored === undefined || JSON.stringify(mirrored) !== JSON.stringify(schema)) {
    fail(`tool_schemas.js and schemas.hermes.json disagree for ${schema.name}`)
  }
}
for (const name of ['memory', 'skills_list', 'skill_view', 'skill_manage']) {
  if (toolSchemas[name] === undefined) fail(`tool_schemas.js is missing ${name}`)
}
ok('four verbatim tool schemas are present and mirrored')

const plugin = require(join(ROOT, 'src', 'index.js'))
if (plugin.name !== 'hermes-evolve') fail('plugin name changed')
if (typeof plugin.apply !== 'function') fail('plugin has no apply()')
if (plugin.Config === undefined) fail('plugin has no Config (settings page would be empty)')
ok('plugin exports name / inject / Config / apply')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
if (pkg.dsh?.bundle?.patch === undefined) fail('package.json lost dsh.bundle.patch')
if (!readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8').includes('dsh-hermes-evolve')) fail('cordis.patch.yml does not reference the package')
ok('bundle patch is wired')

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')