# Task Execution Lease E2E 执行报告

**结论：PASS**
**执行时间：** 2026-07-18 09:56–09:57 UTC
**计划：** `docs/e2e-test/task-execution-lease/2026-07-18-task-execution-lease-e2e-test-plan.md`
**执行范围：** TEL-E2E-001–009
**真实模型调用：** 0；全部使用 fake Claude
**阻断问题：** 0
**建议问题：** 0

## 1. 总结

Task Execution Lease 的 installed-cache E2E 通过。关键成本结论已被真实 MCP 进程链证明：

- turn/cost breaker 后保存 durable checkpoint，不自动启动第二次 Claude invocation；
- resume 只能显式发生，并复用 session、串行关联一个 child、累计 cost chain；
- 写 checkpoint 不能 apply，resume 复用同一 sandbox，完成后才产生 `awaiting_apply`，显式 apply 后源码才改变；
- receipt/controller/session 异常、重复或 stale claim、cancel、timeout、source drift 均 fail closed 或安全收敛；
- installed cache 聚焦测试 16/16，全量回归 137/137。

## 2. 被测环境与门禁

| 项目 | 实际值 | 结果 |
|---|---|---|
| 平台 | macOS | PASS |
| Node.js | v26.0.0 | PASS |
| Git | 2.50.1 (Apple Git-155) | PASS |
| installed plugin | `0.1.0+codex.20260718001845` | PASS |
| MCP inventory | 13 tools，包含 `claude_task_resume` | PASS |
| 关键哈希 | source 与 installed cache 三项一致 | PASS |
| 测试传输 | public stdio MCP + service + worker + controller + fake Claude | PASS |
| 网络/付费模型 | 未使用 | PASS |

关键文件哈希：

```text
4df568446112a44e0125e2f11f8bd39cf7c6164ba7991b0c2b1c67785503fc00  mcp/server.mjs
5690e1aeb4fd8b9f6f88af9780ded3dfb6aa5617d37fbb22c3578ecfb70bdb3b  scripts/lib/service.mjs
1c0b7e1f3d9968dbabce0c2862866f90aa157b622984518074254aa4d6ee1c4c  scripts/lib/task-execution-lease.mjs
```

MCP probe 关键原始输出：

```json
{
  "ok": true,
  "probe": {
    "server_name": "cc-plugin-codex",
    "server_version": "0.1.0+codex.20260718001845",
    "tool_count": 13,
    "tools": ["claude_task_readonly", "claude_task_resume", "claude_write_task_start"]
  }
}
```

上面 tools 仅摘录与本计划有关的三项；原始 probe 同时返回其余 10 项工具。

## 3. 场景判定

| ID | 场景 | 结果 | 直接证据 |
|---|---|---|---|
| TEL-E2E-001 | 安装新鲜度、配置与 MCP inventory | PASS | 3/3 哈希一致；probe ok；controller 1/1 |
| TEL-E2E-002 | readonly turn breaker checkpoint | PASS | 前后台 2/2；均 durable checkpoint |
| TEL-E2E-003 | 显式 readonly resume | PASS | 1/1；同 session、linked child、累计成本 |
| TEL-E2E-004 | cost breaker 不自动 retry | PASS | 1/1；fake Claude invocation count 为 1 |
| TEL-E2E-005 | isolated write resume/apply | PASS | 1/1；checkpoint apply 被拒，同 sandbox resume |
| TEL-E2E-006 | receipt/controller/session 异常 | PASS | 3/3 fail closed |
| TEL-E2E-007 | stale/duplicate/cancel/timeout/drift | PASS | 5/5 分组场景；完整套件另覆盖 linkage idempotency |
| TEL-E2E-008 | 聚焦与全量回归 | PASS | 16/16；137/137；0 fail |
| TEL-E2E-009 | 默认关闭与旧 resume 兼容 | PASS | 全量套件中 config default-off 与 typed explicit resume 均通过 |

## 4. 分场景原始执行摘要

### TEL-E2E-001

```text
✔ task controller exposes two bounded receipts and only completes with no gaps
tests 1
pass 1
fail 0
```

### TEL-E2E-002

```text
✔ readonly task checkpoints instead of failing at the turn breaker
✔ foreground readonly task waits for a durable checkpointed outcome
tests 2
pass 2
fail 0
```

### TEL-E2E-003

```text
✔ readonly task resumes one checkpoint explicitly and completes the linked cost chain
tests 1
pass 1
fail 0
```

### TEL-E2E-004

```text
✔ readonly task checkpoints at the cost breaker without an automatic retry
tests 1
pass 1
fail 0
```

### TEL-E2E-005

```text
✔ isolated write checkpoint cannot apply and resumes in the same sandbox
tests 1
pass 1
fail 0
```

### TEL-E2E-006

```text
✔ successful upstream exit without any receipt fails closed
✔ breaker without a checkpoint or session cannot become resumable
✔ corrupt task controller state fails closed as MCP startup corruption
tests 3
pass 3
fail 0
```

### TEL-E2E-007

```text
✔ a stale unlinked resume claim safely returns to checkpointed before retry
✔ cancelling a leased task terminates its controller and removes control state
✔ timing out a leased task removes controller state and does not make it resumable
✔ isolated write resume fails closed after source drift and can be discarded
✔ a stale unlinked write resume claim can be explicitly discarded
tests 5
pass 5
fail 0
```

### TEL-E2E-008 / 009

```text
focused installed-cache suite:
tests 16
pass 16
fail 0

full repository suite:
tests 137
pass 137
fail 0

TASKLOOP_CRITERION: satisfied - Task Execution Lease E2E and full checks pass
VERIFIER_EXIT_CODE=4
```

`verify-task-execution-lease.mjs` 用退出码 4 表示 verifier 已给出终态；本次同时校验其输出必须为 `criterion satisfied`，因此不是失败。

## 5. 覆盖结论

| 根风险 | E2E 结论 |
|---|---|
| 第一次撞限制后自动重试，重复付费 | 已排除：turn/cost 场景断言单 invocation 且无自动 child |
| 第二轮重复探索 | 已降低：显式 resume 绑定原 session 与 checkpoint summary |
| 同一 checkpoint 并发续跑 | 已排除：claim-before-child、重复 resume 拒绝、linkage idempotency 通过 |
| 写任务续跑绕过 sandbox | 已排除：相同 sandbox identity 重验，source drift fail closed |
| 未完成写产物进入源码 | 已排除：checkpoint apply 被拒；只有 completion 后 awaiting_apply 可显式应用 |
| 无可信 checkpoint 却标记可恢复 | 已排除：receipt/session/controller 异常全部 failed |

## 6. 测试数据、污染与清理

- 本轮 fixture 根目录：`<tmp>/cc-plugin-codex-task-lease-e2e.20260718T095607Z`。
- 共保留 156 个顶层 fixture/临时条目，供 7 天内复查；默认不清理。
- 执行前后源码状态一致；executor 未修改业务源码、配置或测试。仓库新增内容仅为本轮 E2E 计划和本报告。
- 未对用户既有 dirty worktree 做 reset、checkout 或清理。

复查命令：

```sh
export PLUGIN_INSTALLED="$(find "$HOME/.codex/plugins/cache/personal/cc-plugin-codex" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)"
cd "$PLUGIN_INSTALLED"
node --test test/task-execution-controller.test.mjs test/task-execution-lease.test.mjs
node test/verify-task-execution-lease.mjs
```

证据到期后清理：

```sh
rm -rf "<tmp>/cc-plugin-codex-task-lease-e2e.20260718T095607Z"
```

## 7. 最终判定

Task Execution Lease 达到本计划的 Agent-ready E2E 验收标准，可以进入提交前审查。没有发现需要修改实现的 E2E 缺陷。
