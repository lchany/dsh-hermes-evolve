# dsh-hermes-evolve

把 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 的**自进化闭环**移植到 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH），做成市场式可插拔插件。

> 让 agent 在会话之间变强：记住你是谁、把学到的东西沉淀成技能、回合结束后在后台复盘自己的表现、并且只归档不删除地维护技能库。

- **保真优先。** 复盘/策展提示词与四个工具 schema 都从 `NousResearch/hermes-agent@d923a5eb48`（v0.22.2）**逐字**抽取，不改写、不发明协议。`scripts/extract_prompts.py` 可复现。
- **可插拔。** profile 里加一条依赖 + 一条 `dsh.profile.bundles`；删掉即彻底移除，不改 DSH 核心。
- **默认保守。** 复盘与策展里的 `delete` 一律变成**归档**；写前必读（read-before-write）强制；pinned 与用户自建技能永不被自动转移；approval 模式下写入先挂起等人确认。

---

## 能力一览

| 能力 | 行为 | 移植自 |
| --- | --- | --- |
| **记忆 + 用户画像** | `$DSH_HOME/memories/MEMORY.md`（环境事实）与 `USER.md`（用户是谁），`§` 分隔条目，2,200 / 1,375 字符预算，以每会话冻结快照注入系统提示 | `tools/memory_tool.py`、`tools/memory_tool_store.py` |
| **`memory` 工具** | 批量 `operations`（add / replace / remove）、Hermes 原文错误串、注入侧投毒条目屏蔽 | `tools/memory_tool.py` |
| **技能库** | `$DSH_HOME/skills/<name>/SKILL.md` + `references/`、`templates/`、`scripts/`、`assets/` 支撑文件；`skills_list` / `skill_view` / `skill_manage` 使用原版 JSON Schema | `tools/skills_tool.py`、`tools/skill_manager_tool.py` |
| **技能 linter** | 只告警不拦截：正文过大、事故日志形态、references 泛滥、悬空引用（只报本次新引入的） | `tools/skill_linter.py` |
| **后台复盘 fork** | 足够长的回合结束后，进程内子 agent 用 Hermes 原版复盘提示重读转写，并通过工具直接沉淀经验 | `agent/background_review.py`、`agent/turn_finalizer.py` |
| **教练提示词** | Hermes 的 `## Skills` 与记忆引导段落，让模型"记规则"而不是"记日志" | `agent/prompt_builder.py` |
| **策展器（curator）** | 确定性不活跃状态机（`active` → `stale` → `archived`）、首次运行只播种、文件锁、备份、账本；可选的 LLM 合并 pass 带工具调用对账 | `agent/curator.py`、`agent/curator_backup.py` |
| **Web 面板** | `/hermes-evolve` 页面 + `/hermes-evolve/api` JSON：状态、记忆、技能表、待审批、备份/恢复、策展控制、在线改设置 | —（DSH `webServer` 路由） |

四个模型可见工具注册在**全局**，主会话与复盘 fork 写同一份存储：复盘存下的技能，下一个会话就能在技能目录里看到；记忆更新后，下一个会话的系统提示立刻反映。

---

## 环境要求

- Node.js **>= 22.5**
- DSH **0.2.0-rc.2** 或更新（已在 `0.2.0-rc.2` 上验证）
- 无构建步骤、无原生依赖；唯一运行时依赖是 `@deepseek-ai/schemastery`（设置 schema 用）

## 安装

### 从 GitHub 安装（推荐）

```bash
cd ~/.dsh/profiles/web
npm install github:YOUR_GITHUB_USER/dsh-hermes-evolve
```

然后编辑 `~/.dsh/profiles/web/package.json`：

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

重启 DSH（`dsh web` 或你启动 GUI 的方式）。插件行由 `cordis.patch.yml` 注入宿主 composition。

### 从本地目录安装（开发）

```bash
cd ~/.dsh/profiles/web
npm install file:/absolute/path/to/dsh-hermes-evolve
```

同样把 `"dsh-hermes-evolve"` 加进 `dsh.profile.bundles`，重启。`file:` 模式是符号链接，改代码后只需重启 DSH。

### 验证

- 打开 `http://127.0.0.1:3080/hermes-evolve`（端口换成你的 DSH 端口），应看到计数为零的面板；
- 打开 DSH 设置页，应出现 **hermes-evolve** 分组，全部选项自动投影；
- 跑一个较长的会话后，面板计数变化，且对话里会出现一行 `[hermes-evolve] 背景复盘完成…` 通知。

## 状态文件位置

| 路径 | 内容 |
| --- | --- |
| `$DSH_HOME/memories/MEMORY.md`、`USER.md` | 持久记忆（可手改） |
| `$DSH_HOME/skills/<name>/SKILL.md` | 技能，由 DSH 自带 skill provider 发现 |
| `$DSH_HOME/skills/.usage.json` | 每个技能的累计计数、状态、pinned |
| `$DSH_HOME/skills/.curator_state` | 策展调度、上次摘要、暂停标记 |
| `$DSH_HOME/skills/.archive/<name>` | 已归档技能包（可恢复） |
| `$DSH_HOME/skills/.curator_backups/` | 备份快照、blob、报告 |
| `$DSH_HOME/skills/.curator_ledger.jsonl` | 追加式操作账本 |
| `$DSH_HOME/hermes-evolve/pending/` | approval 模式挂起的写入 |

`$DSH_HOME` 默认是 `~/.dsh`。

## 设置项

全部是 `.volatile()` 的 schemastery 字段，可在 DSH 设置页或面板里在线修改。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 后台闭环总开关 |
| `mode` | `auto` | `auto` / `approval` / `log-only` |
| `turnInterval` | `10` | 多少轮工具迭代触发一次技能复盘 |
| `cooldownMinutes` | `30` | 同会话两次复盘的最小间隔 |
| `reviewTimeoutSec` | `300` | fork 超时 |
| `provider` / `model` | `''` | 复盘用辅助模型；空 = 宿主默认 |
| `memoryCharLimit` / `userCharLimit` | `2200` / `1375` | Hermes 预算 |
| `coachingEnabled` / `coachingMode` | `true` / `full` | 系统提示教练语（`full` / `patch-only` / `off`） |
| `memoryInjectionEnabled` | `true` | 是否注入记忆快照 |
| `supportFilesEnabled` | `true` | 是否允许支撑文件 |
| `linterEnabled` / `ledgerEnabled` | `true` | 告警式 lint 与账本 |
| `curatorEnabled` | `true` | 确定性策展 |
| `curatorIntervalHours` | `168` | 策展周期（首次只播种） |
| `curatorMinIdleHours` | `2` | 只在 GUI 空闲时运行 |
| `curatorStaleDays` / `curatorArchiveDays` | `14` / `30` | 不活跃阈值 |
| `curatorConsolidate` | `false` | 可选的 LLM 合并 pass |
| `curatorBackupKeep` | `2` | 保留快照数 |
| `signalTriggerEnabled` | `true` | 连续工具失败/用户纠正词时提前复盘 |

完整清单（含转写截断、嫌疑技能数、纠正词表）见 [`src/const.js`](src/const.js)。

## 与其他插件共存

profile 可能已经提供技能工具（`skills_list` / `skill_view` / `skill_manage`）
或别的插件提供的 `memory` 工具。两个插件不能共享同一个全局工具名，所以
`registerTools: 'auto'` 只接管仍然空闲的名字，并把让出的工具名写进日志；在
`respectForeignMemory` 开启时，检测到外部 `memory` 工具就不接管记忆（不注入
快照、不注册工具）。只有当确实有 `skill_manage` 可用时才注入技能教练段。

**后台复盘与 curator 不受影响**：它们在派生 agent 自己的作用域里注册工具
（作用域工具会遮蔽全局工具），所以那两条通道里始终是移植后的 Hermes 语义。

## 不变量（刻意保守的部分）

1. **永不删除。** `skill_manage(action='delete')` 把整个技能包移到 `$DSH_HOME/skills/.archive/<name>`，刷新 mtime，并写账本。策展器最多也只能归档，没有 purge 路径。
2. **只动受管技能。** 用户在对话里让它建的技能记为 `created_by: 'learn'`，永不自动归档；只有 agent 自主创建的（`created_by: 'agent'`）才进 curator 托管。`pinned` 完全阻止转移。
3. **写前必读。** patch/覆盖支撑文件前，必须在同一次复盘回合内 `skill_view` 过那个文件；拒绝后按 Hermes 的行为：view 一次、重试一次、不要循环。
4. **不动 prompt cache。** 记忆以每会话冻结快照注入，技能不会在会话中途重载；进入运行中会话的内容一律走 message 或 tool result。
5. **坏状态即不动。** usage 记录、时间戳、curator state 解析失败时一律"什么都不做"，绝不"全库归档"。
6. **approval 模式挂起。** 复盘不能直接落盘，只返回意图变更，插件存到 `pending/` 等人审。

## 开发

```bash
npm install
npm test          # 45 个测试，无网络、不依赖宿主
npm run check     # 语法 + 抽取产物 + 导出面检查
```

目录结构：

```
src/index.js          插件入口（apply / Config / 服务接线）
src/review.js         后台复盘 fork + 回合调度
src/curator.js        确定性转移、LLM pass、备份、报告
src/skill_tools.js    skills_list / skill_view / skill_manage / memory handler
src/skill_store.js    技能包扫描、校验、账本、归档、备份
src/skill_usage.js    .usage.json 侧车 + 状态机
src/skill_linter.js   告警式 linter
src/memory.js         § 格式存储、预算、注入快照
src/prompts.js        Hermes 提示词组装 + 语言钉住
src/prompts.hermes.json  逐字抽取的提示词（勿手改）
src/schemas.hermes.json  逐字抽取的工具 schema（勿手改）
src/panel.js          /hermes-evolve 页面 + JSON API
scripts/extract_prompts.py  从 hermes 仓库重新生成提示词产物
scripts/extract_schemas.py  从 hermes 仓库重新生成工具 schema（JSON + CJS 镜像）
scripts/check.js            离线语法 / 产物 / 导出面检查
```

对另一个 hermes 版本重新抽取：

```bash
HERMES_SRC=/path/to/hermes-agent npm run extract:hermes
python3 scripts/extract_schemas.py /path/to/hermes-agent
```

两个抽取脚本都是机械抽取（AST / 源码片段执行），对同一提交重跑能字节级复现仓库里的产物；`npm run check` 会在产物漂移时报错。

## 来源

全部提示词与工具 schema 来自 `NousResearch/hermes-agent` 提交 `d923a5eb48`（0.22.2 版），由 `scripts/extract_prompts.py` 机械抽取（AST 解析，零未解析 f-string）。抽取器把源提交写进 `src/prompts.hermes.json`；`npm run check` 会在来源标记或八段提示词任一段丢失时报错。

## 许可证

MIT — 见 [LICENSE](LICENSE)。Hermes Agent 同样是 MIT；抽取的提示词文本版权归 Nous Research。