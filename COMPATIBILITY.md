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
- 无人值守记忆删除拒绝：`Background review may not delete memory entries ('replace'/'remove', including in a batch); 'add' is still available.`

### 2.4 阈值与默认值

| 项 | 值 | 出处 |
| --- | --- | --- |
| memory / user 字符上限 | 2200 / 1375 | `memory_tool_store.py` |
| skill / memory nudge 间隔 | 10 / 10 | `agent_init.py:1380/1301` |
| review 迭代上限 | 16 | `background_review.py:173` |
| review 输入 token 上限 | 600k（上下文 75%，兜底 120k） | `background_review.py:180-182` |
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
| D4 | 白名单在 **advertised 工具面**上收窄（`tools.restrict`），而不是 dispatch 侧拒绝 | DSH 的 `restrict` 只能过滤继承来的全局层；副作用是模型看不到 hermes 那句 deny 串。收窄本身满足 hermes 的目的（省迭代、保 cache parity） |
| D5 | 记忆 `replace`/`remove` 在无人值守时落到 `pending/*.json`，面板批准才真正写入 | hermes 有 `/memory pending` CLI；DSH 没有命令面，用面板等价物代替，语义（不静默删除）一致 |
| D6 | `skills.write_approval`（approval 模式）只拒绝写入并要求模型文字描述，不 stage 完整补丁 | 工具层没有「带 diff 的可重放补丁」载体；这是**能力退化**，已写进 README 的不变量说明 |
| D7 | curator 调度用宿主级定时器 + `turn/end` 活动时间 + `curatorMinIdleHours` | hermes 挂在 session-start idle hook 上并感知 gateway/web_server；DSH 插件没有同等 hook，语义（首次播种、按间隔、空闲才跑）保持一致 |
| D8 | 没有 bundled / hub / external / cron 引用等技能来源 | DSH 的技能只有 `$DSH_HOME/skills` 里的文件；`created_by` 只可能是 `agent`（无人值守写入）或 `learn`（用户前台写入），跳过规则保留但不会触发 |
| D9 | 备份没有 `manifest.json` 校验和与 ledger-entry rollback | 简化实现：`tar -tzf` 校验绝对路径/`..` 后再解包；账本仍然记账（`skill_store.js` 的 `ledgerAppend`） |
| D10 | curator CLI（`status`/`run`/`pin`/`rollback`/`purge`/…）未移植 | 面板 `/hermes-evolve` 与 `/hermes-evolve/api` 提供等价操作（run/pause/resume/restore/settings） |
| D11 | 复盘结果以一行 plugin notice 写回源会话 | hermes 打印到 CLI；DSH 里用户只能从会话里看到结果 |
| D12 | 不注入语言指令 | hermes 没有语言指令；早期版本照抄了 `@weibaohui/hermes-loop` 的做法，已删除 |

## 4. 明确未移植

- 技能来源模型：`bundled` / `hub` / `external`、`curator.prune_builtins`、`skills.disabled`
- cron 任务引用技能（事实 pin）与 `cron_rewrites`
- `hermes curator` 全部子命令、`/skills pending`、`/memory pending` 命令面
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

# 3) 行为测试（49 个）
npm test
```