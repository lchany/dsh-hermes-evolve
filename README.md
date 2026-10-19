# dsh-hermes-evolve

Hermes Agent's **self-evolution loop**, ported to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) as a market-style, pluggable host plugin.

> The agent gets better between sessions: it keeps a memory of who you are, saves what it learns as skills, reviews its own finished turns in the background, and curates the resulting library without ever deleting anything.

- **Fidelity first.** The review/curator prompts and the four tool schemas are extracted **verbatim** from `NousResearch/hermes-agent@d923a5eb48` (v0.22.2). No paraphrase, no invented protocols. `scripts/extract_prompts.py` reproduces the artifacts.
- **Pluggable.** One dependency + one `dsh.profile.bundles` entry. Remove them and it is gone — no core patches, no forked DSH.
- **Safe by construction.** Review and curator `delete` = **archive**. Read-before-write is enforced. Pinned and user-authored skills are never auto-transitioned. Approval mode stages writes for a human.

---

## What it does

| Capability | Behaviour | Ported from |
| --- | --- | --- |
| **Memory + user profile** | `$DSH_HOME/memories/MEMORY.md` (environment facts) and `USER.md` (who the user is), `§`-delimited entries, 2,200 / 1,375 char budgets, injected into every new session as a frozen snapshot | `tools/memory_tool.py`, `tools/memory_tool_store.py` |
| **`memory` tool** | batch `operations` (add / replace / remove), exact Hermes error strings, injection-side threat screening | `tools/memory_tool.py` |
| **Skill library** | `$DSH_HOME/skills/<name>/SKILL.md` plus `references/`, `templates/`, `scripts/`, `assets/` support files; `skills_list` / `skill_view` / `skill_manage` with the original JSON Schemas | `tools/skills_tool.py`, `tools/skill_manager_tool.py` |
| **Skill linter** | advisory checks: oversized body, incident-log shape, references sprawl, dangling references (only new violations are reported) | `tools/skill_linter.py` |
| **Background review fork** | after a sufficiently long turn, an in-process subagent replays the transcript with the Hermes review prompt and saves lessons through the tools | `agent/background_review.py`, `agent/turn_finalizer.py` |
| **Coach prompts** | Hermes' `## Skills` and memory guidance sections, so the model records lessons instead of narrating them | `agent/prompt_builder.py` |
| **Curator** | deterministic inactivity transitions (`active` → `stale` → `archived`), seeded first run, lock file, backups, ledger; opt-in LLM umbrella-consolidation pass with reconciliation | `agent/curator.py`, `agent/curator_backup.py` |
| **Web panel** | `/hermes-evolve` page + `/hermes-evolve/api` JSON: status, memory, skills, pending approvals, backups/restore, curator controls, live settings | — (DSH `webServer` route) |

The four model-facing tools are registered **globally**, so the main session and every review fork share the same stores. When a review saves a skill, the next session finds it in the skill catalog; when memory is updated, the next session's prompt reflects it.

---

## Requirements

- Node.js **>= 22.5**
- DSH **0.2.0-rc.2** or newer (tested against `0.2.0-rc.2`)
- No build step, no native dependencies. The only runtime dependency is `@deepseek-ai/schemastery` (for the settings schema).

## Install

### From GitHub (recommended)

Add the plugin to your DSH profile and to the profile bundle list, then restart the web server:

```bash
cd ~/.dsh/profiles/web
npm install github:YOUR_GITHUB_USER/dsh-hermes-evolve
```

Edit `~/.dsh/profiles/web/package.json`:

```json
{
  "dependencies": {
    "dsh-hermes-evolve": "github:YOUR_GITHUB_USER/dsh-hermes-evolve"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-hermes-evolve"
      ]
    }
  }
}
```

Restart DSH (`dsh web`, or however your GUI is launched). The plugin row is contributed by `cordis.patch.yml`.

### From a local checkout (development)

```bash
cd ~/.dsh/profiles/web
npm install file:/absolute/path/to/dsh-hermes-evolve
```

Then add `"dsh-hermes-evolve"` to `dsh.profile.bundles` exactly as above and restart. Re-running `npm install file:...` after `git pull` is not required in npm `file:` mode — the symlink follows the checkout — but a DSH restart is.

### Verify

- Open `http://127.0.0.1:3080/hermes-evolve` (use your DSH port). You should see the panel with zero counts.
- Open the DSH settings page: a **hermes-evolve** section with every option below is projected automatically.
- After one substantial session, the panel's skills/memory counters move and a `[hermes-evolve] 背景复盘完成…` notice appears in the conversation.

## Where state lives

| Path | Contents |
| --- | --- |
| `$DSH_HOME/memories/MEMORY.md`, `USER.md` | persistent memory (editable by hand) |
| `$DSH_HOME/skills/<name>/SKILL.md` | skills, discovered by DSH's own skill provider |
| `$DSH_HOME/skills/.usage.json` | per-skill lifetime counters, state, pinned flag |
| `$DSH_HOME/skills/.curator_state` | curator schedule, last summary, pause flag |
| `$DSH_HOME/skills/.archive/<name>` | archived skill packages (recoverable) |
| `$DSH_HOME/skills/.curator_backups/` | backup snapshots, blobs, reports |
| `$DSH_HOME/skills/.curator_ledger.jsonl` | append-only action ledger |
| `$DSH_HOME/hermes-evolve/pending/` | writes staged in approval mode |

`$DSH_HOME` defaults to `~/.dsh`.

## Settings

Every option is a `.volatile()` schemastery field and can be changed live from the DSH settings page or from the panel.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch for the background loop |
| `mode` | `auto` | `auto` \| `approval` \| `log-only` |
| `turnInterval` | `10` | tool iterations before a skill review |
| `toolCallInterval` | `10` | alias kept for parity with earlier builds |
| `cooldownMinutes` | `30` | minimum gap between reviews per session |
| `reviewTimeoutSec` | `300` | fork timeout |
| `provider` / `model` | `''` | aux model for the fork; empty = host default |
| `memoryCharLimit` / `userCharLimit` | `2200` / `1375` | Hermes budgets |
| `coachingEnabled` / `coachingMode` | `true` / `full` | system-prompt coaching (`full` \| `patch-only` \| `off`) |
| `memoryInjectionEnabled` | `true` | inject the memory snapshot |
| `supportFilesEnabled` | `true` | allow `references/`, `templates/`, … |
| `linterEnabled` / `ledgerEnabled` | `true` | advisory linting and the ledger |
| `curatorEnabled` | `true` | deterministic curator |
| `curatorIntervalHours` | `168` | review cadence (first run only seeds) |
| `curatorMinIdleHours` | `2` | only run while the GUI is idle |
| `curatorStaleDays` / `curatorArchiveDays` | `14` / `30` | inactivity thresholds |
| `curatorConsolidate` | `false` | opt-in LLM umbrella pass |
| `curatorBackupKeep` | `2` | snapshots to retain |
| `signalTriggerEnabled` | `true` | accelerate a review after repeated tool failures or correction phrases |

The full list, including `SUSPECTS_TOP_N`, transcript caps and correction words, is in [`src/const.js`](src/const.js).

## Invariants (the parts that are deliberately conservative)

1. **Never delete.** `skill_manage(action='delete')` archives the whole package to `$DSH_HOME/skills/.archive/<name>`, refreshes its mtime, and appends a ledger entry. The curator can only archive. There is no purge path.
2. **Only managed skills transition.** A skill the user asked for in conversation (`created_by: 'learn'`) is never auto-archived; only agent-authored skills (`created_by: 'agent'`) are curator-managed. `pinned` blocks transitions entirely.
3. **Read-before-write.** A patch or overwrite must be preceded by a `skill_view` of that exact file in the same review turn. Refusals behave like Hermes: view once, retry once, do not loop.
4. **No prompt-cache mutation.** Memory is rendered as a per-session frozen snapshot and skills are never reloaded into an existing prompt; everything that enters a running session does so as a message or tool result.
5. **Corrupt state fails safe.** Unparseable usage records, timestamps, or curator state mean "do nothing", never "archive everything".
6. **Approval mode stages.** In `approval` mode the fork cannot write: it returns the intended change and the plugin stores it under `pending/` for a human decision.

## Development

```bash
npm install
npm test          # 40 tests, no network, no host required
npm run check     # syntax + artifact + export-surface checks
```

Repository layout:

```
src/index.js          plugin entry (apply, Config, service wiring)
src/review.js         background review fork + turn scheduler
src/curator.js        deterministic transitions, LLM pass, backups, reports
src/skill_tools.js    skills_list / skill_view / skill_manage / memory handlers
src/skill_store.js    skill package scan, validation, ledger, archive, backups
src/skill_usage.js    .usage.json sidecar + transition state machine
src/skill_linter.js   advisory linter
src/memory.js         §-format store, budgets, injection snapshot
src/prompts.js        Hermes prompt assembly + language directive
src/prompts.hermes.json  extracted verbatim prompt texts (do not edit)
src/schemas.hermes.json  extracted verbatim tool schemas (do not edit)
src/panel.js          /hermes-evolve page + JSON API
scripts/extract_prompts.py   regenerates the prompt artifacts from a hermes checkout
scripts/extract_schemas.py   regenerates the tool schemas (JSON + CJS mirror)
scripts/check.js             offline syntax / artifact / export-surface checks
```

To re-extract the Hermes artifacts against another release:

```bash
HERMES_SRC=/path/to/hermes-agent npm run extract:hermes
python3 scripts/extract_schemas.py /path/to/hermes-agent
```

Both extractors are mechanical (AST / source-segment execution); re-running them
against the pinned commit reproduces the committed artifacts byte-for-byte, and
`npm run check` fails if they drift apart.

## Provenance

All prompt text and tool schemas come from `NousResearch/hermes-agent` at commit
`d923a5eb48` (release 0.22.2), extracted mechanically by `scripts/extract_prompts.py`
(AST-based, zero unresolved f-strings). The extractor keeps the source commit in
`src/prompts.hermes.json`, and `npm run check` fails if the provenance marker or
any of the eight prompt texts disappears.

## License

MIT — see [LICENSE](LICENSE). Hermes Agent is MIT-licensed as well; the extracted
prompt texts remain the work of Nous Research.