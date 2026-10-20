'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { mkdir, writeFile, readFile, rm, appendFile } = require('node:fs/promises')

const store = require('../src/skill_store')
const { withHome } = require('./helpers')

async function mkSkill (home, name, body = '# Body\n') {
  const dir = join(home, 'skills', name)
  await mkdir(dir, { recursive: true })
  const content = `---\nname: ${name}\ndescription: ${name} test skill.\n---\n\n${body}`
  await writeFile(join(dir, 'SKILL.md'), content, 'utf8')
  return content
}

const manifestPath = (home, id) => join(home, 'skills', '.curator_backups', id, 'manifest.json')
const archivePath = (home, id) => join(home, 'skills', '.curator_backups', id, 'skills.tar.gz')

async function readManifest (home, id) {
  return JSON.parse(await readFile(manifestPath(home, id), 'utf8'))
}

async function writeManifest (home, id, manifest) {
  await writeFile(manifestPath(home, id), JSON.stringify(manifest), 'utf8')
}

test('a backup records a per-file digest manifest and restores cleanly', async () => {
  await withHome(async (home) => {
    const alpha = await mkSkill(home, 'alpha')
    const beta = await mkSkill(home, 'beta', '# Beta body\n')

    const backup = await store.createBackup({ keep: 2 })
    assert.ok(backup, 'createBackup should return a snapshot')
    const manifest = await readManifest(home, backup.id)
    assert.equal(manifest.format, 2)
    assert.equal(manifest.archive, 'skills.tar.gz')
    assert.match(manifest.archive_sha256, /^[0-9a-f]{64}$/)
    assert.ok(manifest.archive_bytes > 0)
    assert.equal(manifest.skill_files, 2)
    assert.deepEqual(manifest.entries.map((entry) => entry.path).sort(), ['alpha/SKILL.md', 'beta/SKILL.md'])
    for (const entry of manifest.entries) {
      assert.ok(entry.size > 0)
      assert.match(entry.sha256, /^[0-9a-f]{64}$/)
    }

    // Destroy the live tree, then restore it from the snapshot.
    await rm(join(home, 'skills', 'alpha'), { recursive: true, force: true })
    await rm(join(home, 'skills', 'beta'), { recursive: true, force: true })
    const restored = await store.restoreBackup(backup.id)
    assert.equal(restored.ok, true, restored.error)
    assert.equal(restored.verified, true)
    assert.equal(await readFile(join(home, 'skills', 'alpha', 'SKILL.md'), 'utf8'), alpha)
    assert.equal(await readFile(join(home, 'skills', 'beta', 'SKILL.md'), 'utf8'), beta)
  })
})

test('a tampered archive is refused before it can touch the tree', async () => {
  await withHome(async (home) => {
    await mkSkill(home, 'alpha')
    const backup = await store.createBackup({ keep: 2 })
    await rm(join(home, 'skills', 'alpha'), { recursive: true, force: true })
    await appendFile(archivePath(home, backup.id), 'tampered')

    const restored = await store.restoreBackup(backup.id)
    assert.equal(restored.ok, false)
    assert.match(restored.error, /refusing to restore/)
    assert.match(restored.error, /skills\.tar\.gz size mismatch|skills\.tar\.gz checksum mismatch/)
    // Nothing was extracted.
    assert.equal(await store.findSkill('alpha'), undefined)
  })
})

test('a manifest whose file digest no longer matches is refused', async () => {
  await withHome(async (home) => {
    await mkSkill(home, 'alpha')
    const backup = await store.createBackup({ keep: 2 })
    const manifest = await readManifest(home, backup.id)
    manifest.entries[0].sha256 = '0'.repeat(64)
    await writeManifest(home, backup.id, manifest)

    const restored = await store.restoreBackup(backup.id)
    assert.equal(restored.ok, false)
    assert.match(restored.error, /checksum mismatch for 'alpha\/SKILL\.md'/)
  })
})

test('a manifest with a stale size is refused', async () => {
  await withHome(async (home) => {
    await mkSkill(home, 'alpha')
    const backup = await store.createBackup({ keep: 2 })
    const manifest = await readManifest(home, backup.id)
    manifest.entries[0].size = manifest.entries[0].size + 1
    await writeManifest(home, backup.id, manifest)

    const restored = await store.restoreBackup(backup.id)
    assert.equal(restored.ok, false)
    assert.match(restored.error, /size mismatch for 'alpha\/SKILL\.md'/)
  })
})

test('an archive carrying a file the manifest omits is refused', async () => {
  await withHome(async (home) => {
    await mkSkill(home, 'alpha')
    await mkSkill(home, 'beta')
    const backup = await store.createBackup({ keep: 2 })
    const manifest = await readManifest(home, backup.id)
    manifest.entries = manifest.entries.filter((entry) => entry.path !== 'beta/SKILL.md')
    await writeManifest(home, backup.id, manifest)

    const restored = await store.restoreBackup(backup.id)
    assert.equal(restored.ok, false)
    assert.match(restored.error, /archive contains files the manifest does not list: beta\/SKILL\.md/)
  })
})

test('a manifest path that escapes the skills root is refused', async () => {
  await withHome(async (home) => {
    await mkSkill(home, 'alpha')
    const backup = await store.createBackup({ keep: 2 })
    const manifest = await readManifest(home, backup.id)
    manifest.entries = [...manifest.entries, { path: '../escape.txt', size: 1, sha256: '0'.repeat(64) }]
    await writeManifest(home, backup.id, manifest)

    const restored = await store.restoreBackup(backup.id)
    assert.equal(restored.ok, false)
    assert.match(restored.error, /manifest path '\.\.\/escape\.txt' escapes the skills root/)
  })
})

test('a legacy manifest without integrity data still restores', async () => {
  await withHome(async (home) => {
    await mkSkill(home, 'alpha')
    const backup = await store.createBackup({ keep: 2 })
    // Simulate a snapshot written by the previous release.
    await writeManifest(home, backup.id, { id: backup.id, created_at: new Date().toISOString(), keep: 2, files: ['.hub'] })
    await rm(join(home, 'skills', 'alpha'), { recursive: true, force: true })

    const restored = await store.restoreBackup(backup.id)
    assert.equal(restored.ok, true, restored.error)
    assert.equal(restored.verified, false)
    assert.ok(await store.findSkill('alpha'), 'the legacy path extracts the tree')
  })
})
