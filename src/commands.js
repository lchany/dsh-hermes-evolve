'use strict'

/**
 * The five self-evolution commands Hermes exposes to the user, ported into DSH
 * commands so the Desktop/GUI surface keeps the same control points:
 *
 *   /skills  pending | approve | reject | diff | approval      (write_approval_commands.py)
 *   /memory  pending | approve | reject | approval            (same module)
 *   /curator status | run | pause | resume | pin | unpin | restore | list-archived
 *                                                             (hermes_cli/curator.py)
 *   /refine  [focus]      run the review fork on demand       (cli_commands_mixin.py:1940)
 *   /learn   <request>    distill a skill from a request      (cli_commands_mixin.py:1615)
 *
 * The write-approval gates themselves live in Hermes as booleans
 * (`skills.write_approval`, `memory.write_approval`); `/skills approval on`
 * flips ours through the host settings document.
 */

const path = require('node:path')
const util = require('./util')
const memory = require('./memory')
const store = require('./skill_store')
const skillUsage = require('./skill_usage')
const skillTools = require('./skill_tools')
const curator = require('./curator')

const SUBSYSTEMS = { skills: 'skill', memory: 'memory' }
const SKILLS_USAGE = "Usage: /skills approve|reject <id>  (or 'all')"
const MEMORY_USAGE = "Usage: /memory approve|reject <id>  (or 'all')"

const APPROVAL_VALUES = new Map([
  ['on', true], ['true', true], ['yes', true], ['1', true], ['enable', true], ['enabled', true],
  ['off', false], ['false', false], ['no', false], ['0', false], ['disable', false], ['disabled', false],
])

/** Raw input after the command name; Hermes' args split on whitespace. */
function splitArgs (raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim()
  return text === '' ? [] : text.split(/\s+/)
}

/** `write_approval_enabled` as text: `<subsystem>.write_approval = on|off`. */
function stateLine (subsystem, settings) {
  const on = subsystem === 'skills' ? settings.skillsWriteApproval === true : settings.memoryWriteApproval === true
  return `${subsystem}.write_approval = ${on ? 'on' : 'off'}`
}

/** Pending records for a subsystem, oldest first (hermes `list_pending`). */
async function pendingRows (subsystem) {
  const kind = SUBSYSTEMS[subsystem]
  const rows = await store.listPending()
  return rows
    .filter((row) => row.kind === kind && row.status === 'pending')
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
}

/** Every destructive op of a staged memory payload, with its pinned entry. */
function destructiveOps (row) {
  const operations = Array.isArray(row.operations) ? row.operations : []
  return operations.filter((op) => op.action === 'replace' || op.action === 'remove')
}

/** hermes `_matched_entries(payload)`. */
function matchedEntryLines (row) {
  return destructiveOps(row).map((op) => (typeof op.matched_entry === 'string'
    ? `${op.action}s entry: ${op.matched_entry}`
    : `${op.action}: unpinned legacy target — reject and recreate before approving`))
}

/** hermes `_fmt_pending_list`. */
async function formatPendingList (subsystem) {
  const rows = await pendingRows(subsystem)
  if (rows.length === 0) return `No pending ${subsystem} writes.`
  const lines = [`Pending ${subsystem} writes (${rows.length}):`]
  for (const row of rows) {
    const tag = row.actor === 'background-review' || row.origin === 'background_review' ? ' [auto]' : ''
    lines.push(`  ${row.id}${tag}  ${row.summary || ''}`)
    if (subsystem === 'memory') {
      for (const line of matchedEntryLines(row)) lines.push(`      ${line}`)
    }
  }
  lines.push('')
  lines.push(`Apply: /${subsystem} approve <id>   Reject: /${subsystem} reject <id>`)
  if (subsystem === 'skills') lines.push('Review full diff: /skills diff <id>')
  return lines.join('\n')
}

/**
 * Full text of every entry a memory write changed, single-op or batch shape.
 * The approver is the last person who can notice a clause went missing, so the
 * whole overwritten/removed entry is printed, not the search string.
 */
function changedEntries (outcome, kind) {
  const applied = Array.isArray(outcome.applied) ? outcome.applied : []
  const out = []
  for (const op of applied) {
    // hermes `_changed_entries`: `patched` shows the entry BEFORE the splice (the
    // approve output labels it 'as it was before the edit'), and each section is
    // selected by the op's own action — a legacy `replace` is not a patch.
    const action = String(op.action || '')
    if (kind === 'replaced' && action === 'replace' && typeof op.previous === 'string') out.push(op.previous)
    if (kind === 'patched' && action === 'patch') {
      const before = typeof op.previous === 'string' ? op.previous : (typeof op.patched === 'string' ? op.patched : null)
      if (before !== null) out.push(before)
    }
    if (kind === 'removed' && action === 'remove' && typeof op.removed === 'string') out.push(op.removed)
  }
  return out
}

async function applyMemoryPending (row) {
  return skillTools.applyPendingMemory(row, { limit: row.limit !== undefined ? row.limit : undefined })
}

/** hermes `_approve`: replay each pending write, then report what it overwrote. */
async function approve (subsystem, args, deps) {
  const rows = await pendingRows(subsystem)
  if (rows.length === 0) return `No pending ${subsystem} writes.`
  const target = args[0]
  if (target === undefined) return subsystem === 'skills' ? SKILLS_USAGE : MEMORY_USAGE
  let targets
  if (target.toLowerCase() === 'all') {
    targets = rows
  } else {
    const record = rows.find((row) => row.id === target)
    if (record === undefined) return `No pending ${subsystem} write with id '${target}'.`
    targets = [record]
  }

  let applied = 0
  const failed = []
  const overwritten = []
  const patched = []
  const removed = []
  for (const row of targets) {
    let ok = false
    let message = ''
    if (subsystem === 'memory') {
      const outcome = await applyMemoryPending(row)
      ok = outcome.ok === true
      message = outcome.ok === true ? '' : String(outcome.detail || outcome.reason || 'apply failed')
      if (ok) {
        overwritten.push(...changedEntries(outcome, 'replaced').map((text) => `  ${row.id}: ${text}`))
        patched.push(...changedEntries(outcome, 'patched').map((text) => `  ${row.id}: ${text}`))
        removed.push(...changedEntries(outcome, 'removed').map((text) => `  ${row.id}: ${text}`))
      }
    } else {
      const outcome = await skillTools.applyStagedSkillOperations(row.operations, {
        // Provenance crosses the approval boundary, same as the panel path.
        agentCreated: row.agentCreated === true,
        actor: 'command-approval',
        linterEnabled: deps.settings.linterEnabled !== false,
        ledgerEnabled: deps.settings.ledgerEnabled !== false,
        supportFilesEnabled: deps.settings.supportFilesEnabled !== false,
      })
      ok = outcome.ok === true
      message = outcome.ok === true ? '' : String(outcome.error || 'apply failed')
    }
    if (ok) {
      await store.markPending(row.id, 'approved')
      applied += 1
    } else {
      failed.push(`${row.id}: ${message}`)
    }
  }

  const out = [`Approved ${applied} ${subsystem} write(s).`]
  if (overwritten.length > 0) {
    out.push('Overwrote entire entry (re-add anything you still need):')
    out.push(...overwritten)
  }
  if (patched.length > 0) {
    out.push('Patched entry (as it was before the edit):')
    out.push(...patched)
  }
  if (removed.length > 0) {
    out.push('Removed entry (re-add anything you still need):')
    out.push(...removed)
  }
  if (failed.length > 0) {
    out.push('Failed:')
    out.push(...failed.map((line) => `  ${line}`))
  }
  return out.join('\n')
}

/** hermes `_reject`. */
async function reject (subsystem, args) {
  const target = args[0]
  if (target === undefined) return subsystem === 'skills' ? SKILLS_USAGE : MEMORY_USAGE
  if (target.toLowerCase() === 'all') {
    const rows = await pendingRows(subsystem)
    let rejected = 0
    for (const row of rows) {
      const outcome = await store.markPending(row.id, 'rejected')
      if (outcome.ok === true) rejected += 1
    }
    return `Rejected ${rejected} pending ${subsystem} write(s).`
  }
  const rows = await pendingRows(subsystem)
  if (!rows.some((row) => row.id === target)) return `No pending ${subsystem} write with id '${target}'.`
  const outcome = await store.markPending(target, 'rejected')
  return outcome.ok === true
    ? `Rejected pending ${subsystem} write '${target}'.`
    : `No pending ${subsystem} write with id '${target}'.`
}

// ── unified diff (for /skills diff) ────────────────────────────────────────

function unifiedDiff (before, after, label) {
  const a = String(before === undefined || before === null ? '' : before).split('\n')
  const b = String(after === undefined || after === null ? '' : after).split('\n')
  if (a.join('\n') === b.join('\n')) return `No changes to ${label}.`
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let tail = 0
  while (tail < a.length - start && tail < b.length - start && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1
  const removed = a.slice(start, a.length - tail)
  const added = b.slice(start, b.length - tail)
  return [
    `--- a/${label}`,
    `+++ b/${label}`,
    `@@ -${start + 1},${removed.length} +${start + 1},${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join('\n')
}

/** Read a skill file off disk; `undefined` when it does not exist. */
async function readSkillFile (skillName, filePath) {
  let skill
  try {
    skill = await store.findSkill(skillName)
  } catch {
    skill = undefined
  }
  if (skill === undefined) return undefined
  return util.readFileSafe(path.join(skill.dir, filePath))
}

/** Apply a staged `patch` op to its base text; returns `undefined` when it cannot apply. */
function applyPatchText (base, op) {
  const oldString = typeof op.old_string === 'string' ? op.old_string : ''
  const newString = typeof op.new_string === 'string' ? op.new_string : ''
  if (oldString === '') return undefined
  const index = base.indexOf(oldString)
  if (index === -1) return undefined
  if (op.replace_all === true) return base.split(oldString).join(newString)
  return base.slice(0, index) + newString + base.slice(index + oldString.length)
}

/** hermes `skill_pending_diff`: per-op diffs, folded so op i diffs against ops 1..i-1. */
async function skillPendingDiff (row) {
  const operations = Array.isArray(row.operations) ? row.operations : []
  const staged = new Map()
  const parts = []
  const stagedKey = (name, file) => `${name}\u0000${file}`
  const baseOf = async (name, filePath) => {
    const key = stagedKey(name, filePath)
    if (staged.has(key)) return staged.get(key)
    const onDisk = await readSkillFile(name, filePath)
    return onDisk === undefined ? '' : onDisk
  }
  for (let i = 0; i < operations.length; i += 1) {
    const op = operations[i]
    const action = String(op.action || '')
    const name = String(op.name || '')
    const filePath = typeof op.file_path === 'string' && op.file_path !== '' ? op.file_path : 'SKILL.md'
    const gist = skillTools.skillGist(op)
    let diff
    if (action === 'create') {
      diff = String(op.content || '')
      staged.set(stagedKey(name, filePath), diff)
    } else if (action === 'edit') {
      const before = await baseOf(name, filePath)
      const after = String(op.content || '')
      diff = unifiedDiff(before, after, filePath)
      staged.set(stagedKey(name, filePath), after)
    } else if (action === 'patch') {
      const before = await baseOf(name, filePath)
      const after = applyPatchText(before, op)
      diff = after === undefined
        ? `(patch would fail: old_string not found in ${filePath})`
        : unifiedDiff(before, after, filePath)
      if (after !== undefined) staged.set(stagedKey(name, filePath), after)
    } else if (action === 'write_file') {
      const before = await baseOf(name, filePath)
      const after = String(op.content || '')
      diff = unifiedDiff(before, after, filePath)
      staged.set(stagedKey(name, filePath), after)
    } else if (action === 'remove_file') {
      const before = await baseOf(name, filePath)
      diff = unifiedDiff(before, '', filePath)
      staged.set(stagedKey(name, filePath), '')
    } else if (action === 'delete') {
      const before = await baseOf(name, 'SKILL.md')
      diff = unifiedDiff(before, '', 'SKILL.md')
      staged.set(stagedKey(name, 'SKILL.md'), '')
    } else {
      diff = `(no diff renderer for action '${action}')`
    }
    if (operations.length === 1) {
      parts.push(diff)
    } else {
      parts.push(`## op ${i + 1}/${operations.length}: ${gist}\n\n${diff}`)
    }
  }
  return parts.join('\n\n') || '(empty batch)'
}

/** hermes `/skills diff <id>`. */
async function diffCommand (args) {
  const target = args[0]
  if (target === undefined) return 'Usage: /skills diff <id>'
  const rows = await pendingRows('skills')
  const row = rows.find((entry) => entry.id === target)
  if (row === undefined) return `No pending skill write with id '${target}'.`
  return `# Pending skill write ${row.id}: ${row.summary || ''}\n\n${await skillPendingDiff(row)}`
}

/** hermes `_set_approval`. */
async function setApproval (subsystem, args, deps) {
  const arg = args[0] === undefined ? '' : args[0].trim().toLowerCase()
  if (arg === '') return `${stateLine(subsystem, deps.settings)}\nSet with: /${subsystem} approval <on|off>`
  const enabled = APPROVAL_VALUES.get(arg)
  if (enabled === undefined) return `Invalid value '${arg}'. Use: on or off.`
  const patch = subsystem === 'skills' ? { skillsWriteApproval: enabled } : { memoryWriteApproval: enabled }
  try {
    await deps.persistSettings(patch)
  } catch (error) {
    return `Failed to set ${subsystem}.write_approval: ${error && error.message ? error.message : error}`
  }
  return `${subsystem}.write_approval set to '${enabled ? 'on' : 'off'}'.`
}

/** Dispatch `/skills` and `/memory`; returns `undefined` when the subcommand is not ours. */
async function handleApprovalCommand (subsystem, rawInput, deps) {
  const args = splitArgs(rawInput)
  if (args.length === 0) return `${stateLine(subsystem, deps.settings)}\n\n${await formatPendingList(subsystem)}`
  const sub = args[0].toLowerCase()
  const rest = args.slice(1)
  if (sub === 'pending') return formatPendingList(subsystem)
  if (sub === 'approve' || sub === 'apply') return approve(subsystem, rest, deps)
  if (sub === 'reject' || sub === 'deny' || sub === 'drop') return reject(subsystem, rest)
  if (sub === 'diff' && subsystem === 'skills') return diffCommand(rest)
  if (sub === 'approval' || sub === 'mode') return setApproval(subsystem, rest, deps)
  return undefined
}

// ── /curator ───────────────────────────────────────────────────────────────

/** `_fmt_ts`: relative age, never a wall clock. */
function relativeAge (ts) {
  if (ts === undefined || ts === null || ts === '') return 'never'
  const parsed = Date.parse(String(ts))
  if (Number.isNaN(parsed)) return String(ts)
  const secs = Math.max(0, Math.floor((Date.now() - parsed) / 1000))
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

function formatInterval (hours) {
  const ih = Number(hours) || 0
  return ih % 24 === 0 && ih >= 24 ? `${ih / 24}d` : `${ih}h`
}

/** `_print_curator_config`. */
async function curatorConfigText (deps) {
  const state = await curator.loadState()
  const settings = deps.settings
  const statusLine = state.paused === true ? 'PAUSED' : (settings.curatorEnabled !== false ? 'ENABLED' : 'DISABLED')
  const lines = [
    `curator: ${statusLine}`,
    `  runs:           ${state.run_count || 0}`,
    `  last run:       ${relativeAge(state.last_run_at)}`,
  ]
  const summary = state.last_run_summary || '(none)'
  const [first, ...rest] = String(summary).includes('\n') ? String(summary).split('\n') : [summary]
  lines.push(`  last summary:   ${first}`)
  for (const line of rest) lines.push(`                  ${line}`)
  if (state.last_report_path) {
    lines.push(`  last report:    ${state.last_report_path}${await util.exists(state.last_report_path) ? '' : ' (missing)'}`)
  }
  lines.push(`  interval:       every ${formatInterval(settings.curatorIntervalHours)}`)
  lines.push(`  stale after:    ${settings.curatorStaleDays}d unused`)
  lines.push(`  archive after:  ${settings.curatorArchiveDays}d unused`)
  const consolidate = settings.curatorConsolidate === true
  lines.push(`  consolidate:    ${consolidate ? 'on' : 'off'}${consolidate ? '' : ' (prune-only; LLM merge pass opt-in)'}`)
  return lines.join('\n')
}

/** `_print_skill_rows`: a titled state/usage table. */
function skillRowsText (title, rows) {
  if (rows.length === 0) return ''
  const lines = ['', `${title}:`, `  ${'name'.padEnd(34)} ${'state'.padEnd(9)} last used`]
  for (const row of rows) {
    lines.push(`  ${String(row.name).padEnd(34)} ${String(row.state || 'active').padEnd(9)} ${relativeAge(row.lastActivityAt)}`)
  }
  return lines.join('\n')
}

/** `/curator status` (hermes `_cmd_status`). */
async function curatorStatusText (deps) {
  const lines = [await curatorConfigText(deps)]
  const skills = await store.scanSkills()
  const usage = await skillUsage.loadUsage()
  const rows = skills.map((skill) => {
    const record = skillUsage.backfill(usage[skill.name])
    return {
      name: skill.name,
      state: record.state || 'active',
      pinned: record.pinned === true,
      lastActivityAt: skillUsage.latestActivityAt(record),
      activityCount: skillUsage.activityCount(record),
      managed: skillUsage.isCuratorManagedRecord(record),
    }
  })
  const managed = rows.filter((row) => row.managed)
  if (managed.length === 0) {
    lines.push('\nno curator-managed skills')
    return lines.join('\n')
  }
  const byState = { active: [], stale: [], archived: [] }
  for (const row of managed) (byState[row.state] || byState.active).push(row)
  const pinned = managed.filter((row) => row.pinned).map((row) => row.name)
  lines.push(`\ncurator-managed skills: ${managed.length} total`)
  for (const stateName of ['active', 'stale', 'archived']) {
    lines.push(`  ${stateName.padEnd(10)} ${byState[stateName].length}`)
  }
  if (pinned.length > 0) lines.push(`\npinned (${pinned.length}): ${pinned.join(', ')}`)
  const active = byState.active
  if (active.length === 0) return lines.join('\n')
  const recency = [...active].sort((a, b) => String(a.lastActivityAt || '').localeCompare(String(b.lastActivityAt || '')))
  lines.push(skillRowsText('least recently active (top 5)', recency.slice(0, 5)))
  const freq = (row) => [row.activityCount || 0, row.lastActivityAt || '']
  const mostActive = [...active].sort((a, b) => {
    const [ca, la] = freq(a)
    const [cb, lb] = freq(b)
    return cb - ca || String(lb).localeCompare(String(la))
  }).slice(0, 5)
  if ((mostActive[0].activityCount || 0) > 0) lines.push(skillRowsText('most active (top 5)', mostActive))
  const leastActive = [...active].sort((a, b) => {
    const [ca, la] = freq(a)
    const [cb, lb] = freq(b)
    return ca - cb || String(la).localeCompare(String(lb))
  }).slice(0, 5)
  lines.push(skillRowsText('least active (top 5)', leastActive))
  return lines.join('\n')
}

/** `/curator run [--dry-run] [--consolidate]` (hermes `_cmd_run`). */
async function curatorRunText (args, deps) {
  if (deps.settings.curatorEnabled === false) return 'curator: disabled via config; enable with `curator.enabled: true`'
  const dry = args.includes('--dry-run') || args.includes('-n')
  const consolidate = args.includes('--consolidate') ? true : undefined
  const out = [dry ? 'curator: running DRY-RUN (report only, no mutations)...' : 'curator: running review pass...']
  if (consolidate === undefined && deps.settings.curatorConsolidate !== true) {
    out.push('curator: consolidation is off — running prune-only (deterministic stale/archive). Pass --consolidate or set `curator.consolidate: true` to enable the LLM merge pass.')
  }
  let result
  try {
    result = await deps.runCuratorNow({ dryRun: dry, consolidate })
  } catch (error) {
    return `curator: run failed: ${error && error.message ? error.message : error}`
  }
  const auto = (result && result.automatic) || {}
  if (Object.keys(auto).length > 0) {
    if (dry) {
      out.push(`auto (preview): ${auto.checked || 0} candidate skill(s) — no transitions applied in dry-run`)
    } else {
      out.push(`auto: checked=${auto.checked || 0} stale=${auto.markedStale || 0} archived=${(auto.archived || []).length} reactivated=${auto.reactivated || 0}`)
    }
  }
  if (dry) {
    out.push('dry-run: no changes applied. Read the report with `/curator status` and run `/curator run` (no flag) to apply.')
  }
  return out.join('\n')
}

/** `/curator pin|unpin <name>` (`_set_pin`, messages without the absent `adopt` hint). */
async function curatorPinText (args, pinned) {
  const name = args[0]
  if (name === undefined) return `Usage: /curator ${pinned ? 'pin' : 'unpin'} <skill>`
  const usage = await skillUsage.loadUsage()
  const record = skillUsage.backfill(usage[name])
  if (record.created_by !== 'agent' && record.agent_created !== true) {
    const reason = pinned
      ? 'cannot pin (only agent-created skills participate in curation)'
      : "there's nothing to unpin (curator only tracks agent-created skills)"
    return `curator: '${name}' is bundled or hub-installed — ${reason}.`
  }
  await skillUsage.setPinned(name, pinned)
  const managed = skillUsage.isCuratorManagedRecord(record)
  if (pinned) {
    return managed
      ? `curator: pinned '${name}' (will bypass auto-transitions)`
      : `curator: pinned '${name}' (recorded; this skill is unmanaged — auto-transitions never consider it)`
  }
  return managed
    ? `curator: unpinned '${name}'`
    : `curator: unpinned '${name}' (recorded; this skill was never under auto-transitions to begin with)`
}

/** `/curator restore <name>` (`_as_user(restore_skill)` prints `curator: <msg>`). */
async function curatorRestoreText (args) {
  const name = args[0]
  if (name === undefined) return 'Usage: /curator restore <skill>'
  const outcome = await curator.restoreArchived(name)
  return `curator: ${outcome.message}`
}

/** `/curator list-archived`. */
async function curatorArchivedText () {
  const names = await curator.listArchivedNames()
  return names.length === 0 ? 'curator: no archived skills' : names.join('\n')
}

/** Dispatch `/curator`. */
async function handleCuratorCommand (rawInput, deps) {
  const args = splitArgs(rawInput)
  if (args.length === 0 || args[0] === 'status') return curatorStatusText(deps)
  const sub = args[0]
  const rest = args.slice(1)
  if (sub === 'run') return curatorRunText(rest, deps)
  if (sub === 'pause') {
    await curator.setPaused(true)
    return 'curator: paused'
  }
  if (sub === 'resume') {
    await curator.setPaused(false)
    return 'curator: resumed'
  }
  if (sub === 'pin') return curatorPinText(rest, true)
  if (sub === 'unpin') return curatorPinText(rest, false)
  if (sub === 'restore') return curatorRestoreText(rest)
  if (sub === 'list-archived') return curatorArchivedText()
  if (sub === 'consolidate') return curatorRunText(['--consolidate'], deps)
  return `curator: unknown subcommand '${sub}' (status, run, pause, resume, pin, unpin, restore, list-archived)`
}

// ── /refine and /learn ─────────────────────────────────────────────────────

/** `/refine [focus]` (hermes `_handle_refine_command`, en.yaml refine.*). */
async function handleRefineCommand (rawInput, invocation, deps) {
  const focus = String(rawInput || '').trim()
  const agent = invocation !== null && typeof invocation === 'object' ? invocation.agent : undefined
  if (agent === null || typeof agent !== 'object') return { kind: 'success', text: 'Refine unavailable (no session).' }
  const session = agent.session
  const messages = session !== undefined ? await reviewMessages(session) : []
  if (messages.length === 0) {
    return { kind: 'success', text: 'Nothing to refine yet — the conversation is empty.' }
  }
  const review = require('./review')
  const sessionId = session !== null && session !== undefined && typeof session.id === 'string' ? session.id : ''
  if (sessionId !== '' && review.inFlightSessions.has(sessionId)) {
    return { kind: 'success', text: 'A review of this conversation is already running — its result will be reported when done.' }
  }
  try {
    if (sessionId !== '') review.inFlightSessions.add(sessionId)
    void deps.runReview(deps.hostCtx, {
      cwd: session !== null && session !== undefined && session.header && session.header.cwd
        ? session.header.cwd
        : process.cwd(),
      messages,
      reviewMemory: true,
      reviewSkills: deps.hasSkillManage() === true,
      focus: focus === '' ? undefined : focus,
      settings: deps.settings,
      logger: deps.logger,
    }).then((result) => {
      if (result && result.ok && result.summary) review.appendReviewNotice(session, result, deps.logger)
    }).catch((error) => deps.logger.warn?.(`[hermes-evolve] /refine failed: ${error && error.message ? error.message : error}`))
      .finally(() => { review.inFlightSessions.delete(sessionId) })
  } catch (error) {
    review.inFlightSessions.delete(sessionId)
    return { kind: 'success', text: `/refine failed to start: ${error && error.message ? error.message : error}` }
  }
  const tail = focus === '' ? '' : ` (focus: ${focus})`
  return { kind: 'success', text: `  ⚗ Reviewing this conversation in the background${tail} — any memory/skill updates will be reported when done.` }
}

/** The live transcript in fork-message shape (same snapshot the scheduler uses). */
async function reviewMessages (session) {
  const review = require('./review')
  return review.snapshotMessages(session)
}

/** `/learn <request>` (hermes `_handle_learn_command`, en.yaml learn.*). */
async function handleLearnCommand (rawInput, invocation, deps) {
  const request = String(rawInput || '').trim()
  const prompt = deps.learnPrompt.buildLearnPrompt(request)
  const agent = invocation !== null && typeof invocation === 'object' ? invocation.agent : undefined
  try {
    if (agent === null || typeof agent !== 'object' || typeof agent.followup !== 'function') {
      return { kind: 'success', text: '/learn needs an active chat session to run.' }
    }
    await agent.followup({
      id: deps.randomId(),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    })
  } catch (error) {
    return { kind: 'error', text: `/learn failed to queue the turn: ${error && error.message ? error.message : error}` }
  }
  return {
    kind: 'success',
    text: request === '' ? 'Learning a skill from this conversation…' : 'Learning a skill from what you described…',
  }
}

// ── registration ───────────────────────────────────────────────────────────

/** The command definitions, in Hermes' order of appearance. */
function definitions (deps) {
  const guard = (handler) => async (invocation) => {
    try {
      const result = await handler(invocation)
      return result === undefined ? { kind: 'error', text: 'unknown subcommand' } : result
    } catch (error) {
      deps.logger.warn?.(`[hermes-evolve] command failed: ${error && error.stack ? error.stack : error}`)
      return { kind: 'error', text: error && error.message ? error.message : String(error) }
    }
  }
  return [
    {
      name: 'skills',
      description: 'Skill writes awaiting approval (pending, approve, reject, diff, approval)',
      input: { hint: 'pending | approve <id|all> | reject <id|all> | diff <id> | approval <on|off>' },
      handler: guard(async (invocation) => {
        const text = await handleApprovalCommand('skills', invocation.rawInput, deps)
        return text === undefined ? { kind: 'error', text: 'Usage: /skills pending|approve|reject|diff|approval' } : { kind: 'success', text }
      }),
    },
    {
      name: 'memory',
      description: 'Memory writes awaiting approval (pending, approve, reject, approval)',
      input: { hint: 'pending | approve <id|all> | reject <id|all> | approval <on|off>' },
      handler: guard(async (invocation) => {
        const text = await handleApprovalCommand('memory', invocation.rawInput, deps)
        return text === undefined ? { kind: 'error', text: 'Usage: /memory pending|approve|reject|approval' } : { kind: 'success', text }
      }),
    },
    {
      name: 'curator',
      description: 'Background skill maintenance (status, run, pause, resume, pin, unpin, restore, list-archived)',
      input: { hint: 'status | run [--dry-run] [--consolidate] | pause | resume | pin <s> | unpin <s> | restore <s> | list-archived' },
      handler: guard(async (invocation) => ({ kind: 'success', text: await handleCuratorCommand(invocation.rawInput, deps) })),
    },
    {
      name: 'refine',
      description: 'Review this conversation now and save lessons to memory/skills',
      input: { hint: '[focus]' },
      recordInput: true,
      handler: guard((invocation) => handleRefineCommand(invocation.rawInput, invocation, deps)),
    },
    {
      name: 'learn',
      description: 'Learn a reusable skill from anything you describe (dirs, URLs, this chat, notes)',
      input: { hint: '<what to learn from>' },
      recordInput: true,
      handler: guard((invocation) => handleLearnCommand(invocation.rawInput, invocation, deps)),
    },
  ]
}

/** Register every command; returns the disposer (caller owns it). */
function registerCommands (ctx, deps) {
  const disposers = []
  for (const definition of definitions(deps)) {
    try {
      disposers.push(ctx.commands.register(definition))
    } catch (error) {
      deps.logger.warn?.(`[hermes-evolve] cannot register /${definition.name}: ${error && error.message ? error.message : error}`)
    }
  }
  return () => {
    for (const dispose of disposers) { try { dispose() } catch { /* gone */ } }
  }
}

module.exports = {
  registerCommands,
  definitions,
  splitArgs,
  unifiedDiff,
  applyPatchText,
  relativeAge,
  formatInterval,
  stateLine,
  formatPendingList,
  matchedEntryLines,
  changedEntries,
  handleApprovalCommand,
  handleCuratorCommand,
  handleRefineCommand,
  handleLearnCommand,
  curatorStatusText,
  skillPendingDiff,
}