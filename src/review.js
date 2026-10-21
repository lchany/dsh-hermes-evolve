'use strict'

/**
 * The background review fork, ported from hermes `agent/background_review.py`.
 *
 * What happens: after a turn ends, a forked agent re-reads a transcript snapshot
 * and decides whether anything should be written to the skill library or to
 * memory. It acts by calling the same four tools the main agent has —
 * `skills_list`, `skill_view`, `skill_manage`, `memory` — which are registered
 * into the fork's OWN tool layer. Writes land on disk immediately, so the next
 * turn (and the next session) sees them; the main conversation and its prompt
 * cache are never touched. That is the whole self-evolution loop.
 *
 * Faithfulness notes:
 *  - Hermes delivers the review prompt as the fork's USER MESSAGE
 *    (`run_conversation(user_message=prompt + tool_suffix, conversation_history=...)`)
 *    and never rewrites the system prompt — the fork keeps the parent's cached
 *    prompt so the review rides the same prefix cache. We do the same: the
 *    prompt goes in the user message, no system-prompt section is installed.
 *  - Triggers match hermes: skill review fires at a tool-iteration interval,
 *    memory review at a user-turn interval, both only on a completed turn with a
 *    delivered response, and each resets its own counter when it fires.
 *  - The fork never waits on the user; approval, when enabled, is staged for the
 *    panel and the review itself completes either way.
 */

const { randomUUID } = require('node:crypto')

const store = require('./skill_store')
const usage = require('./skill_usage')
const prompts = require('./prompts')
const { buildToolSet } = require('./skill_tools')

const TRANSCRIPT_MESSAGE_CHARS = 4000

// ── dispatch-side review whitelist (D4) ───────────────────────────────────
//
// Hermes does not only narrow the tools it ADVERTISES to a review fork; it also
// enforces a whitelist at dispatch time through a thread-local
// (`hermes_cli/plugins.py:set_thread_tool_whitelist`) and refuses anything else
// with a fixed sentence (`agent/background_review.py:1153-1170`). Advertising
// alone is insufficient: a model can still emit a call to a tool it was told
// about earlier in the transcript, and an MCP/plugin tool registered between
// fork creation and dispatch would slip through. This module owns the same
// state so `apply()` can install one `tools/pre-execute` listener over it.

const REVIEW_SESSION_PREFIX = 'hermes-evolve-review-'

/** Tools a review fork may call by name. Mirrors `_review_tool_whitelist`. */
const REVIEW_TOOL_ALLOW = Object.freeze(['skills_list', 'skill_view', 'skill_manage', 'read', 'glob', 'grep'])

/**
 * Review sessions currently in flight, mapped to their scope. A Map (not a
 * session-id test alone) because whether `memory` is in scope is decided per
 * review pass (`review_memory`), exactly like `_review_tool_whitelist`.
 */
const REVIEW_MIN_SPACING_MS = 30 * 60 * 1000
const reviewBudgets = new Map()
const reviewSessions = new Map()

/** The policy for a session id, or undefined when it is not a live review fork. */
function reviewSessionPolicy (sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.startsWith(REVIEW_SESSION_PREFIX)) return undefined
  return reviewSessions.get(sessionId)
}

/** Whether a review fork in `policy`'s scope may dispatch `toolName`. */
function reviewToolAllowed (toolName, policy) {
  if (typeof toolName !== 'string') return true
  if (REVIEW_TOOL_ALLOW.includes(toolName)) return true
  return policy !== undefined && policy.memory === true && toolName === 'memory'
}

/**
 * Hermes' denial sentence, verbatim, with the read-tool list mapped to this
 * runtime's equivalents (`read_file`→`read`, `search_files`→`glob`/`grep`).
 * `reason` on a `{kind:'deny'}` decision is the model-facing text.
 */
function reviewDenyReason (toolName, policy) {
  const memoryAllowed = policy !== undefined && policy.memory === true
  const memoryPhrase = memoryAllowed ? ' and memory for notes (add only)' : ''
  return `Background review denied non-whitelisted tool: ${toolName}. Allowed here: `
    + 'skill_view/skills_list/read/glob/grep to read, '
    + `skill_manage(action='patch'|...) to change skills${memoryPhrase}. `
    + `Do not retry ${toolName}.`
}

// ── transcript rendering ───────────────────────────────────────────────────

function contentToText (content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'reasoning' && typeof block.text === 'string') continue
    else if (block.type === 'tool-call' || block.type === 'tool_call') {
      parts.push(`[tool call ${block.name || ''} ${typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments || {})}]`)
    } else if (typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Keep the TAIL: the lesson almost always comes from the last few exchanges, and
 * a truncated head is worse than no head at all (the model cannot tell what it
 * is looking at).
 */
function renderTranscript (messages, { maxChars = 12000, maxMessages = 40 } = {}) {
  const rows = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const role = message.role
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') continue
    const source = message.source && message.source.kind ? message.source.kind : ''
    if (role === 'user' && source !== 'user' && source !== 'system-prompt') {
      // Injected context (catalog, skill bodies, notices) is not the conversation.
      if (source !== 'plugin' && source !== 'agent' && source !== 'subagent') continue
    }
    let text = contentToText(message.content)
    if (text === '') continue
    if (text.length > TRANSCRIPT_MESSAGE_CHARS) text = `${text.slice(0, TRANSCRIPT_MESSAGE_CHARS)}\n[...truncated]`
    const label = role === 'assistant' ? 'Assistant' : role === 'user' ? 'User' : 'Tool result'
    rows.push(`### ${label}\n${text}`)
  }
  const kept = rows.slice(-maxMessages)
  let joined = kept.join('\n\n')
  while (joined.length > maxChars && kept.length > 1) {
    kept.shift()
    joined = kept.join('\n\n')
  }
  if (joined.length > maxChars) joined = `${joined.slice(0, maxChars)}\n[...transcript truncated]`
  return joined
}

// ── the fork ───────────────────────────────────────────────────────────────

/**
 * Spawn one review pass. Returns a result object; never throws.
 *
 * @param {object} hostCtx  the plugin's context (has `.agents`, `.tools`, `.agentDefaultModel`)
 */
/**
 * hermes `_REVIEW_MAX_ITERATIONS`: a review fork may take at most N tool-iteration
 * steps before the host stops it. DSH exposes no max-steps option, so the cap is
 * enforced at dispatch: past the budget every tool call is denied with a reason
 * telling the model to answer with what it has (Hermes aborts the run outright).
 */
function reviewBudget (sessionId) { return reviewBudgets.get(sessionId) }

function consumeReviewIteration (sessionId) {
  const budget = reviewBudgets.get(sessionId)
  if (budget === undefined) return null
  budget.used += 1
  return { used: budget.used, max: budget.max, allowed: budget.used <= budget.max }
}

function reviewBudgetReason (used, max) {
  return `Background review reached its ${max}-step tool budget (${used} used). `
    + 'Stop calling tools and answer with what you already have.'
}

async function runReview (hostCtx, options) {
  const {
    cwd,
    messages,
    reviewMemory,
    reviewSkills,
    settings,
    logger,
    focus,
    model,
  } = options
  const startedAt = Date.now()
  const transcript = renderTranscript(messages, {
    maxChars: settings.maxTranscriptChars,
    maxMessages: settings.maxTranscriptMessages,
  })
  if (transcript.trim() === '') return { ok: false, skipped: 'empty-transcript' }

  // hermes: the memory toolset enters the whitelist only when the memory
  // dimension actually fired AND memory is enabled; the prompt suffix follows
  // the same flag so the fork is never told about a tool it cannot call.
  const memoryAllowed = reviewMemory === true && settings.memoryEnabled !== false
  const reason = prompts.reviewPrompt({ reviewMemory, reviewSkills })
  const extra = typeof focus === 'string' && focus.trim() !== '' ? `\n\nFocus requested by the user: ${focus}` : ''
  const userMessage = prompts.buildReviewMessage({ transcript, prompt: reason, memoryAllowed }) + extra

  const controller = new AbortController()
  const marks = store.makeReadMarks()
  const tools = buildToolSet({
    marks,
    // Unattended review: what it creates is curator-managed (Hermes records
    // `created_by: 'agent'` for these, `'learn'` for user-directed writes).
    agentCreated: true,
    actor: 'review',
    requireReadBeforeWrite: true,
    linterEnabled: settings.linterEnabled !== false,
    ledgerEnabled: settings.ledgerEnabled !== false,
    supportFilesEnabled: settings.supportFilesEnabled !== false,
    maxSupportFileChars: settings.maxSupportFileChars,
    maxBodyChars: settings.maxBodyChars,
    memoryCharLimit: settings.memoryCharLimit,
    userCharLimit: settings.userCharLimit,
    includeMemory: memoryAllowed,
    // Same announcement path as the foreground tool: a memory write that lands
    // from the review fork is still a native write an external provider mirrors.
    onMemoryWrite: (rows) => {
      try { hostCtx.emit('hermes-evolve/memory-write', { rows }) } catch { /* no listeners */ }
    },
    // The fork is unattended: memory replace/remove are staged for a human,
    // never applied silently (hermes #105921).
    unattendedMemory: true,
    // Approval mode: the fork may read and propose, but a human lands the write.
    writeApproval: settings.skillsWriteApproval === true,
    memoryApproval: settings.memoryWriteApproval === true,
    lang: settings.lang,
  })

  const selected = model && (model.provider || model.model)
    ? model
    : (() => {
        try { return hostCtx.agentDefaultModel.currentSelection() } catch { return undefined }
      })()

  // Register the session's dispatch policy BEFORE the fork exists: the listener
  // installed in apply() looks it up by session id, and the first tool call can
  // land as soon as the fork starts.
  const sessionId = `${REVIEW_SESSION_PREFIX}${randomUUID()}`
  reviewSessions.set(sessionId, { memory: memoryAllowed })
  reviewBudgets.set(sessionId, {
    used: 0,
    max: settings.reviewMaxIterations > 0 ? settings.reviewMaxIterations : 16,
  })

  let handle
  const timer = setTimeout(() => {
    try { controller.abort() } catch { /* already aborted */ }
  }, Math.max(30, settings.reviewTimeoutSec) * 1000)

  try {
    handle = await hostCtx.agents.create({
      sessionId,
      meta: { cwd, origin: 'subagent', agentPreset: 'standard', isSeeded: false },
      agentOptions: selected && (selected.provider || selected.model)
        ? { ...(selected.provider ? { provider: selected.provider } : {}), ...(selected.model ? { model: selected.model } : {}) }
        : {},
      signal: controller.signal,
      setup (agentCtx) {
        // The review tools live in the fork's own layer, so the main
        // conversation's tool surface is unchanged.
        for (const definition of tools) agentCtx.tools.register(definition)
        restrictInheritedTools(agentCtx, logger)
      },
    })
    const agent = handle.agent
    if (controller.signal.aborted) throw Object.assign(new Error('review timed out during creation'), { code: 'ETIMEDOUT' })
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: userMessage }],
      source: { kind: 'user' },
    })
    await agent.whenIdle()
    const summary = lastAssistantText(agent)
    const usageStats = sumReviewUsage(agent)
    const actions = collectReviewActions(agent, settings.lang)
    logger?.info?.(`[hermes-evolve] review finished in ${Date.now() - startedAt}ms (skills=${reviewSkills} memory=${reviewMemory})`)
    return {
      ok: true,
      summary: summary.slice(0, 2000),
      scope: { reviewMemory, reviewSkills },
      durationMs: Date.now() - startedAt,
      usage: usageStats,
      model: selected,
      actions,
      lang: recapLang(settings.lang),
    }
  } catch (error) {
    const reason = error && error.message ? error.message : String(error)
    logger?.warn?.(`[hermes-evolve] review failed: ${reason}`)
    return { ok: false, error: reason, durationMs: Date.now() - startedAt }
  } finally {
    clearTimeout(timer)
    reviewSessions.delete(sessionId)
    reviewBudgets.delete(sessionId)
    if (handle !== undefined) {
      try { await handle.dispose() } catch { /* already gone */ }
    }
  }
}

/**
 * The fork inherits the session's global tool surface. Keep only genuinely
 * read-only context tools: hermes learned the hard way (#61521 / #39996) that
 * denying read access outright produced per-review denial storms and ~200
 * failed read-before-write retries in two days, because the model could not
 * inspect what it was told to patch.
 */
function restrictInheritedTools (agentCtx, logger) {
  let globalNames = []
  try {
    globalNames = agentCtx.tools.schemas().map((schema) => schema.name)
  } catch (error) {
    logger?.debug?.(`[hermes-evolve] cannot enumerate inherited tools: ${error && error.message}`)
    return
  }
  const ours = new Set(['skills_list', 'skill_view', 'skill_manage', 'memory'])
  const inherited = globalNames.filter((name) => !ours.has(name))
  if (inherited.length === 0) return
  // The advertised surface and the dispatch whitelist must agree, or a tool
  // would be shown and then denied — the denial storm hermes fixed in #39996.
  const allow = inherited.filter((name) => REVIEW_TOOL_ALLOW.includes(name))
  try {
    if (allow.length > 0) agentCtx.tools.restrict({ allow })
    else agentCtx.tools.restrict({ deny: inherited })
  } catch (error) {
    logger?.debug?.(`[hermes-evolve] cannot restrict inherited tools: ${error && error.message}`)
  }
}

function lastAssistantText (agent) {
  try {
    const events = agent.session.snapshotEvents()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event.type !== 'assistant/message') continue
      const text = contentToText(event.data && event.data.message ? event.data.message.content : [])
      if (text !== '') return text
    }
  } catch { /* session shape drift is not worth failing a review over */ }
  return ''
}

function sumReviewUsage (agent) {
  const totals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
  try {
    for (const event of agent.session.snapshotEvents()) {
      if (event.type !== 'assistant/message' || !event.data || !event.data.usage) continue
      const usageStats = event.data.usage
      totals.inputTokens += usageStats.inputTokens || 0
      totals.outputTokens += usageStats.outputTokens || 0
      totals.cachedInputTokens += usageStats.cachedInputTokens || usageStats.cacheReadInputTokens || 0
    }
  } catch { /* best effort */ }
  return totals
}

// ── scheduling (the counter half of turn_finalizer) ────────────────────────

/** Sessions with a review fork running. Shared by the automatic scheduler and
 *  `/refine`, so an on-demand review never races the post-turn one. */
const inFlightSessions = new Set()

/**
 * Per-session counters. hermes keeps these on the AIAgent instance; a host-plane
 * plugin sees every session's events, so the map is keyed by session id.
 */
function createScheduler ({ hostCtx, settings, logger, runReview: reviewImpl, now = Date.now }) {
  const doReview = typeof reviewImpl === 'function' ? reviewImpl : runReview
  const sessions = new Map()
  const inFlight = inFlightSessions

  function stateOf (sessionId) {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = {
        sessionId,
        itersSinceSkill: 0,
        turnsSinceMemory: 0,
        lastTurnHadResponse: false,
        lastTurnInterrupted: false,
        lastAssistantText: '',
        lastUserMessage: '',
        pendingSkill: false,
        pendingMemory: false,
        lastReviewAt: 0,
      }
      sessions.set(sessionId, state)
    }
    return state
  }

  function messageText (message) {
    return contentToText(message && message.content ? message.content : [])
  }

  /**
   * Feed one session event. Called by the plugin's `session/event` listener.
   * Returns a promise that resolves when any triggered review completes, so the
   * caller can bound concurrency; production code should not await it.
   */
  async function onEvent (session, event) {
    if (event === null || typeof event !== 'object' || settings.enabled === false) return
    // hermes shuts the loop off inside its own forks (`_memory_nudge_interval =
    // _skill_nudge_interval = 0`, agent/background_review.py:987) and never
    // spawns a review for a delegated agent (no memory tool, no skill_manage).
    // one guard covers both: forks and subagents carry origin 'subagent'.
    if (session !== null && typeof session === 'object' && session.header && session.header.origin === 'subagent') return
    const state = stateOf(session.id)
    switch (event.type) {
      case 'step/end': {
        state.itersSinceSkill += 1
        break
      }
      case 'user/message': {
        const data = event.data || {}
        const kind = data.source && data.source.kind ? data.source.kind : ''
        if (kind === 'user') {
          state.turnsSinceMemory += 1
          state.lastUserMessage = messageText(data)
        }
        break
      }
      case 'assistant/message': {
        const data = event.data || {}
        if (data.interrupted === true) state.lastTurnInterrupted = true
        const text = messageText(data.message)
        if (text !== '') state.lastAssistantText = text
        break
      }
      case 'turn/end': {
        const reason = event.data && event.data.reason ? event.data.reason.kind : 'completed'
        const interrupted = reason !== 'completed' || state.lastTurnInterrupted
        const skillInterval = settings.skillNudgeInterval > 0 ? settings.skillNudgeInterval : 0
        const memoryInterval = settings.memoryEnabled !== false && settings.memoryNudgeInterval > 0
          ? settings.memoryNudgeInterval
          : 0
        const fireSkills = skillInterval > 0 && state.itersSinceSkill >= skillInterval
        const fireMemory = memoryInterval > 0 && state.turnsSinceMemory >= memoryInterval
        const hadResponse = state.lastAssistantText.trim() !== ''
        const transcript = snapshotMessages(session)
        state.lastAssistantText = ''
        state.lastTurnInterrupted = false
        state.lastUserMessage = ''
        if (interrupted || !hadResponse || (!fireSkills && !fireMemory)) return
        // hermes detaches a background review but refuses to start another one for
        // the same conversation inside 1800s (agent/background_review.py:78-98).
        // Counters are only consumed when a pass actually starts, so a throttled
        // trigger retries on the next completed turn instead of being lost.
        if (now() - state.lastReviewAt < REVIEW_MIN_SPACING_MS) {
          logger?.debug?.('[hermes-evolve] review throttled (started <30m ago); keeping the trigger')
          return
        }
        const key = session.id
        if (inFlight.has(key)) {
          logger?.debug?.('[hermes-evolve] review already in flight for this session; skipping')
          return
        }
        if (fireSkills) state.itersSinceSkill = 0
        if (fireMemory) state.turnsSinceMemory = 0
        state.lastReviewAt = now()
        inFlight.add(key)
        try {
          const result = await doReview(hostCtx, {
            cwd: session.header && session.header.cwd ? session.header.cwd : process.cwd(),
            messages: transcript,
            reviewMemory: fireMemory,
            reviewSkills: fireSkills,
            settings,
            logger,
          })
          if (result.ok && result.summary) {
            appendReviewNotice(session, result, logger)
          }
        } finally {
          inFlight.delete(key)
        }
        break
      }
      default:
        break
    }
  }

  return { onEvent, stateOf, inFlight }
}

/**
 * The main session's message list. `deriveMessages()` includes injected context
 * as user-role messages; renderTranscript filters the ones that are not
 * conversation.
 */
function snapshotMessages (session) {
  try {
    const messages = session.deriveMessages()
    return Array.isArray(messages) ? messages.slice(-200) : []
  } catch {
    return []
  }
}

// ── self-improvement recap (hermes `_action_lines`) ───────────────────────
//
// Hermes publishes what the loop actually changed, built from the fork's
// SUCCESSFUL tool results rather than from the request (an approval gate or a
// failed write can leave every requested operation unapplied):
//
//     💾 自我改进回顾：技能 'demo' 已修补 · 记忆已更新
//
// The per-action strings mirror hermes locales/zh.yaml:3428-3442 and
// locales/en.yaml:3534-3547; the recap is published only when something landed.

const RECAP_VERBS = {
  zh: { create: '已创建', patch: '已修补', write_file: '已写入', remove_file: '已移除', delete: '已删除' },
  en: { create: 'created', patch: 'patched', write_file: 'written', remove_file: 'removed', delete: 'deleted' },
}
const RECAP = {
  zh: { skill: '技能', memory: '记忆', user: '用户画像', updated: '已更新', header: '💾 自我改进回顾：' },
  en: { skill: 'Skill', memory: 'Memory', user: 'User profile', updated: ' updated', header: '💾 Self-improvement review: ' },
}

function recapLang (lang) {
  return typeof lang === 'string' && /^en/i.test(lang.trim()) ? 'en' : 'zh'
}

/**
 * Action lines from a finished review fork (empty when nothing was written).
 * The fork runs with `isSeeded: false`, so its event log only holds this
 * review's calls — Hermes' #14944 filter for inherited history is not needed.
 */
function collectReviewActions (agent, lang) {
  const l = recapLang(lang)
  const verbs = RECAP_VERBS[l]
  const text = RECAP[l]
  const actions = []
  const calls = new Map()
  let events = []
  try {
    events = agent.session.snapshotEvents()
  } catch {
    return actions
  }
  for (const event of events) {
    if (event === null || typeof event !== 'object' || event.data === null) continue
    if (event.type === 'tool/call') {
      calls.set(event.data.callId, { name: event.data.name, arguments: event.data.arguments })
      continue
    }
    if (event.type !== 'tool/result') continue
    const message = event.data.message
    if (message === null || typeof message !== 'object' || message.isError === true) continue
    const call = calls.get(message.toolCallId)
    if (call === undefined) continue
    let payload
    try {
      payload = JSON.parse(contentToText(message.content))
    } catch {
      continue
    }
    if (payload === null || typeof payload !== 'object' || payload.success !== true) continue
    // A staged (approval-gated) write is a pending row, not a change.
    if (payload.staged === true) continue
    if (call.name === 'skill_manage') {
      if (!Array.isArray(payload.results)) continue
      for (const result of payload.results) {
        if (result === null || typeof result !== 'object') continue
        const verb = typeof result.action === 'string' ? verbs[result.action] : undefined
        if (verb === undefined || typeof result.name !== 'string') continue
        actions.push(`${text.skill} '${result.name}' ${verb}`)
      }
      continue
    }
    if (call.name !== 'memory') continue
    const applied = typeof payload.applied === 'number' ? payload.applied : 0
    if (applied <= 0) continue
    let args = {}
    try {
      args = typeof call.arguments === 'string' && call.arguments !== '' ? JSON.parse(call.arguments) : {}
    } catch {
      args = {}
    }
    const target = typeof args.target === 'string' ? args.target : ''
    actions.push(`${target === 'user' ? text.user : text.memory}${text.updated}`)
  }
  return [...new Set(actions)]
}

/** One-line notice back into the source session, so the user can see what the
 *  loop did without opening a panel. */
function appendReviewNotice (session, result, logger) {
  try {
    const lang = recapLang(result.lang)
    const labels = RECAP[lang]
    const actions = Array.isArray(result.actions) ? result.actions : []
    const scopes = []
    if (result.scope.reviewSkills) scopes.push('skills')
    if (result.scope.reviewMemory) scopes.push('memory')
    // hermes publishes the recap only when an action landed; keep the plain
    // completion line otherwise so a quiet review still leaves a trace.
    const summary = actions.length > 0
      ? `${labels.header}${actions.join(' · ')}`
      : lang === 'en'
        ? `Background review finished (${scopes.join(' + ')}, ${Math.round(result.durationMs / 1000)}s)`
        : `背景复盘完成（${scopes.join(' + ')}，${Math.round(result.durationMs / 1000)}s）`
    session.append('user/message', {
      content: [{ type: 'text', text: `[hermes-evolve] ${summary}` }],
      source: { kind: 'hermes-evolve', form: 'notice', plugin: 'hermes-evolve', summary },
    })
  } catch (error) {
    logger?.debug?.(`[hermes-evolve] cannot append review notice: ${error && error.message}`)
  }
}

module.exports = {
  renderTranscript,
  runReview,
  createScheduler,
  snapshotMessages,
  appendReviewNotice,
  collectReviewActions,
  recapLang,
  inFlightSessions,
  contentToText,
  lastAssistantText,
  sumReviewUsage,
  REVIEW_SESSION_PREFIX,
  REVIEW_TOOL_ALLOW,
  reviewSessionPolicy,
  reviewToolAllowed,
  REVIEW_MIN_SPACING_MS,
  reviewDenyReason,
  reviewBudget,
  consumeReviewIteration,
  reviewBudgetReason,
  // Tests drive the in-flight registry directly; production only touches it
  // through runReview().
  __reviewSessions: reviewSessions,
  __reviewBudgets: reviewBudgets,
}