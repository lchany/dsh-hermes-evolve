# dsh-hermes-evolve

Hermes Agent's **self-evolution loop**, ported to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) as a market-style, pluggable host plugin.

> The agent gets better between sessions: it keeps a memory of who you are, saves what it learns as skills, reviews its own finished turns in the background, and curates the resulting library without ever deleting anything.

- **Fidelity first.** The review/curator prompts and the four tool schemas are extracted **verbatim** from `NousResearch/hermes-agent@d923a5eb48` (v0.22.2). No paraphrase, no invented protocols. `scripts/extract_prompts.py` reproduces the artifacts. [COMPATIBILITY.md](COMPATIBILITY.md) maps every Hermes module to its file here and lists every deviation the DSH runtime forces.
- **Pluggable.** One dependency + one `dsh.profile.bundles` entry. Remove them and it is gone — no core patches, no forked DSH.
- **Safe by construction.** Review and curator `delete` = **archive**. Read-before-write is enforced. Pinned and user-authored skills are never auto-transitioned. `skills.write_approval` / `memory.write_approval` stage writes for a human, exactly like Hermes' own booleans.

---

## What it does

| Capability | Behaviour | Ported from |
| --- | --- | --- |
| **Memory + user profile** | `$DSH_HOME/memories/MEMORY.md` (environment facts) and `USER.md` (who the user is), `§`-delimited entries, 2,200 / 1,375 char budgets, injected into every new session as a frozen snapshot | `tools/memory_tool.py`, `tools/memory_tool_store.py` |
| **`memory` tool** | batch `operations` (add / patch / remove; `replace` survives only as a legacy replay), exact Hermes error strings, injection-side threat screening | `tools/memory_tool.py` |
| **Skill library** | `$DSH_HOME/skills/<name>/SKILL.md` plus `references/`, `templates/`, `scripts/`, `assets/` support files; `skills_list` / `skill_view` / `skill_manage` with the original JSON Schemas | `tools/skills_tool.py`, `tools/skill_manager_tool.py` |
| **Skill linter** | all 15 advisory rules from Hermes (name format, marketing words, missing metadata, oversized body, shell-utility prose, incident-log shape, dangling links, POSIX gating, forbidden files, references sprawl …); only new violations are reported | `tools/skill_linter.py` |
| **Background review fork** | after a sufficiently long turn, an in-process subagent replays the transcript and receives the Hermes review prompt **as its user message** (system prompt untouched, like upstream); it saves lessons through the tools | `agent/background_review.py`, `agent/turn_finalizer.py` |
| **Coach prompts** | Hermes' `## Skills` and memory guidance sections, so the model records lessons instead of narrating them | `agent/prompt_builder.py` |
| **Curator** | deterministic inactivity transitions (`active` → `stale` → `archived`), seeded first run, lock file, backups, ledger; opt-in LLM umbrella-consolidation pass with reconciliation | `agent/curator.py`, `agent/curator_backup.py` |
| **Web panel** | `/hermes-evolve` page + `/hermes-evolve/api` JSON: status, memory, skills, pending approvals, backups/restore, curator controls, live settings | — (DSH `webServer` route) |

The four model-facing tools are registered **globally**, so the main session and every review fork share the same stores. When a review saves a skill, the next session finds it in the skill catalog; when memory is updated, the next session's prompt reflects it.

---

## Chat commands

The same five control points Hermes exposes in the Desktop chat are registered
commands here. They run without a model turn and answer in the chat:

| Command | Subcommands / arguments | Behaviour |
| --- | --- | --- |
| `/skills` | `pending` · `approve <id\|all>` · `reject <id\|all>` · `diff <id>` · `approval <on\|off>` | inspect the staged skill queue, replay or drop a proposal, render its unified diff, flip the gate |
| `/memory` | `pending` · `approve <id\|all>` · `reject <id\|all>` · `approval <on\|off>` | same for memory writes; a patch/remove shows the exact entry it pinned at staging time |
| `/curator` | `status` · `run [--dry-run] [--consolidate]` · `pause` · `resume` · `pin <skill>` · `unpin <skill>` · `restore <skill>` · `list-archived` | inspect the schedule, run a pass now, pin survivors, restore an archived skill |
| `/refine [focus]` | optional free-text focus | fork a background review **now** instead of waiting for the nudge; the same staging rules apply |
| `/learn <request>` | free text, or nothing for "this conversation" | queue Hermes' skill-authoring prompt as the next ordinary user turn |

`/skills approval on` and `/memory approval on` write the corresponding boolean
through the DSH settings document, so the panel and the settings page stay in
sync. Hermes' hub-only subcommands (`/skills bundles`, `/skills journey`, …) and
its terminal-only curator commands (`ledger`, `rollback`, `purge`, …) are not
ported: they have no Desktop surface upstream either.

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
npm install github:lchany/dsh-hermes-evolve
```

Edit `~/.dsh/profiles/web/package.json`:

```json
{
  "dependencies": {
    "dsh-hermes-evolve": "github:lchany/dsh-hermes-evolve"
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

### Verify parity with Hermes

Two of the three verification tiers are machine-checkable and need no model:

```bash
npm run check   # artifacts intact: prompts, schemas, manifest, changelog
npm test        # 52 behavioural tests

# differential audit against a hermes checkout (python>=3.11 + ruamel.yaml + pyyaml)
python3 -m venv /tmp/hermes-audit && /tmp/hermes-audit/bin/pip install ruamel.yaml pyyaml
/tmp/hermes-audit/bin/python scripts/audit_hermes.py --hermes ../hermes-agent
```

The audit re-extracts the prompt and schema constants from the checkout and
diffs them against what this repo ships, then feeds the same SKILL.md fixtures
to Hermes' `tools.skill_linter` and to this port and compares the rule sets.
Current run: 8 prompt texts / 4 schemas byte-identical, 13/15 linter rules
matching. The third tier — end-to-end, needs the host and a model — is a
checklist in [`AUDIT.md`](AUDIT.md).

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
| `$DSH_HOME/hermes-evolve/pending/` | writes staged by the approval gates |

`$DSH_HOME` defaults to `~/.dsh`.

## Settings

Every option is a `.volatile()` schemastery field and can be changed live from the DSH settings page or from the panel.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch for the background loop |
| `skillsWriteApproval` | `false` | stage every skill write for approval (hermes `skills.write_approval`) |
| `memoryWriteApproval` | `false` | stage every memory write for approval (hermes `memory.write_approval`) |
| `skillNudgeInterval` | `10` | tool iterations before a skill review (hermes `agent.skills.creation_nudge_interval`) |
| `reviewMaxIterations` | `16` | tool-dispatch budget for one review fork (hermes `_REVIEW_MAX_ITERATIONS`); past it calls are denied and the fork must answer |

Background reviews are also throttled to one per session per 30 minutes
(hermes' 1800s guard): a trigger that hits the window is kept and retried on the
next completed turn instead of being dropped.
| `memoryNudgeInterval` | `10` | user turns before a memory review (hermes `memory.nudge_interval`) |
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

## Living next to other plugins

A profile can already provide skill tools (`skills_list` / `skill_view` /
`skill_manage`) or a `memory` tool from another plugin. Two plugins cannot own
the same global tool name, so `registerTools: 'auto'` claims only the names that
are still free, logs the ones it left alone, and — while `respectForeignMemory`
is on — skips its own memory tool and snapshot when a foreign `memory` tool is
present. The coaching section is only injected while a `skill_manage` tool is
actually reachable.

The **background review and curator forks are unaffected**: they register their
tools in the spawned agent's own scope (where scoped tools shadow globals), so
the ported Hermes semantics always apply inside those passes.

## Invariants (the parts that are deliberately conservative)

1. **Never delete.** `skill_manage(action='delete')` archives the whole package to `$DSH_HOME/skills/.archive/<name>`, refreshes its mtime, and appends a ledger entry. The curator can only archive. There is no purge path.
2. **Only managed skills transition.** A skill the user asked for in conversation (`created_by: 'learn'`) is never auto-archived; only agent-authored skills (`created_by: 'agent'`) are curator-managed. `pinned` blocks transitions entirely.
3. **Read-before-write.** A patch or overwrite must be preceded by a `skill_view` of that exact file in the same review turn. Refusals behave like Hermes: view once, retry once, do not loop.
4. **No prompt-cache mutation.** Memory is rendered as a per-session frozen snapshot and skills are never reloaded into an existing prompt; everything that enters a running session does so as a message or tool result.
5. **Corrupt state fails safe.** Unparseable usage records, timestamps, or curator state mean "do nothing", never "archive everything".
6. **Unattended writes are gated.** Memory `patch`/`remove` from a background pass are always staged under `pending/` for a human (Hermes #105921 — `add` still lands). With `skillsWriteApproval` or `memoryWriteApproval` on, every corresponding write is staged as a complete, replayable proposal under `pending/`; approving it (panel, `/skills approve`, `/memory approve`) replays it through the same write machinery (D6). A pinned memory entry that changed after staging is refused rather than written blind.

## Development

```bash
npm install
npm test          # 52 tests, no network, no host required
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
src/prompts.js        Hermes prompt texts + hermes-shaped message builders
src/prompts.hermes.json  extracted verbatim prompt texts (do not edit)
src/schemas.hermes.json  extracted verbatim tool schemas (do not edit)
src/panel.js          /hermes-evolve page + JSON API
scripts/extract_prompts.py   regenerates the prompt artifacts from a hermes checkout
scripts/extract_schemas.py   regenerates the tool schemas (JSON + CJS mirror)
scripts/check.js             offline syntax / artifact / export-surface checks
COMPATIBILITY.md             module-by-module fidelity map and runtime deviations
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