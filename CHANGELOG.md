# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Hermes' Desktop control points, ported as DSH commands; memory moved to the
current upstream action model; review cost is bounded.

### Added

- `memory` now speaks Hermes' current action model: `add` / `patch` / `remove`,
  where `patch` replaces exactly one `old_text` span and keeps the rest of the
  entry. `replace` is refused with Hermes' own sentence and survives only to
  replay writes staged by older versions. Schemas were re-extracted from a live
  `v0.22.2` checkout (`extract_schemas.py`), which is also what the differential
  audit re-checks.
- Review forks are bounded like upstream: `reviewMaxIterations` (16) denies tool
  calls once a fork's budget is spent, so it answers with what it has; a second
  automatic review of the same session inside 30 minutes is skipped and its
  trigger is kept for the next completed turn.
- `curator run --dry-run` is now read-only: it counts candidates, records
  `dry-run auto: no changes` and still writes `REPORT.md`, but never seeds,
  transitions or archives.

### Fixed

- The `## Skills` coaching section restores Hermes' verbatim `[SKILL_PRUNED]`
  safety tail and names the basic tools the way upstream does (`bash`, or
  `web_search or bash` when a web-search tool is registered) instead of a
  hand-written list.
- `scripts/check.js` now runs the differential audit against a live Hermes
  checkout when one and a `ruamel.yaml`-capable interpreter are available.

### Added

- `/skills`, `/memory`, `/curator`, `/refine`, `/learn` as registered host
  commands (`src/commands.js`). Text is Hermes' own: `pending` / `approve` /
  `reject` / `diff` / `approval` for the write queues, the eight Desktop curator
  subcommands, `⚗ Reviewing this conversation in the background (focus: …)`,
  and the learn prompt as an ordinary user turn.
- `/skills diff <id>` renders the staged operations as unified diffs, folded so
  each op diffs against the ones before it.
- `/refine [focus]` runs the review fork immediately, with the same staging and
  notice path as the background scheduler.

### Changed

- Write approval is two independent booleans —
  `skills.write_approval` / `memory.write_approval` — matching Hermes, replacing
  the single `mode: auto|approval|log-only` switch. The panel and the settings
  page both edit the same pair.
- A memory `replace`/`remove` staged for approval pins the exact entry it
  matched; approving after that entry changed or disappeared fails and leaves
  the proposal pending instead of writing blind.

### Fixed

- The review fork still read the removed `mode` field for its approval gate;
  it now reads both subsystem booleans (which also un-gates memory separately
  from skills).

## [0.1.2] — 2026-10-21

Verifiability release: "is this really Hermes?" is now something you run, not
something you take on trust.

### Added

- `scripts/audit_hermes.py` (`npm run audit:hermes`): differential audit against
  a live hermes checkout. Re-extracts prompts/schemas into a temp dir and diffs
  them against the shipped artifacts, then runs the same SKILL.md fixtures
  through Hermes' `tools.skill_linter` and this port and compares rule sets.
  Skips loudly (exit 2) when the interpreter cannot import Hermes' modules.
- `AUDIT.md`: the three-tier local verification guide (byte-level, behavioural,
  end-to-end checklist) plus an honest list of what cannot be checked locally.

### Changed

- `npm run extract:hermes` now refreshes both prompt and schema artifacts.
- Both extractors honour `HERMES_EVOLVE_OUT*` overrides, so audits never write
  into the working tree.

### Fixed

- **D4 — dispatch-side review whitelist.** The plugin now registers a
  `tools/pre-execute` waterfall and denies any tool outside the review
  whitelist for `hermes-evolve-review-*` sessions, returning Hermes' exact
  `Background review denied non-whitelisted tool: …` sentence (both memory
  variants). `tools.restrict` still narrows the advertised surface.
- **D6 — approval mode is a real staging flow.** `skill_manage` under
  `skills.write_approval` stages the complete, replayable patch in the pending
  store (`kind:'skill'`, Hermes' `skill_gist` summary) instead of refusing;
  approving in the panel replays it through `applyOperation`/`rollbackTouched`
  with the original `agentCreated` provenance. Memory writes stage the same way
  (`kind:'memory'`).
- **D9 — restore verifies before extracting.** `createBackup` writes a
  per-file `manifest.json` (path, size, sha256) plus the archive's own digest;
  `restoreBackup` refuses on a size/checksum mismatch or on an archive member
  the manifest does not list. Legacy manifests keep the escape-only path.
- **D10 — panel parity for the curator CLI.** `POST /skills/pin` and
  `POST /skills/purge` mirror `hermes curator pin/unpin/purge` (including the
  `curator.archive_ttl_days` disabled message and dry-run), with pin/unpin and
  purge controls on the panel page.
- **D7 — curator session-start check.** `agent/created` with `source`
  `startup`/`resume` on an idle agent now triggers the curator tick, matching
  Hermes' startup hook (`idle_for_seconds=inf` on startup, a measured idle on
  resume) in addition to the host timer.

## [0.1.1] — 2026-10-20

Fidelity pass: every mechanism that had been re-invented was re-derived from
Hermes' source (`NousResearch/hermes-agent@d923a5eb48`, v0.22.2) and restored to
the original semantics. `COMPATIBILITY.md` now documents the module-by-module
map and every remaining deviation.

### Changed

- Review and curator passes send their prompt as the fork's **user message**,
  exactly like Hermes; the system prompt is never rewritten (D2 in
  `COMPATIBILITY.md`). The invented "suspects + catalog" preload is gone — the
  fork reads the library itself through `skills_list` / `skill_view`.
- Memory destructive writes (`replace` / `remove`, batch included) from an
  unattended pass are **staged** for approval instead of being applied
  (Hermes #105921), and the panel's pending view now applies an approved memory
  change.
- `turnInterval` split into `skillNudgeInterval` (tool iterations) and
  `memoryNudgeInterval` (user turns), both 10 — the two counters Hermes keeps
  separately. Removed `toolCallInterval`, `suspectsTopN`, `catalogDescriptionMax`
  and `cooldownMinutes` (never enforced).
- The skill linter is now the full 15-rule port (`skill_linter.py`), including
  `shell-utility-reference`, `missing-section`, `platforms-gating` and
  `forbidden-file`.
- Frontmatter parsing/serialising handles the nested `metadata.hermes.*` maps
  and inline flow lists that real skills use.

### Added

- `COMPATIBILITY.md` — verbatim inventory (8 prompts, 4 schemas, fixed strings,
  thresholds) and deviations D1–D12 with their reasons.

## [0.1.0] — 2026-10-19

First public release: the four capabilities of Hermes Agent's self-evolution
loop, ported to DeepSeek Harness as a market-style pluggable plugin.

### Added

- **Memory + user profile** — `$DSH_HOME/memories/MEMORY.md` and `USER.md` with
  Hermes' `§`-delimited entry format, char budgets (2,200 / 1,375), batch
  operations, exact error strings, threat screening on the injected copy, and a
  per-session frozen snapshot in the system prompt.
- **`memory` tool** — Hermes `MEMORY_SCHEMA` verbatim (`target`, `action`,
  `content`, `old_text`, `new_text`, batch `operations`), including the
  "retry as ONE batch" over-limit message and the per-turn consolidation
  failure cap.
- **Skill library tools** — `skills_list`, `skill_view`, `skill_manage` with the
  Hermes schemas verbatim: create / patch (string or full-content) /
  write_file / remove_file / delete, support files under
  `references/`, `templates/`, `scripts/`, `assets/`, read-before-write
  enforcement, and `delete` implemented as *archive*.
- **Skill linter** (advisory) — `oversized-body`, `incident-log-shape`,
  `references-sprawl`, `dangling-reference`; only rules newly introduced by a
  patch are reported.
- **Background review fork** — post-turn in-process subagent that replays the
  transcript with Hermes' `_SKILL_REVIEW_PROMPT` / `_MEMORY_REVIEW_PROMPT` /
  `_COMBINED_REVIEW_PROMPT` and writes lessons directly through the tools.
  Triggered by tool-iteration / turn intervals, optional signal acceleration
  (tool failures, user corrections), cooldown and single-flight per session.
  Modes: `auto`, `approval` (staged pending writes), `log-only`.
- **Coach prompts** — Hermes' `## Skills` and memory guidance sections injected
  into the system prompt, with `full` / `patch-only` / `off` modes.
- **Curator** — deterministic inactivity state machine (`active` → `stale` →
  `archived`, archive-most only, never delete), the four Hermes transition
  rules, managed/pinned/unmanaged guards, lock file, seeded first run, backup
  snapshots with retention, ledger, and an opt-in LLM consolidation pass whose
  results are reconciled against the tool calls it actually made.
- **Web panel** — `GET /hermes-evolve`: status, memory, skill table, pending
  approvals, backups/restore, live settings, and curator run/pause controls;
  JSON API under `/hermes-evolve/api`.
- **Settings page** — every option is a `.volatile()` schemastery field, so the
  host projects it into the GUI without a custom client bundle.
- **Coexistence** — `registerTools` (`auto`/`off`) claims only free global tool
  names; `respectForeignMemory` backs off when another plugin owns `memory`;
  the coaching section is gated on a reachable `skill_manage`.
- **Fix** — the host materialises `.volatile()` config fields as `{}` in the
  apply-config (measured on dsh 0.2.0-rc.2); those placeholders are now filtered
  by shape so they can no longer overwrite defaults (`mode` showed up as
  `[object Object]` in the boot log).
- **Tests** — 45 tests covering the memory store, usage transitions, tool
  handlers, curator passes, prompt fidelity, the review scheduler, and plugin
  boot.

### Notes

- The eight review/curator prompt texts and the four tool schemas are extracted
  verbatim from `NousResearch/hermes-agent@d923a5eb48` (v0.22.2) by
  `scripts/extract_prompts.py`; nothing is paraphrased.
- `delete` never removes a skill from disk: it moves the package to
  `$DSH_HOME/skills/.archive/<name>` (mtime refreshed) and records a ledger
  entry, matching Hermes' "never delete, only archive" invariant.