'use strict'

/**
 * Tunables and the settings schema.
 *
 * Every default here is traceable to Hermes' own configuration so the port can
 * be diffed against upstream without guessing:
 *   - memory 2,200 / user 1,375 chars  → website/docs/user-guide/features/memory.md
 *   - skill nudge interval 10          → agent/agent_init.py:1380-1382
 *   - curator stale/archive 14/30 days → agent/curator.py:31-35
 *   - curator interval 24*7h, min idle 2h
 *   - curator.consolidate = False      → the deterministic prune always runs,
 *                                        the LLM merge pass is opt-in
 */

const DEFAULT_CORRECTION_WORDS =
  '不对,错了,重来,别这样,应该是,你弄错了,记住,记忆,wrong,try again,not what i,stop doing'

const DEFAULTS = {
  enabled: true,
  // auto = write directly, approval = stage to pending, log-only = never write
  mode: 'auto',
  memoryMode: 'inherit', // inherit | auto | approval | log-only
  skillsMode: 'inherit',
  provider: '', // '' → the deployment's default model selection
  model: '',

  // ── trigger ──────────────────────────────────────────────────────────────
  turnInterval: 10,
  toolCallInterval: 10,
  cooldownMinutes: 30,
  maxTranscriptChars: 12000,
  maxTranscriptMessages: 40,
  reviewTimeoutSec: 300,
  suspectsTopN: 3,
  catalogDescriptionMax: 500,

  // Signals let a cheap, high-recall trigger fire early; precision is the
  // review agent's negative list's job, not the trigger's.
  signalTriggerEnabled: true,
  signalToolFailureMin: 3,
  signalCorrectionWords: DEFAULT_CORRECTION_WORDS,

  // ── memory ───────────────────────────────────────────────────────────────
  memoryInjectionEnabled: true,
  memoryEnabled: true, // MEMORY.md: environment / project facts, conventions
  userProfileEnabled: true, // USER.md: who the user is
  memoryCharLimit: 2200,
  userCharLimit: 1375,
  workspaceMemoryEnabled: true,

  // ── in-turn coaching (Hermes' `## Skills` section) ───────────────────────
  coachingEnabled: true,
  // 'full' = Hermes' three sentences (load / patch / offer to save)
  // 'patch-only' = only "fix a loaded skill in place" (avoids two competing
  //                authoring disciplines when another loop plugin is installed)
  coachingMode: 'full',

  // ── skill authoring ──────────────────────────────────────────────────────
  registerTools: 'auto', // auto | off — claim only tool names nobody else owns
  respectForeignMemory: true, // another memory plugin owns `memory` -> stay out of its way
  supportFilesEnabled: true, // references/ templates/ scripts/ assets/
  maxSupportFileChars: 65536,
  maxBodyChars: 131072,
  linterEnabled: true,
  ledgerEnabled: true,

  // ── curator ──────────────────────────────────────────────────────────────
  curatorEnabled: true,
  curatorConsolidate: false, // opt-in LLM umbrella-building pass
  curatorIntervalHours: 24 * 7,
  curatorMinIdleHours: 2,
  curatorStaleDays: 14,
  curatorArchiveDays: 30,
  curatorBackupKeep: 2,
  curatorBackupEnabled: true,
}

const LIMITS = {
  MEMORY_ENTRY_MAX_CHARS: 500,
  BODY_MAX_CHARS: 128 * 1024,
  SUPPORT_FILE_MAX_CHARS: 64 * 1024,
  SUSPECT_BODY_MAX_CHARS: 8 * 1024,
  TRANSCRIPT_MESSAGE_CHARS: 4000,
  // Advisory linter thresholds, ported from tools/skill_linter.py
  LINT_BODY_SOFT_BUDGET: 24_000,
  LINT_MAX_REFERENCE_FILES: 60,
  LINT_INCIDENT_REF_MIN: 4,
  LINT_INCIDENT_REF_PER_KCHAR: 0.5,
  // Curator
  DAY_MS: 24 * 60 * 60 * 1000,
  CURATOR_LOCK_STALE_SECONDS: 3600,
  PENDING_MAX: 200,
}

/**
 * Settings schema.
 *
 * `.volatile()` is mandatory: only volatile fields are projected into the
 * settings UI and accepted by `ctx.settings.update()`.
 */
function settingsSchema (S) {
  if (!S || typeof S.object !== 'function') return null
  return S.object({
    enabled: S.boolean().default(true).volatile(),
    mode: S.union(['auto', 'approval', 'log-only']).default('auto').volatile(),
    memoryMode: S.union(['inherit', 'auto', 'approval', 'log-only']).default('inherit').volatile(),
    skillsMode: S.union(['inherit', 'auto', 'approval', 'log-only']).default('inherit').volatile(),
    provider: S.string().default('').volatile(),
    model: S.string().default('').volatile(),

    turnInterval: S.number().min(1).default(10).volatile(),
    toolCallInterval: S.number().min(0).default(10).volatile(),
    cooldownMinutes: S.number().min(0).default(30).volatile(),
    maxTranscriptChars: S.number().min(1000).default(12000).volatile(),
    maxTranscriptMessages: S.number().min(5).max(400).default(40).volatile(),
    reviewTimeoutSec: S.number().min(30).default(300).volatile(),
    suspectsTopN: S.number().min(0).max(10).default(3).volatile(),
    catalogDescriptionMax: S.number().min(50).default(500).volatile(),

    signalTriggerEnabled: S.boolean().default(true).volatile(),
    signalToolFailureMin: S.number().min(0).default(3).volatile(),
    signalCorrectionWords: S.string().default(DEFAULT_CORRECTION_WORDS).volatile(),

    memoryInjectionEnabled: S.boolean().default(true).volatile(),
    memoryEnabled: S.boolean().default(true).volatile(),
    userProfileEnabled: S.boolean().default(true).volatile(),
    memoryCharLimit: S.number().min(200).default(2200).volatile(),
    userCharLimit: S.number().min(200).default(1375).volatile(),
    workspaceMemoryEnabled: S.boolean().default(true).volatile(),

    coachingEnabled: S.boolean().default(true).volatile(),
    coachingMode: S.union(['full', 'patch-only', 'off']).default('full').volatile(),

    registerTools: S.union(['auto', 'off']).default('auto').volatile(),
    respectForeignMemory: S.boolean().default(true).volatile(),
    supportFilesEnabled: S.boolean().default(true).volatile(),
    maxSupportFileChars: S.number().min(1024).default(65536).volatile(),
    maxBodyChars: S.number().min(4096).default(131072).volatile(),
    linterEnabled: S.boolean().default(true).volatile(),
    ledgerEnabled: S.boolean().default(true).volatile(),

    curatorEnabled: S.boolean().default(true).volatile(),
    curatorConsolidate: S.boolean().default(false).volatile(),
    curatorIntervalHours: S.number().min(1).default(24 * 7).volatile(),
    curatorMinIdleHours: S.number().min(0).default(2).volatile(),
    curatorStaleDays: S.number().min(1).default(14).volatile(),
    curatorArchiveDays: S.number().min(1).default(30).volatile(),
    curatorBackupKeep: S.number().min(1).default(2).volatile(),
    curatorBackupEnabled: S.boolean().default(true).volatile(),
  })
}

module.exports = {
  DEFAULTS,
  LIMITS,
  DEFAULT_CORRECTION_WORDS,
  settingsSchema,
}