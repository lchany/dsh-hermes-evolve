'use strict'

/**
 * The panel: a small HTTP API plus one self-rendering page.
 *
 * A route-owned page is deliberately chosen over a client-slot bundle for
 * v0.1.0: settings already get an auto-generated page from the exported
 * `Config`, and the panel is an inspection surface (what does the loop actually
 * know, what did the curator do, what is pending) rather than a second UI
 * framework. The page talks to the same JSON endpoints any other client could
 * use, so swapping in a slot bundle later changes nothing on the host side.
 */

const path = require('node:path')

const util = require('./util')
const memory = require('./memory')
const store = require('./skill_store')
const { DEFAULTS } = require('./const')
const usageMod = require('./skill_usage')

const API_PREFIX = '/hermes-evolve/api'
const PAGE_PATH = '/hermes-evolve'
const MAX_BODY_BYTES = 512 * 1024

function sendJson (res, status, payload) {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendHtml (res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html),
  })
  res.end(html)
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') { resolve({}); return }
      try { resolve(JSON.parse(raw)) } catch { reject(new Error('invalid JSON body')) }
    })
    req.on('error', reject)
  })
}

/** Settings fields a panel may edit — a whitelist so a typo cannot inject a
 *  schema key the host would silently drop. */
const EDITABLE_SETTINGS = [
  'enabled', 'mode', 'memoryMode', 'skillsMode', 'provider', 'model',
  'skillNudgeInterval', 'memoryNudgeInterval', 'reviewTimeoutSec',
  'signalTriggerEnabled', 'signalToolFailureMin',
  'memoryInjectionEnabled', 'memoryEnabled', 'userProfileEnabled',
  'coachingEnabled', 'coachingMode',
  'linterEnabled', 'ledgerEnabled', 'registerTools', 'respectForeignMemory',
  'curatorEnabled', 'curatorConsolidate', 'curatorIntervalHours',
  'curatorMinIdleHours', 'curatorStaleDays', 'curatorArchiveDays', 'curatorBackupKeep',
]

function registerPanelRoutes (webServerCtx, deps) {
  const { pluginCtx, settings, settingsNs, logger, refreshMemoryCache, readMemoryText, curatorStatus, runCuratorNow, curatorModule } = deps
  const webServer = webServerCtx.webServer
  const disposers = []

  const statusPayload = async () => {
    const curatorState = await curatorModule.status()
    let skills = []
    try { skills = await store.scanSkills() } catch { skills = [] }
    const usage = await usageMod.loadUsage()
    const counts = { active: 0, stale: 0, archived: 0, managed: 0, pinned: 0 }
    for (const skill of skills) {
      const record = usageMod.backfill(usage[skill.name])
      if (record.state === 'stale') counts.stale += 1
      else if (record.state === 'archived') counts.archived += 1
      else counts.active += 1
      if (usageMod.isCuratorManagedRecord(record)) counts.managed += 1
      if (record.pinned === true) counts.pinned += 1
    }
    let pending = []
    try { pending = await store.listPending() } catch { pending = [] }
    return {
      plugin: 'hermes-evolve',
      version: require('../package.json').version,
      store: {
        dshHome: util.dshHome(),
        skills: util.skillsDir(),
        memory: util.memoryDir(),
        pending: util.pendingDir(),
        backups: util.backupsDir(),
      },
      settings,
      skills: { total: skills.length, counts },
      curator: {
        ...curatorState,
        runtime: { running: curatorStatus.running, lastActivityAt: curatorStatus.lastActivityAt, lastResult: curatorStatus.lastResult },
      },
      pending: pending.slice(0, 50),
      memoryChars: readMemoryText().length,
    }
  }

  const handleApi = async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const route = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/'
    try {
      if (req.method === 'GET' && route === '/status') {
        sendJson(res, 200, await statusPayload())
        return
      }

      if (req.method === 'GET' && route === '/memory') {
        const stores = {}
        for (const kind of ['memory', 'user']) {
          const loaded = await memory.readStore(util.memoryDir(), kind)
          stores[kind] = {
            file: memory.storeFile(util.memoryDir(), kind),
            entries: loaded.entries,
            raw: loaded.raw,
            chars: memory.charsOf(loaded.entries),
            limit: kind === 'user' ? Number(settings.userCharLimit) || 1375 : Number(settings.memoryCharLimit) || 2200,
            readFailed: loaded.readFailed,
          }
        }
        sendJson(res, 200, { stores, rendered: readMemoryText() })
        return
      }

      if (req.method === 'GET' && route === '/skills') {
        const skills = await store.scanSkills()
        const usage = await usageMod.loadUsage()
        sendJson(res, 200, {
          skills: skills.map((skill) => {
            const record = usageMod.backfill(usage[skill.name])
            return {
              name: skill.name,
              description: skill.description,
              category: skill.category,
              dir: skill.dir,
              state: record.state,
              pinned: record.pinned === true,
              managed: usageMod.isCuratorManagedRecord(record),
              useCount: record.use_count,
              viewCount: record.view_count,
              patchCount: record.patch_count,
              lastUsedAt: record.last_used_at,
              createdAt: record.created_at,
            }
          }),
        })
        return
      }

      if (req.method === 'GET' && route === '/pending') {
        sendJson(res, 200, { pending: await store.listPending() })
        return
      }

      if (req.method === 'POST' && route === '/pending') {
        const body = await readBody(req)
        const decision = String(body.decision || 'approved')
        const outcome = await store.resolvePending(String(body.id || ''), decision)
        if (outcome.ok !== true) {
          sendJson(res, 404, outcome)
          return
        }
        const record = outcome.record
        if (decision === 'approved' && record.kind === 'memory') {
          // hermes `/memory pending` approve: replay the staged operations.
          const applied = await memory.writeMemory(
            util.memoryDir(),
            record.target === 'user' ? 'user' : 'memory',
            Array.isArray(record.operations) ? record.operations : [],
            {
              limit: Number.isFinite(record.limit)
                ? record.limit
                : (record.target === 'user' ? DEFAULTS.userCharLimit : DEFAULTS.memoryCharLimit),
            },
          )
          if (applied.ok !== true) {
            sendJson(res, 409, { ok: false, applied, record })
            return
          }
          const marked = await store.markPending(record.id, 'approved', { applied: true })
          sendJson(res, 200, { ok: true, applied: true, result: applied, record: marked.record })
          return
        }
        const marked = await store.markPending(record.id, decision === 'approved' ? 'approved' : 'rejected')
        sendJson(res, 200, { ok: marked.ok === true, record: marked.record, error: marked.error })
        return
      }

      if (req.method === 'GET' && route === '/backups') {
        sendJson(res, 200, { backups: await store.listBackups() })
        return
      }

      if (req.method === 'POST' && route === '/restore') {
        const body = await readBody(req)
        const outcome = await store.restoreBackup(String(body.id || ''))
        logger.info?.(`[hermes-evolve] restore ${body.id}: ${outcome.ok === true ? 'ok' : outcome.error}`)
        sendJson(res, outcome.ok === true ? 200 : 400, outcome)
        return
      }

      if (req.method === 'POST' && route === '/settings') {
        const body = await readBody(req)
        // Accept both {patch:{...}} (the page's own call) and a flat object.
        const patch = body && typeof body.patch === 'object' && body.patch !== null ? body.patch : (body || {})
        const cleaned = {}
        for (const [key, value] of Object.entries(patch)) {
          if (EDITABLE_SETTINGS.includes(key)) cleaned[key] = value
        }
        if (Object.keys(cleaned).length === 0) {
          sendJson(res, 400, { ok: false, error: 'no editable settings in patch' })
          return
        }
        await pluginCtx.settings.update(settingsNs, cleaned)
        await refreshMemoryCache()
        sendJson(res, 200, { ok: true, applied: cleaned })
        return
      }

      if (req.method === 'POST' && route === '/curator') {
        const body = await readBody(req)
        const action = String(body.action || 'run')
        if (action === 'pause' || action === 'resume') {
          const state = await curatorModule.setPaused(action === 'pause')
          sendJson(res, 200, { ok: true, paused: state.paused })
          return
        }
        if (curatorStatus.running) {
          sendJson(res, 409, { ok: false, error: 'a curator pass is already running' })
          return
        }
        curatorStatus.running = true
        // Return immediately: a consolidation pass can run for minutes. The
        // panel polls /status, which carries `runtime.lastResult`.
        void runCuratorNow({ dryRun: body.dryRun === true, consolidate: body.consolidate === undefined ? undefined : body.consolidate === true })
          .then((result) => {
            curatorStatus.lastResult = { at: new Date().toISOString(), trigger: 'panel', ...summarize(result) }
          })
          .catch((error) => {
            curatorStatus.lastResult = { at: new Date().toISOString(), trigger: 'panel', ok: false, error: error && error.message }
          })
          .finally(() => { curatorStatus.running = false })
        sendJson(res, 202, { ok: true, started: true })
        return
      }

      sendJson(res, 404, { ok: false, error: `unknown route ${req.method} ${url.pathname}` })
    } catch (error) {
      logger.warn?.(`[hermes-evolve] panel error: ${error && error.message ? error.message : error}`)
      sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error) })
    }
  }

  disposers.push(webServer.register({ kind: 'prefix', path: API_PREFIX, handler: handleApi }))
  disposers.push(webServer.register({ kind: 'exact', path: PAGE_PATH, handler: (req, res) => {
    if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'GET only' }); return }
    sendHtml(res, 200, renderPage())
  } }))

  return () => {
    for (const dispose of disposers) { try { dispose() } catch { /* gone */ } }
  }
}

function summarize (result) {
  if (result === null || typeof result !== 'object') return { ok: false }
  if (result.skipped !== undefined) return { ok: false, skipped: result.skipped }
  const archived = result.automatic && result.automatic.ok === true
    ? result.automatic.archived.map((item) => item.name)
    : []
  return { ok: result.ok === true, archived, summary: result.state ? result.state.last_run_summary : undefined }
}

function renderPage () {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hermes-evolve</title>
<style>
  :root { color-scheme: light dark; --line: color-mix(in oklab, currentColor 18%, transparent); --muted: color-mix(in oklab, currentColor 55%, transparent); }
  body { font: 14px/1.55 ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; }
  header { padding: 18px 24px; border-bottom: 1px solid var(--line); display: flex; gap: 16px; align-items: baseline; }
  header h1 { font-size: 17px; margin: 0; letter-spacing: .2px; }
  header .meta { color: var(--muted); font-size: 12px; }
  main { padding: 20px 24px 64px; display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); }
  section { border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  section h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; margin: 0 0 10px; color: var(--muted); }
  button { font: inherit; padding: 4px 12px; border-radius: 7px; border: 1px solid var(--line); background: transparent; cursor: pointer; }
  button.primary { border-color: color-mix(in oklab, #3b82f6 70%, var(--line)); color: #3b82f6; }
  button:disabled { opacity: .45; cursor: default; }
  input[type=number], input[type=text] { font: inherit; width: 90px; padding: 2px 6px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: inherit; }
  label.field { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; border-bottom: 1px dotted var(--line); }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .kv { display: grid; grid-template-columns: 150px 1fr; gap: 4px 12px; font-size: 13px; }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; overflow-wrap: anywhere; }
  .empty { color: var(--muted); font-style: italic; }
  code { font: 12px/1.4 ui-monospace, SFMono-Regular, monospace; }
  ul { margin: 0; padding-left: 18px; }
  .pill { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); }
  .pill.managed { color: #0a8f4d; border-color: color-mix(in oklab, #0a8f4d 55%, var(--line)); }
</style>
</head>
<body>
<header>
  <h1>hermes-evolve</h1>
  <span class="meta" id="version"></span>
  <span class="meta" id="paths"></span>
</header>
<main>
  <section>
    <h2>Curator</h2>
    <dl class="kv" id="curator-facts"></dl>
    <div class="row" style="margin-top:10px">
      <button class="primary" id="run-dry">Dry run</button>
      <button id="run-pause">Pause</button>
      <button id="run-resume">Resume</button>
    </div>
    <p class="meta" id="curator-last"></p>
  </section>

  <section>
    <h2>Skills</h2>
    <div id="skill-counts"></div>
    <ul id="skill-list" style="margin-top:8px;max-height:240px;overflow:auto"></ul>
  </section>

  <section>
    <h2>Memory</h2>
    <dl class="kv" id="memory-usage"></dl>
    <pre id="memory-rendered" style="white-space:pre-wrap;font-size:12px;max-height:260px;overflow:auto"></pre>
  </section>

  <section>
    <h2>Pending review</h2>
    <ul id="pending"></ul>
    <div class="row" style="margin-top:8px"><button id="refresh">Refresh</button></div>
  </section>

  <section>
    <h2>Settings</h2>
    <div id="settings"></div>
  </section>
</main>
<script>
const API = '/hermes-evolve/api'
const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const BOOL_FIELDS = ['enabled','signalTriggerEnabled','memoryInjectionEnabled','memoryEnabled','userProfileEnabled','coachingEnabled','linterEnabled','ledgerEnabled','curatorEnabled','curatorConsolidate']
const NUM_FIELDS = ['skillNudgeInterval','memoryNudgeInterval','reviewTimeoutSec','curatorIntervalHours','curatorMinIdleHours','curatorStaleDays','curatorArchiveDays','curatorBackupKeep']

async function get (path) { const r = await fetch(API + path); return r.json() }
async function post (path, body) { const r = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return r.json() }

function renderStatus (s) {
  $('version').textContent = 'v' + s.version
  $('paths').textContent = s.store.skills + '  ·  ' + s.store.memory
  const c = s.curator
  $('curator-facts').innerHTML = [
    ['skills', s.skills.total + ' (active ' + s.skills.counts.active + ', stale ' + s.skills.counts.stale + ', archived ' + s.skills.counts.archived + ')'],
    ['managed by curator', s.skills.counts.managed + ' / pinned ' + s.skills.counts.pinned],
    ['paused', String(c.state.paused === true)],
    ['last run', c.state.last_run_at || 'never'],
    ['next due in', c.dueInHours + ' h'],
    ['backups', String((c.backups || []).length)],
    ['running now', String(c.runtime.running)],
  ].map(([k, v]) => '<dt>' + k + '</dt><dd>' + esc(v) + '</dd>').join('')
  const last = c.runtime.lastResult || (c.state.last_run_summary ? { summary: c.state.last_run_summary } : null)
  $('curator-last').textContent = last ? JSON.stringify(last) : ''
  $('skill-counts').textContent = s.skills.counts.active + ' active · ' + s.skills.counts.stale + ' stale · ' + s.skills.counts.archived + ' archived'
  $('memory-usage').innerHTML = '<dt>chars injected</dt><dd>' + s.memoryChars + '</dd>'
  $('pending').innerHTML = (s.pending || []).length === 0 ? '<li class="empty">none</li>' :
    s.pending.map((p) => '<li><code>' + esc(p.kind || 'review') + '</code> ' + esc(p.sessionId || '') + '<br><small>' + esc((p.summary || '').slice(0, 400)) + '</small><br><button data-pending="' + esc(p.id) + '" data-decision="approved">approve</button> <button data-pending="' + esc(p.id) + '" data-decision="rejected">reject</button></li>').join('')
  const settingsEl = $('settings')
  settingsEl.innerHTML = [
    ...BOOL_FIELDS.map((k) => '<label class="field"><span>' + k + '</span><input type="checkbox" data-set="' + k + '" ' + (s.settings[k] ? 'checked' : '') + '></label>'),
    ...NUM_FIELDS.map((k) => '<label class="field"><span>' + k + '</span><input type="number" data-set="' + k + '" value="' + esc(s.settings[k]) + '"></label>'),
    '<label class="field"><span>mode</span><select data-set="mode">' + ['auto','approval','log-only'].map((m) => '<option ' + (s.settings.mode === m ? 'selected' : '') + '>' + m + '</option>').join('') + '</select></label>',
    '<label class="field"><span>coachingMode</span><select data-set="coachingMode">' + ['full','patch-only','off'].map((m) => '<option ' + (s.settings.coachingMode === m ? 'selected' : '') + '>' + m + '</option>').join('') + '</select></label>',
    '<div class="row" style="margin-top:8px"><button class="primary" id="save-settings">Save</button></div>',
  ].join('')
  document.querySelectorAll('[data-pending]').forEach((b) => b.addEventListener('click', async () => {
    await post('/pending', { id: b.dataset.pending, decision: b.dataset.decision }); refreshAll()
  }))
  $('save-settings').addEventListener('click', async () => {
    const patch = {}
    document.querySelectorAll('[data-set]').forEach((el) => {
      const key = el.dataset.set
      if (el.type === 'checkbox') patch[key] = el.checked
      else if (el.type === 'number') patch[key] = Number(el.value)
      else patch[key] = el.value
    })
    await post('/settings', { patch }); refreshAll()
  })
}

async function refreshAll () {
  const [status, skills, mem, pending] = await Promise.all([get('/status'), get('/skills'), get('/memory'), get('/pending')])
  renderStatus(status)
  $('skill-list').innerHTML = skills.skills.length === 0 ? '<li class="empty">no skills yet</li>' :
    skills.skills.map((k) => '<li><code>' + esc(k.name) + '</code> <span class="pill ' + (k.managed ? 'managed' : '') + '">' + esc(k.state) + (k.managed ? ' · managed' : '') + '</span><br><small>' + esc((k.description || '').slice(0, 160)) + '</small></li>').join('')
  $('memory-usage').innerHTML = Object.entries(mem.stores).map(([kind, v]) => '<dt>' + esc(kind) + '</dt><dd>' + v.chars + ' / ' + v.limit + ' chars · ' + v.entries.length + ' entries</dd>').join('')
  $('memory-rendered').textContent = mem.rendered || '(empty)'
}

$('run-dry').addEventListener('click', async () => { await post('/curator', { action: 'run', dryRun: true }); setTimeout(refreshAll, 800) })
$('run-pause').addEventListener('click', async () => { await post('/curator', { action: 'pause' }); refreshAll() })
$('run-resume').addEventListener('click', async () => { await post('/curator', { action: 'resume' }); refreshAll() })
$('refresh').addEventListener('click', refreshAll)
refreshAll()
</script>
</body>
</html>`
}

module.exports = {
  registerPanelRoutes,
  renderPage,
  API_PREFIX,
  PAGE_PATH,
  EDITABLE_SETTINGS,
}