# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- **Tests** — 40 tests covering the memory store, usage transitions, tool
  handlers, curator passes, prompt fidelity, the review scheduler, and plugin
  boot.

### Notes

- The eight review/curator prompt texts and the four tool schemas are extracted
  verbatim from `NousResearch/hermes-agent@d923a5eb48` (v0.22.2) by
  `scripts/extract_prompts.py`; nothing is paraphrased.
- `delete` never removes a skill from disk: it moves the package to
  `$DSH_HOME/skills/.archive/<name>` (mtime refreshed) and records a ledger
  entry, matching Hermes' "never delete, only archive" invariant.