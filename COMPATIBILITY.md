# 与 hermes-agent 的保真对照

本插件是 `NousResearch/hermes-agent` 自进化子系统的移植，不是重新设计。
判定标准只有一条：**凡是 hermes 已经写死的语义、文本、阈值，一律照抄；只有 DSH 运行时无法表达的
东西才允许改，并且每一处改动都记录在下面的「运行时偏差」表里。**

- 上游基准：`NousResearch/hermes-agent@d923a5eb48`（v0.22.2）
- 提取脚本：`scripts/extract_prompts.py`（8 段 prompt）、`scripts/extract_schemas.py`（4 个工具 schema）
- 提取产物：`src/prompts.hermes.json`、`src/schemas.hermes.json`；`src/*.js` 从产物读取，不手抄
- 复核：`npm run check` 会校验产物完整性、schema 与 `src/tool_schemas.js` 逐字节一致

## 1. 逐模块对照

| hermes 模块 | 本插件 | 状态 |
| --- | --- | --- |
| `agent/background_review.py` | `src/review.js` | 等价：触发条件、fork 形态、工具白名单、prompt 投递位置一致 |
| `agent/turn_finalizer.py`（触发判定） | `src/review.js` `createScheduler` | 等价：按 tool iteration / user turn 双阈值，完成后才跑 |
| `agent/prompt_builder.py`（`## Skills` / memory 段） | `src/prompts.js` | **逐字**，仅目录句改为「scan the available skill catalog」 |
| `tools/memory_tool.py` + `memory_tool_store.py` | `src/memory.js`、`src/skill_tools.js` | 逐字：分隔符、限额、错误串、成功串、add-only 门控 |
| `tools/skill_manager_tool.py`（含 guards） | `src/skill_tools.js`、`src/skill_store.js` | 等价：读后写守卫串、delete→archive、`absorbed_into` |
| `tools/skills_tool.py` | `src/skill_tools.js`、`src/skill_store.js` | 逐字：`skills_list` / `skill_view` 输出契约 |
| `tools/skill_usage.py` | `src/skill_usage.js` | 等价：字段、`latest_activity_at` 定义、四条转移规则 |
| `tools/skill_linter.py` | `src/skill_linter.js` | **逐字移植 15 条规则**（规则名、阈值、提示语） |
| `tools/skill_ledger.py` / `skill_provenance.py` | `src/skill_store.js`（`ledgerAppend`/`captureBefore`） | 等价：sha256 账本 + blob |
| `agent/curator.py` | `src/curator.js` | 等价：确定性状态机、候选清单格式、prompt 投递位置 |
| `agent/curator_backup.py` | `src/skill_store.js`（`createBackup`/`restoreBackup`） | 部分：tar.gz + 排除集一致，缺 manifest 校验和 |
| `hermes_cli/curator.py` | `src/panel.js`（HTTP API） | 改为面板等价物，CLI 未移植 |
| `hermes_cli/config_defaults.py` | `src/const.js` `DEFAULTS` | 阈值逐字 |

## 2. 逐字移植的清单

### 2.1 Prompt（8 段，`src/prompts.hermes.json`）

| 常量 | 字符数 |
| --- | --- |
| `_MEMORY_ROUTING_BLOCK` | 734 |
| `_MEMORY_REVIEW_PROMPT` | 994 |
| `_LESSON_LAYER_BLOCK` | 2098 |
| `_DO_NOT_CAPTURE_BLOCK` | 1690 |
| `_SKILL_REVIEW_PROMPT` | 8984 |
| `_COMBINED_REVIEW_PROMPT` | 8204 |
| `CURATOR_DRY_RUN_BANNER` | 904 |
| `CURATOR_REVIEW_PROMPT` | 10315 |

选择规则同样逐字（`_PROMPT_NAME_BY_SCOPE`）：memory+skills → combined；仅 memory → memory；其余 → skill。

### 2.2 工具 schema（4 个，`src/schemas.hermes.json`）

`memory`(3416B)、`skills_list`(273B)、`skill_view`(876B)、`skill_manage`(3497B)。
最后一个是构造式（源码里是函数调用），由 `scripts/extract_schemas.py` 按行号 `exec` 源码得到，
包含 6 个 `anyOf` 分支（create / patch-pair / patch-content / write_file / remove_file / delete）。

### 2.3 固定文本

- 复盘工具后缀：`You can only call {memory and skill |skill }management tools. Other tools will be denied at runtime — do not attempt them.`
- curator user message：`${CURATOR_REVIEW_PROMPT}\n\n${candidate_list}`；dry-run 前置 `${CURATOR_DRY_RUN_BANNER}\n\n`
- 候选清单（`_render_candidate_list`）：
  `Agent-created skills (N):` + 每行
  `- {name}  provenance=…  state=…  pinned=yes|no  cron=yes|no  activity=…  use=…  view=…  patches=…  last_activity=…`
  （两个空格分隔、字段顺序固定）；空清单 → `No agent-created skills to review.`
- 记忆存储：`ENTRY_DELIMITER="\n§\n"`、分隔符 `"═"×46`、标题
  `MEMORY (your personal notes)` / `USER PROFILE (who the user is)`
- 记忆错误/成功串：`Memory at {used}/{limit} chars; this batch would exceed the limit by {deficit} chars. …`、
  `Multiple entries matched '{old_text}'. Be more specific.`、`old_text cannot be empty.`、
  `new_content cannot be empty. Use 'remove' to delete entries.`、`Write saved. This update is complete — do not repeat it.`
- 读后写守卫：`… has not been loaded in this review turn. Call skill_view(name) for SKILL.md, or skill_view(name, file_path=...) for a supporting file, then retry the write using the content just returned.`
- 无人值守记忆删除拒绝：`Background review may not delete memory entries ('replace'/'remove', including in a batch); 'add' is still available.`（`patch` 现在也是删除类动作，串按 Hermes `memory_tool.py` 原样保留 `replace`）
- 记忆动作：`add` / `patch` / `remove`（`patch` = 只替换 `old_text` 这一段、其余原文保留；`replace` 已被 Hermes 关闭，本 port 只回放旧暂存记录）。新增串：`'replace' is not available; use 'patch'. old_text is the exact span to change and content is its new text; the rest of the entry is kept. To rewrite a whole entry, set old_text to the whole entry. Nothing was written.`、
  `To drop text inside an entry, patch a longer span that contains it; 'remove' deletes the whole entry.`、
  `'{old_text}' appears {n} times in the matched entry, and patch edits one span. Include more surrounding text so old_text occurs once.`、`old_text is required for 'patch' action.`、`old_text is not in the matched entry; use the exact text from the entry.`、`Replacement text is identical to old_text; nothing changed.`、`Entry updated.`

### 2.4 阈值与默认值

| 项 | 值 | 出处 |
| --- | --- | --- |
| memory / user 字符上限 | 2200 / 1375 | `memory_tool_store.py` |
| skill / memory nudge 间隔 | 10 / 10 | `agent_init.py:1380/1301` |
| review 迭代上限 | 16（DSH 无 max-steps：由 `tools/pre-execute` 在预算耗尽后拒绝工具调用，让 fork 用已有信息作答） | `background_review.py:173` |
| review 输入 token 上限 | 未移植（DSH 无请求级 token 计量）；transcript 字符上限 12k 默认、clamp 到 480k 字符（≈120k token），Hermes 是 600k token / 上下文 75% / 兜底 120k | `background_review.py:180-182` |
| review 最小间隔 | 30 分钟（trigger 保留，顺延到下一个完成回合） | `background_review.py:78-98` |
| curator 间隔 / 最小空闲 | 7 天 / 2 小时 | `curator.py:31-35` |
| stale / archive | 14 天 / 30 天 | 同上 |
| 备份保留 | 2 | `curator_backup.py` |
| SKILL.md 软预算 / 硬上限 | 24k / 128k | `skill_linter.py` / `skill_manager_tool.py` |
| references 数量上限 | 60 | `skill_linter.py` |
| incident-log 判定 | ≥4 个引用且 ≥0.5/kchar | `skill_linter.py` |
| description 提示预算 | 60 字符（显示 57 + `...`） | `skill_utils.py:822` |

## 3. 运行时偏差（DSH 无法原样表达的部分）

| # | 偏差 | 为什么 |
| --- | --- | --- |
| D1 | Python → Node.js；同步文件 IO 改为 async | 宿主是 Node 插件，没有 Python 运行时 |
| D2 | 不重放 `conversation_history`：把 transcript 内联进**同一条 user message**，prompt 放在其后 | DSH 的 session 事件携带 provider stream record，重放等于伪造事件；hermes 的「prompt 作为 user message、系统提示不动」这一点保持一致 |
| D3 | 工具名映射：`read_file`→`read`，`search_files`→`glob`/`grep` | DSH 的等价工具叫这两个名字 |
| D4 | 白名单**既**在 advertised 面上收窄（`tools.restrict`）**又**在 dispatch 侧拒绝：插件注册 `tools/pre-execute` waterfall，对 `hermes-evolve-review-*` 会话按白名单拦截，返回 Hermes 的 deny 串（`Background review denied non-whitelisted tool: …`，两种 memory 变体） | DSH 的 `restrict` 只过滤继承来的全局层；dispatch 拒绝与 Hermes 的 `set_thread_tool_whitelist` 等价，且能拦住模型凭旧 transcript 发起的调用。**残留**：串里的读工具名按 D3 映射为 `read/glob/grep`（Hermes 原文 `read_file/search_files`） |
| D5 | 记忆 `patch`/`remove`（以及旧暂存里的 `replace`）在无人值守或 `memory.write_approval` 打开时落到 `pending/*.json`，暂存时钉住命中的整条条目；`/memory approve`、`/memory` 面板或 `applyPendingMemory` 才真正写入，条目已变则拒写 | 命令面（`/memory pending|approve|reject|approval`）与面板共用同一个写入闸与同一套文案；破坏性操作在暂存时 pin、批准时复核 |
| D6 | `skills.write_approval` 打开时不再拒绝：`skill_manage` 把完整可重放补丁（action/name、`old_string`/`new_string` 或全文、category、description 摘要）写入 pending（`kind:'skill'`），返回 `Staged for approval (skills.write_approval is on). Not yet saved — …`，不落盘；面板 `POST /pending` 批准后用与直接写入同一套 `applyOperation`/`rollbackTouched` 回放（保留 `agentCreated` 来源与 linter/ledger 设置），回放失败时记录留在 pending 并回显 `failed_op`。记忆写入同样改为 pending（`kind:'memory'`）而非拒绝 | pending 存储是 DSH 里最接近 `/skills pending` 的可重放载体；语义与 Hermes 的 `stage_write`/`apply_skill_pending` 一致。`/skills pending|approve|reject|diff|approval` 与面板走同一条回放路径 |
| D7 | curator 调度：宿主级定时器 + `turn/end` 活动时间 + `curatorMinIdleHours`，**另加** `agent/created`（`source` 为 `startup`/`resume` 且 agent 为 idle、且不是本插件的 fork）的 session-start 检查；`startup` 视作无限空闲，对应 hermes CLI startup 线程的 `maybe_run_curator(idle_for_seconds=float('inf'))`，`resume` 沿用实测空闲 | 语义（首次播种、按间隔、空闲才跑）与 hermes 一致。**残留**：没有 gateway/web_server 的会话空闲计量，`resume` 只能用进程内空闲近似 |
| D8 | 没有 bundled / hub / external / cron 引用等技能来源 | DSH 的技能只有 `$DSH_HOME/skills` 里的文件；`created_by` 只可能是 `agent`（无人值守写入）或 `learn`（用户前台写入），跳过规则保留但不会触发 |
| D9 | 备份带 `manifest.json` 完整性清单（每个文件相对路径/字节数/sha256，外加 archive 自身的 sha256/字节数）；`restoreBackup` 先校验 archive 摘要与大小，在临时目录逐文件校验大小与 sha256、拒绝清单外的成员，全部通过才解包；旧清单（无 `entries`）回退到 `tar -tzf` 的绝对路径/`..` 校验 | **残留**：hermes 的 ledger-entry rollback API 未移植（账本仍记 `rollback` 事件）；逐文件清单是 port 增强，upstream 的 manifest 只记 `archive_bytes` |
| D10 | `/curator status|run|pause|resume|pin|unpin|restore|list-archived` 已按 `hermes_cli/curator.py` 的文案移植（`run` 支持 `--dry-run`/`--consolidate`）；仍无 CLI 的 `ledger`/`rollback`/`adopt`/`prune`/`backup`/`archive`/`list-unmanaged`/`purge`。面板 `/hermes-evolve/api` 覆盖 status/run/pause/resume/restore/settings 以及 **pin/unpin/purge**：pin 复用 CLI 的 not-agent/not-eligible/unmanaged 文案，purge 支持 `curator.archive_ttl_days` 的 0 禁用语义、dry-run 与逐项 `captureBefore` + ledger；页面有点位按钮 | **残留**：`adopt`、`rollback <backup>`、`report` 的文本输出仍无对应 UI |
| D11 | 复盘结果以一行 plugin notice 写回源会话；有落地动作时按 hermes `_action_lines` 逐项列出（`💾 自我改进回顾：技能 'x' 已修补 · 记忆已更新`，英文 locale 用 `💾 Self-improvement review:`），动作行只取自 fork 里**成功**的工具结果，暂存/失败/未应用的不计；无动作时保留一行完成提示 | hermes 把回顾打印到 CLI/TUI 回调；DSH 没有跨面板的状态行通道，只能写成会话内 notice（`source.kind='hermes-evolve'`, `form:'notice'`） |
| D12 | 不注入语言指令 | hermes 没有语言指令；早期版本照抄了 `@weibaohui/hermes-loop` 的做法，已删除 |

## 4. 明确未移植

- 技能来源模型：`bundled` / `hub` / `external`、`curator.prune_builtins`、`skills.disabled`
- cron 任务引用技能（事实 pin）与 `cron_rewrites`
- `hermes curator` 的部分子命令（`adopt`/`rollback`/`report`）与 `/skills pending`、`/memory pending` 命令面
- `/skills` 斜杠命令注入（DSH 用 `skill` 工具加载）
- ACP / 网关 / 多平台会话（hermes 的 `platform=` 分支）
- `oneshot` 模式下的教练语隐藏与 `skill_manage` 隐藏（DSH 没有等价的单次查询模式开关）

## 5. 如何复核

```bash
# 1) 重新从 hermes 源码提取，确认产物未漂移
HERMES_SRC=/path/to/hermes-agent npm run extract:hermes   # prompts
python3 scripts/extract_schemas.py /path/to/hermes-agent   # schemas

# 2) 物品完整性 + schema 逐字节一致 + 导出面
npm run check

# 3) 行为测试（68 个）
npm test
```