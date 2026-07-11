# cc-plugin-codex 修复后 E2E 复测报告

## Execution Summary

- 选择集：原 run 的 E2E-01/02/03/04/05/06/07/08/10 及依赖 E2E-11。
- 结果：`passed=4`、`failed=0`、`blocked=6`、`skipped=0`。
- 本地修复验证：15/15 tests、全部 `node --check`、plugin validator 通过。
- separator 中间构建的真实 review/adversarial 已通过并准确识别算术回归。
- 最终构建加入 `--safe-mode` 以阻止 Claude 用户 hooks 写入 `.taskloop/`；真实复测被 Claude session limit 阻塞，重置时间为 14:30 Asia/Shanghai。
- 两个原 OPEN issue 已转为 `CONDITIONAL`，没有新的 OPEN 根因。

## Run Lineage & Emergent Scenarios

- Upstream plan：`<vault>/projects/cc-plugin-codex/DESIGN.md`。
- Upstream run：`../e2e-run-design-20260711T044401Z/execution-report.md`。
- Downstream：quota reset 后重跑 E2E-03/04/05/06/08/10/11。
- Status：open（外部配额条件）。

| Emergent scenario | Source trigger | Risk family | Plan section to update | Status |
|---|---|---|---|---|
| E2E-12 review local side-effect | 成功 adversarial 后出现 `.taskloop/untracked-writes.json` | read-only isolation | review profile | accepted |
| E2E-13 quota-limited final rerun | final safe-mode build 返回 HTTP 429 | external dependency | E2E environment gates | accepted |

## Environment State Ledger

- Target：本地 companion 与保留 fixture `/private/tmp/cc-plugin-codex-e2e.XcSnh0`。
- Datasource：用户 job state 与 fixture config；plugin runtime 优先使用 `PLUGIN_DATA/{jobs,config}`。
- Deployment/freshness evidence：`claude.mjs` SHA `8677f93f93ec1b4a6300d3452e06e3e8a2a99968211a5ca705a2f3f7348b8b30`；`state.mjs` `624fc5f83f7d4665fbf2a6184ff294d808a1889ea377be2491c5ea5603b61ba5`；`config.mjs` `98ee95548d0b4e88e4fbbdd473b59f97f97f2494de485b911a3189d37d42da78`；fixture HEAD `07515a59996dbc19a49d3b48e13546301b9bc1e9`。
- Isolation namespace：沿用 upstream fixture/job ids；本轮新增 Claude review sessions。
- Created data：新增 review/adversarial sessions 与 `.taskloop/untracked-writes.json` 失败现场。
- Cleanup policy：preserve traces，沿用 upstream quarantine 脚本，TTL 7 天。
- Remaining traces：fixture 的 app diff、config、stop input、`.taskloop` 证据、job logs。
- Tool permissions：真实 auth/status 使用沙箱外权限；默认 sandbox setup 仅作歧义态验证。

## Run Metadata

- 时间：2026-07-11T05:05:16Z 起。
- Node v26.0.0；Claude Code 2.1.207；Codex CLI 0.144.1。
- 代码路径：`/Users/hex1n/cc-plugin-codex`；fixture：`/private/tmp/cc-plugin-codex-e2e.XcSnh0`。
- Data policy：保留痕迹，不执行 cleanup。

## Environment & Capability Map

| Facet | Result |
|---|---|
| Local tests/static/plugin validator | available，全部 green |
| Keychain auth | 沙箱外 available；setup authenticated=true |
| Default sandbox auth | 返回 `unavailable-or-not-logged-in`，不再误报登出 |
| Review separator | 真实 Claude intermediate build verified |
| Final safe-mode live model | blocked by HTTP 429 session limit |
| Job state | `PLUGIN_DATA` regression green；保留 job 的 escalated status green |
| Stop recursion | final build green，无模型调用 |

## DAG Schedule

`freshness → tests → {setup inside,outside,status} → {review,adversarial} → side-effect probe → {Stop live,Stop recursive}`。

依赖 Claude 模型的节点在 429 后停止重复触发；不依赖模型的状态与递归节点继续执行。

## Scenario Results

| Scenario | Status | Expected | Actual | Diagnosis | Issue | Evidence / scene |
|---|---|---|---|---|---|---|
| E2E-01 outside setup | `passed` | authenticated | true / authenticated | `environment` | — | [证据](#e2e-01-outside-setup) |
| E2E-02 sandbox setup | `passed` | 不误报登出 | ambiguous state | `product` | — | [证据](#e2e-02-sandbox-setup) |
| E2E-03 task final build | `blocked` | 固定 task marker | quota 未触发 | `environment` | — | [证据](#quota-blocked-scenarios) |
| E2E-04 review final build | `blocked` | findings + no side-effect | intermediate findings 通过；final 429 | `environment` | — | [证据](#e2e-0405-review-paths) |
| E2E-05 adversarial final build | `blocked` | findings + no side-effect | intermediate findings 通过；final 429 | `environment` | — | [证据](#e2e-0405-review-paths) |
| E2E-06 background final build | `blocked` | completed/result | quota 未触发 | `environment` | — | [证据](#quota-blocked-scenarios) |
| E2E-07 status integration | `passed` | supported path 可写回 | escalated status completed | `product` | — | [证据](#e2e-07-status-integration) |
| E2E-08 cancel final build | `blocked` | cancelled/PID gone | quota 未触发 | `environment` | — | [证据](#quota-blocked-scenarios) |
| E2E-10 Stop live verdict | `blocked` | structured verdict/no hook side-effect | final 429 | `environment` | — | [证据](#quota-blocked-scenarios) |
| E2E-11 recursion guard | `passed` | active 直接 pass | valid pass JSON | `product` | — | [证据](#e2e-11-recursion-guard) |

## Evidence & Failure Scenes

### E2E-01 outside setup

- Probe：沙箱外 `node scripts/claude-companion.mjs setup --json`。
- Expected/actual：真实登录可见；符合。
```json
{"authenticated":true,"authenticationState":"authenticated","version":"2.1.207 (Claude Code)","authMethod":"claude.ai"}
```
- Re-query：同命令沙箱外执行；无新增数据。

### E2E-02 sandbox setup

- Probe：默认 sandbox setup。
- Expected：不再断言 logged out；actual 符合。
```json
{"authenticated":false,"authenticationState":"unavailable-or-not-logged-in","authMethod":"none"}
```
- Re-query：repo 根直接运行 setup；无清理。

### E2E-04/05 review paths

- Probe：separator 修复后真实 review/adversarial；两者 exit 0，并分别报告 `app.js:2` 的 Critical 算术回归。
```text
Review: Critical (correctness): add now subtracts — app.js:2
Adversarial: Critical — add now performs subtraction (app.js:2)
```
- Freshness caveat：随后加入 final `--safe-mode`，最终调用被 quota 阻塞；未将 intermediate 结果冒充 final green。
- Side-effect scene：intermediate adversarial 触发用户 Claude hook 写入 `.taskloop/untracked-writes.json`，session `46ea2503-c825-48e5-9fc9-072d373dd6b1`；因此 final profile 加入 `--safe-mode`。
- Re-query：quota reset 后运行 review/adversarial，并比较 fixture `git status --short` 与 `.taskloop/untracked-writes.json` SHA/mtime。

### E2E-07 status integration

- Probe：按 skill 指令使用沙箱外 status 查询保留 job。
- Expected/actual：completed；符合。
```json
{"id":"850e2349-de2e-4c66-97f6-52587130b9c1","status":"completed","pid":29020,"profile":"task"}
```
- Regression evidence：`PLUGIN_DATA` job/config 路径测试通过；re-query 为同一 status 命令。

### E2E-11 recursion guard

- Probe：final hook，fixture config，`stop_hook_active=true`。
```json
{"continue":true,"suppressOutput":true}
```
- Expected/actual：符合；无模型调用，无新增数据。

### Quota-blocked scenarios

- Probe：final safe-mode Claude CLI。
- Expected：模型响应。
- Actual：外部配额拒绝。
```json
{"is_error":true,"api_error_status":429,"result":"You've hit your session limit · resets 2:30pm (Asia/Shanghai)","terminal_reason":"api_error"}
```
- Re-query：14:30 Asia/Shanghai 后按下节命令重跑。
- Cleanup safety：保留当前 scene，不创建重复任务消耗配额。

## Failures / Defects / Plan Gaps

### ISSUE-001

- Disposition：`CONDITIONAL`。
- separator 产品修复已由真实 intermediate build 证明；final safe-mode build 需 quota reset 后重跑 E2E-04/05/10/11。

### ISSUE-002

- Disposition：`CONDITIONAL`。
- setup inside/outside、PLUGIN_DATA 与 escalated status 已通过；剩余 Claude-backed dependents 需 quota reset 后验证。

### E2E-12 read-only local side-effect

- Disposition：`CONDITIONAL`。
- 修复：review profile 加 `--safe-mode`；local argv 回归 green，live 无副作用验证被 quota 阻塞。

没有 `OPEN` 根因；当前仅有外部配额前置条件。

## Data Created & Cleanup

- 沿用 upstream fixture/jobs；新增 Claude sessions 与 `.taskloop` 失败现场。
- 不清理；TTL 7 天；使用 upstream `scripts/cleanup.sh` 做可逆 quarantine。

## Re-run Instructions

14:30 Asia/Shanghai 后，在 fixture 中以沙箱外权限执行：

```bash
node /Users/hex1n/cc-plugin-codex/scripts/claude-companion.mjs task "Do not use tools or edit files. Reply exactly CC_PLUGIN_CODEX_E2E_TASK_OK" --json
node /Users/hex1n/cc-plugin-codex/scripts/claude-companion.mjs review --json
node /Users/hex1n/cc-plugin-codex/scripts/claude-companion.mjs adversarial-review "arithmetic regression" --json
```

随后用 fixture config 运行 Stop live verdict，并复查 `git status` 与 `.taskloop` SHA/mtime。

## Next Actions for Agent

无 OPEN 修复项。配额重置后执行条件复测；全部通过后将 ISSUE-001/002 与 E2E-12 改为 `CLOSED`。

