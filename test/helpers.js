'use strict'

const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

/** Point every store at a throwaway DSH_HOME for the duration of one test. */
async function withHome (fn) {
  const home = await mkdtemp(join(tmpdir(), 'hermes-evolve-test-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

module.exports = { withHome }