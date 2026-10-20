# 怎么在本地判断「和 hermes 一致」

这份文档回答一个问题：**不用相信 README，你自己怎么验。**

答案分三层，从便宜到昂贵。前两层不需要模型、不需要 API key，几秒钟出结果；第三层要真宿主、真模型。

```
L1 逐字对账   —— 字节级：prompt / schema / 常量是否还是 hermes 原文
L2 行为差分   —— 同一批输入喂给 hermes 的 Python 和本插件的 JS，比输出
L3 端到端     —— 在 DSH 里真跑一遍，看落盘产物
```

---

## L1 逐字对账（不需要模型）

```bash
cd ~/workspace/data/hermes-evolve
npm run check
```

`scripts/check.js` 校验的是**结构不变量**：8 段 prompt 文本齐备、4 个 schema 与 `src/tool_schemas.js` 逐字节一致、来源提交号、`files` 里的条目都存在、CHANGELOG 含当前版本。它防的是「文件被删/被改坏」。

但结构对不代表内容和 hermes 一致 —— 那一步由下面的差分脚本负责。

## L2 行为差分（不需要模型，需要 hermes 源码）

```bash
# 一次性准备（hermes 的纯函数要 python>=3.11 + ruamel.yaml + pyyaml）
python3 -m venv /tmp/hermes-audit
/tmp/hermes-audit/bin/pip install ruamel.yaml pyyaml

# 跑审计（改成你的 hermes checkout 路径）
/tmp/hermes-audit/bin/python scripts/audit_hermes.py \
    --hermes ~/workspace/data/llm/hermes-agent
```

它会做三件事，每件都打印 PASS/FAIL 和证据：

| 检查 | 做法 | 当前结果 |
|---|---|---|
| `verbatim` | 用 `scripts/extract_prompts.py` / `extract_schemas.py` 从 hermes 源码**重新抽取**到临时目录，与本仓库提交的产物做 JSON 深度比较 | 8 段 prompt、4 个 schema、`tool_schemas.js` 全部 **byte-identical** |
| `linter` | 13 个 fixture（每条规则一个）分别喂给 `tools.skill_linter.lint_content()` 和 `src/skill_linter.js`，比较命中的**规则集合** | 13 个 fixture 触发 hermes 的 **13/15 条规则**，两侧完全一致 |
| `memory-format` | 读 hermes `tools.memory_tool_store` 的 `ENTRY_DELIMITER` / `MEMORY_BLOCK_HEADERS`，与 `src/memory.js` 比较 | `'\n§\n'`、`['memory','user']` 一致 |

`verbatim` 是真正防漂移的那一层：只要有人手改了 `src/prompts.hermes.json`，或者你 checkout 的 hermes 换了版本，它立刻变红。

解释器不对时脚本会 **SKIP 并返回退出码 2**，不会假装通过 —— 系统 python 3.10 缺 `datetime.UTC`，跑不了 hermes 的模块。

## L3 端到端（需要宿主 + 模型）

起 GUI（或第二实例）后在面板里逐项勾。表里的路径都以 `$DSH_HOME`（默认 `~/.dsh`）为根。

| 能力 | 怎么触发 | 看什么 | 通过标准 |
|---|---|---|---|
| 记忆注入 | 正常对话 | 会话系统提示里的 `MEMORY (your personal notes)` / `USER PROFILE (who the user is)` 块 | 有块、有 `═` 分隔线、有 `used/limit chars` 百分比 |
| 记忆写入 | 对 agent 说「记住：……」 | `~/.dsh/memories/MEMORY.md` 或 `USER.md` | 出现 `§` 分隔的条目；面板 Memory 页可见 |
| 记忆容量上限 | 连续写入直到超过 2200/1375 | 工具返回 | 报错串含 `would exceed the limit by N chars`，并回显 `current_entries` |
| 读后写守卫 | 让 agent 直接 patch 一个没读过的技能 | `skill_manage` 返回 | 报 `the current … content has not been loaded in this review turn` |
| 技能落盘 | 让 agent 建一个技能 | `~/.dsh/skills/<name>/SKILL.md` | 文件存在；面板 Skills 页出现；新会话能被 `skill` 工具加载 |
| 后台复盘触发 | 面板把 `skillNudgeInterval` 改成 1，跑一个带工具迭代的回合 | 会话里追加的一行通知 | 出现 `[hermes-evolve]` 折叠通知（`mode=log-only` 时只进日志） |
| 复盘产物 | 同上，让 agent 干一件有踩坑的事 | `~/.dsh/skills/*/SKILL.md`、`.usage.json` | 技能被 patch/新建；usage 里 `use_count`/`patch_count` 有变化 |
| 无人值守记忆删除 | 复盘里让模型 replace/remove 记忆 | 面板 Pending 页 | 出现 `kind:memory` 的待审条目；批准后文件才变 |
| curator 状态机 | 面板 Curator → Run（dry-run 关掉 consolidate） | `~/.dsh/skills/.curator_state` | `last_run_at` 更新、`run_count+1`；stale/archive 计数符合 14/30 天规则 |
| curator 合并 | `curatorConsolidate=true` + 至少两个同主题受管技能 | `.archive/`、`.curator_backups/reports/*.md` | 被合并的技能进 `.archive/`，报告里有 `consolidations:` / `prunings:` |
| 备份/回滚 | 面板 Backups → Restore | `.curator_backups/` | 恢复后技能目录回到快照状态 |
| 设置热更新 | 面板改任意设置 | 无需重启 | 下一次回合生效（`settings/document-updated`） |
| 工具共存 | 同时装 hermes-loop / 其它 memory 插件 | 启动日志 | `registerTools:auto` 让位，不抛「duplicate tool」 |

反向检查（确认它**不会**做什么，这些是 hermes 的不变量）：

```bash
grep -rn "rm -rf\|unlinkSync\|rmSync" src/            # 应只出现在 util 的受控删除里
ls ~/.dsh/skills/.archive/                            # 删除 = 归档，这里应该有东西
grep -n "delete" src/skill_tools.js                   # action=delete 走 archive，不 fs.rm
```

## 做不到「本地判定」的部分（诚实清单）

- **复盘质量**：模型写出来的技能好不好，只能人看。脚本只能证明「prompt 是原文、工具面一致、落盘格式一致」。
- **prompt cache parity**：hermes 的 `build_cache_parity_fork` 复用的是同一份 provider 缓存；DSH 的会话/压缩模型不同，我们只对齐了「prompt 走 user message、不改写系统提示」这一条可对齐的约束（见 `COMPATIBILITY.md` D2/D3）。
- **provenance 分支**：hermes 的 `bundled` / `hub` / `external` / cron-referenced 判定在 DSH 没有对应概念，`isProtected/isBundled/isCronReferenced` 恒为 false（D8）。
- **CLI**：`hermes curator status/run/rollback/...` 未移植，等价物是面板（D11）。
- **approval 模式的完整语义**：hermes 的 `skills.write_approval` 能把**任意**写入做成 staged diff；本 port 现在把技能与记忆写入都 stage 成可重放提案（`kind:'skill'`/`'memory'`），面板批准后回放（D6）。残留：没有 `/skills pending` 命令面，只有面板。

这些偏差全部在 [`COMPATIBILITY.md`](COMPATIBILITY.md) 的 D1–D12 里逐条列出 —— 判断「符合」之前先读那一节，**已知偏差不算 bug，未列出的偏差才算**。

## 一句话结论

```bash
npm run check && npm test && \
  /tmp/hermes-audit/bin/python scripts/audit_hermes.py --hermes <hermes 路径>
```

三绿 = 逐字与行为层面可证一致；剩下的靠上表人工勾。任何一处变红，先怀疑本插件，再怀疑 hermes 版本。