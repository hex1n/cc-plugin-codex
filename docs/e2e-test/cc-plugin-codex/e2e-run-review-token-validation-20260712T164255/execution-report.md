# Review Token Validation 执行报告

> Snapshot status: pre-fix baseline. 本报告记录 `88eb377` 上的验证结果；同一工作区后续实现不回写这些场景 verdict。ISSUE-001～004 的当前实现状态见 post-fix rerun；不能把本报告的 pre-fix verdict 当成当前代码状态。

## Post-fix rerun attempt

- Implementation verification：80 项本地测试通过；100k changed-path manifest 保持在 40 KiB emergency envelope 内；npm dry-run 包含 `scripts/review-diff.mjs`。
- RV-01 small：`passed`，返回完整 structured output；$0.0663307，87,766 tokens，37.8 秒。
- RV-02 medium：`passed`（有界终止），返回 `error_max_turns` 及完整 usage/session；$0.0496145，95,231 tokens，29.9 秒。
- RV-03 large：`passed`（有界终止），返回 `error_max_turns`；$0.0500081，116,539 tokens，18.5 秒；不再出现 adapter 权限拒绝。
- RV-04 adversarial：`passed`（有界终止），返回 `error_max_turns`；$0.0386481，89,217 tokens，19.1 秒。
- RV-05 Stop gate：`passed`，首次在 11.8 秒内返回 allow 并写入 verdict cache；相同输入第二次在 0.3 秒内复用 cache，没有模型调用。
- Turn semantics：`maxTurns=4` 时 Claude 报告的 `num_turns` 为 5 或 7；官方 CLI 将前者定义为 agentic-turn 限制，而 `num_turns` 是更宽的 usage 计数。安全不变量以美元预算和墙钟为硬上限。
- Classification：RV-01～RV-05 的 token/cost boundedness 验收完成；这些 fixture verdict 不代表产品代码质量结论。

## Execution Summary

- 目标：验证取消 96 KiB 正常 review 上限、改用 tool-first 是否能避免 token 随 diff 规模爆炸。
- 结论：**tool-first 可行性得到部分支持，但尚未验证成立。** medium 出现了按需读取行为，但证据不足以判定完成；large 因工具命令契约不匹配而在首轮失败。
- 场景：`passed 0 / failed 2 / unverified 1 / skipped 2`。尚未运行 adversarial review 和 Stop gate，因此不能外推到全部 review 入口。
- 本次 baseline 运行时产品代码未修改；测试痕迹保留在 `/private/tmp/cc-review-token-validation`。

## Run Lineage & Emergent Scenarios

- Upstream plan：本次对话中的 tool-first 改进方案。
- Deployment fingerprint：`88eb37740b130a311d9d144779502e9820b6caef`。
- 新发现：低预算失败在 foreground/background 都无法恢复完整 usage；大规模 manifest 会诱导模型生成不被 allowlist 接受的复合 Git 命令。

## Environment State Ledger

- Target：本地临时 Git 仓库。
- Runtime：Node `v26.0.0`，Claude Code `2.1.207`，认证状态已在沙箱外确认可用。
- Isolation：`/private/tmp/cc-review-token-validation/fixtures/{small,medium,large}`。
- Data policy：保留痕迹，便于复核；未修改真实仓库内容。
- Budget：每个正式场景 `maxTurns=4`、`finalizeAtTurn=3`、`maxBudgetUsd=0.10`、`timeoutMs=90000`。
- Cleanup：未执行；`scripts/cleanup.sh` 只记录保留状态，删除需要单独授权。

## Environment & Capability Map

| Capability | State | Evidence |
|---|---|---|
| Claude CLI | available | `2.1.207 (Claude Code)` |
| Authentication | available outside sandbox | `authenticated`, `authMethod=claude.ai` |
| Review tools | partial | Read/Grep/Glob and allowlisted Git Bash commands |
| Usage recovery | partial | Claude JSONL 保留 token usage；foreground/background 对非零退出均无法正常恢复完整 usage |
| Test repositories | available | small=1、medium=20、large=2000 个 changed files |

## DAG Schedule

1. 建立三个独立 fixture。
2. 静态测量 `collectReviewContext` 输出。
3. small 探测本次低预算启动消耗。
4. medium 与 large 并行执行受限真实 review。
5. 从 Claude 本地 JSONL 恢复工具行为和 token usage。

## Scenario Results

| ID | Scenario | Status | Expected | Actual | Diagnosis | Issue | Evidence |
|---|---|---|---|---|---|---|---|
| RV-01 | small inline diff | failed | 在 $0.10 内返回结构化结果 | 首轮工具读取后 code 1；wrapper 未返回预算详情 | product | [ISSUE-001](issues/ISSUE-001-preserve-budget-error-usage.md) | [RV-01](#rv-01-small) |
| RV-02 | medium tool-first | unverified | manifest 后按需抽样并返回可复核结果 | 观察到 stat 和 5/20 文件读取，但没有最终原始结果 | unknown | [ISSUE-001](issues/ISSUE-001-preserve-budget-error-usage.md) | [RV-02](#rv-02-medium) |
| RV-03 | large tool-first | failed | 对 2000 文件分片读取 | 首轮生成复合 `git -C` 命令，被 allowlist 拒绝 | product | [ISSUE-002](issues/ISSUE-002-bound-review-manifest.md), [ISSUE-003](issues/ISSUE-003-tool-first-command-contract.md) | [RV-03](#rv-03-large) |
| RV-04 | adversarial tool-first | skipped | 验证独立 prompt 的预算行为 | 本轮预算内未执行 | plan | — | — |
| RV-05 | Stop gate | skipped | 验证 gate 的预算和重复触发 | gate 当前无 turn/费用上限，为避免无界调用未执行 | product | [ISSUE-004](issues/ISSUE-004-bound-stop-review-gate.md) | — |

## Evidence & Failure Scenes

### RV-01 small

Probe：

```bash
node scripts/claude-companion.mjs review --model haiku --review-profile quick \
  --max-turns 4 --finalize-at-turn 3 --max-budget-usd 0.1 \
  --timeout-ms 90000 --json
```

Raw context measurement：

```json
{"fixture":"small","inline":true,"files":1,"contextBytes":4237}
```

Recovered session usage：

```json
{"models":["claude-sonnet-5"],"requests":1,"input":2,"cacheCreate":29127,"cacheRead":0,"output":1079,"tools":["Bash:wc -c ... && grep ..."]}
```

Actual wrapper output：

```json
{"ok":false,"error":"Claude exited with code 1"}
```

结论：本次 small 观测到约 29k cache-creation tokens，明显高于 4 KiB diff；该数值不是可外推的固定启动成本。未在 $0.10 内完成可能与预算或模型路由有关；wrapper 丢失错误 usage 是独立的产品缺陷。

### RV-02 medium

Raw context measurement：

```json
{"fixture":"medium","inline":false,"files":20,"contextBytes":585}
```

Recovered usage and tool sequence：

```json
{"models":["claude-sonnet-5"],"requests":2,"input":4,"cacheCreate":10837,"cacheRead":43618,"output":1729,"tools":["git diff --stat","git diff -- src/module-00000.js ... module-00004.js","Grep:changed(0|1|2|3)"]}
```

第二个 Git probe 返回 50.7 KiB，Claude 将大输出持久化并只把预览放回上下文。该证据支持“tool-first 能按需抽样”的可行性，但因为没有保留最终原始结果和可独立复查的 session 输出，RV-02 只能标记为 `unverified`。

### RV-03 large

Raw context measurement：

```json
{"fixture":"large","inline":false,"files":2000,"contextBytes":44147}
```

Recovered usage：

```json
{"models":["claude-sonnet-5"],"requests":1,"input":2,"cacheCreate":27880,"cacheRead":18154,"output":3177}
```

Raw tool denial：

```text
This Bash command contains multiple operations. The following parts require approval:
git -C ... diff --stat, tail -5; echo "---SAMPLE DIFF---"; git -C ... diff ...
```

结论：tool-first 的首个命令必须遵守 allowlist 的精确语法；否则低预算 review 会把唯一一轮浪费在权限拒绝上。

## Failures / Defects / Plan Gaps

| Item | Type | Disposition | Impact |
|---|---|---|---|
| Foreground/background 非零退出丢失 usage | product defect | OPEN | 无法区分预算耗尽、模型错误和 CLI 故障，后台 result 也不可恢复 |
| 文件名 manifest 无总量上限 | product defect | OPEN | 2000 文件已占 44 KiB；规模继续增长时初始 prompt 线性膨胀 |
| Tool-first prompt 未声明可执行 Git 语法 | product defect | OPEN | large 场景首轮被权限系统拒绝 |
| Stop gate 无 turn/费用上限 | product defect | OPEN | 启用后单次调用只有 840 秒墙钟限制，无法证明 token/费用有界 |
| 请求 `haiku` 实际记录为 `sonnet-5` | unknown/upstream | CONDITIONAL | 不能用本轮数据判断 Haiku 成本；需独立核对 Claude alias 路由 |

对应本地问题：[ISSUE-001](issues/ISSUE-001-preserve-budget-error-usage.md)、[ISSUE-002](issues/ISSUE-002-bound-review-manifest.md)、[ISSUE-003](issues/ISSUE-003-tool-first-command-contract.md)、[ISSUE-004](issues/ISSUE-004-bound-stop-review-gate.md)。

## Data Created & Cleanup

- 创建：三个本地 Git fixture，总计约 16 MiB。
- Retention：保留到方案实现或用户要求清理。
- Cleanup：未执行；本次没有获得删除测试痕迹的授权。

## Re-run Instructions

实现修复后重跑 RV-01、RV-02、RV-03，并补跑 RV-04、RV-05。通过条件：

1. budget exhaustion 返回真实 subtype、usage、cost 和 session id；
2. 100k 文件 manifest 初始 prompt 保持常数级或有明确采样上限；
3. large 首轮执行合法的单一 Git probe；
4. 相同预算下至少完成结构化 partial result，或明确报告 `budget_exhausted`。
5. adversarial review 和 Stop gate 也满足同一预算不变量。

## Next Actions for Agent

1. 先修 ISSUE-001，否则后续成本实验不可观测。
2. 将 review context 改成有界 manifest，不设置 96 KiB 的 diff 业务上限。
3. 优先提供专用只读 diff adapter；prompt 语法约束只能作为辅助，不作为硬保证。
4. 修复后重跑五个场景，再决定是否完全取消小 diff inline。
