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
  const memoryAllowed = reviewMemory === true && settings.memoryEnabled !== false && settings.memoryMode !== 'off'
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
    // The fork is unattended: memory replace/remove are staged for a human,
    // never applied silently (hermes #105921).
    unattendedMemory: true,
    // Approval mode: the fork may read and propose, but a human lands the write.
    writeApproval: settings.mode === 'approval',
    lang: settings.lang,
  })

  const selected = model && (model.provider || model.model)
    ? model
    : (() => {
        try { return hostCtx.agentDefaultModel.currentSelection() } catch { return undefined }
      })()

  let handle
  const timer = setTimeout(() => {
    try { controller.abort() } catch { /* already aborted */ }
  }, Math.max(30, settings.reviewTimeoutSec) * 1000)

  try {
    handle = await hostCtx.agents.create({
      sessionId: `hermes-evolve-review-${randomUUID()}`,
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
    logger?.info?.(`[hermes-evolve] review finished in ${Date.now() - startedAt}ms (skills=${reviewSkills} memory=${reviewMemory})`)
    return {
      ok: true,
      summary: summary.slice(0, 2000),
      scope: { reviewMemory, reviewSkills },
      durationMs: Date.now() - startedAt,
      usage: usageStats,
      model: selected,
    }
  } catch (error) {
    const reason = error && error.message ? error.message : String(error)
    logger?.warn?.(`[hermes-evolve] review failed: ${reason}`)
    return { ok: false, error: reason, durationMs: Date.now() - startedAt }
  } finally {
    clearTimeout(timer)
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
  const allow = inherited.filter((name) => ['read', 'glob', 'grep', 'read_file', 'search_files'].includes(name))
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

/**
 * Per-session counters. hermes keeps these on the AIAgent instance; a host-plane
 * plugin sees every session's events, so the map is keyed by session id.
 */
function createScheduler ({ hostCtx, settings, logger }) {
  const sessions = new Map()
  const inFlight = new Set()

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
        const memoryInterval = settings.memoryMode !== 'off' && settings.memoryEnabled !== false && settings.memoryNudgeInterval > 0
          ? settings.memoryNudgeInterval
          : 0
        const fireSkills = settings.skillsMode !== 'off' && skillInterval > 0 && state.itersSinceSkill >= skillInterval
        const fireMemory = memoryInterval > 0 && state.turnsSinceMemory >= memoryInterval
        if (fireSkills) state.itersSinceSkill = 0
        if (fireMemory) state.turnsSinceMemory = 0
        const hadResponse = state.lastAssistantText.trim() !== ''
        const transcript = snapshotMessages(session)
        state.lastAssistantText = ''
        state.lastTurnInterrupted = false
        state.lastUserMessage = ''
        if (interrupted || !hadResponse || (!fireSkills && !fireMemory)) return
        if (settings.mode === 'log-only') {
          logger?.info?.(`[hermes-evolve] log-only: would review skills=${fireSkills} memory=${fireMemory}`)
          return
        }
        const key = session.id
        if (inFlight.has(key)) {
          logger?.debug?.('[hermes-evolve] review already in flight for this session; skipping')
          return
        }
        inFlight.add(key)
        try {
          const result = await runReview(hostCtx, {
            cwd: session.header && session.header.cwd ? session.header.cwd : process.cwd(),
            messages: transcript,
            reviewMemory: fireMemory,
            reviewSkills: fireSkills,
            settings,
            logger,
          })
          if (result.ok && settings.mode === 'approval') {
            await store.stagePending({ kind: 'review', sessionId: session.id, scope: result.scope, summary: result.summary })
          }
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

/** One-line notice back into the source session, so the user can see what the
 *  loop did without opening a panel. */
function appendReviewNotice (session, result, logger) {
  try {
    const scopes = []
    if (result.scope.reviewSkills) scopes.push('skills')
    if (result.scope.reviewMemory) scopes.push('memory')
    const summary = `背景复盘完成（${scopes.join(' + ')}，${Math.round(result.durationMs / 1000)}s）`
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
  contentToText,
  lastAssistantText,
  sumReviewUsage,
}