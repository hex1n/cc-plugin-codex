# cc-plugin-codex E2E 执行报告

## Execution Summary

- 结果：`passed=6`、`failed=5`、`blocked=0`、`skipped=0`。
- 真实链路：companion → Claude Code CLI 2.1.207 → claude.ai 登录态。
- 通过：沙箱外 setup/auth、同步 task、后台 result、cancel、transfer、Stop 递归保护。
- 开放缺陷：review profile 的 variadic `--allowedTools` 吞掉 prompt；Codex workspace sandbox 无法读取 Keychain 或更新 `~/.codex` job 状态。
- 清理：未执行；保留 fixture、job 日志和临时 gate 配置供修复复查。

## Run Lineage & Emergent Scenarios

- Upstream plan：`<vault>/projects/cc-plugin-codex/DESIGN.md`；Upstream run：none。
- Downstream：`../e2e-rerun-fix-20260711T050516Z/execution-report.md`；Status：open（等待 Claude 配额重置后的 final-build 条件复测）。

| Emergent scenario | Source trigger | Risk family | Plan section to update | Status |
|---|---|---|---|---|
| E2E-02 sandbox auth visibility | setup 沙箱内外相反 | 双层沙箱/认证 | 权限映射、setup | proposed |
| E2E-07 sandbox job finalization | completed 写回 `EPERM` | 状态持久化 | 状态目录、权限映射 | proposed |

## Environment State Ledger

- Target：本地 CLI plugin；`scripts/claude-companion.mjs`、`hooks/review-gate.mjs`。
- Datasource：`~/.codex/claude-companion/jobs/<workspace-hash>` 与 fixture `config/review-gate.json`。
- Deployment/freshness evidence：companion SHA-256 `cef69fd03ed99131d89bcbf1ce7bc1426fc9d0fa63ea5936d0a4568c1353973f`；hook `16e796f7791fc1a1ff2a3e1938ab77fbbfcafb3c94d01102f5a7df945ef311f7`；fixture HEAD `07515a59996dbc19a49d3b48e13546301b9bc1e9`。
- Isolation namespace：`/private/tmp/cc-plugin-codex-e2e.XcSnh0`；jobs `850e2349-de2e-4c66-97f6-52587130b9c1`、`49cd15ac-1749-4151-964c-c2ec4d349d49`。
- Created data：1 个 Git fixture、2 个 job 记录及日志、1 个 fixture gate 配置、Claude 测试 sessions。
- Cleanup policy：preserve traces，TTL 7 天；清理脚本 `scripts/cleanup.sh`。
- Remaining traces：上述 fixture/job/log/config；均为本次 E2E 自有数据。
- Tool permissions：真实 Claude 必须使用沙箱外执行以访问 macOS Keychain。

## Run Metadata

- 时间：2026-07-11T04:44:01Z；环境：local macOS。
- Node：`/opt/homebrew/bin/node`，`v26.0.0`。
- Claude：`/Users/hex1n/.local/bin/claude`，`2.1.207 (Claude Code)`。
- Codex：`/opt/homebrew/bin/codex`，`codex-cli 0.144.1`。
- Auth：沙箱外 `loggedIn=true`、`authMethod=claude.ai`；身份字段已脱敏。
- Fixture：基线 commit 后将 `add(a,b)` 从加法改成减法形成真实 diff。

## Environment & Capability Map

| Facet | Capability | Gate/result |
|---|---|---|
| CLI | Node/Claude/Codex/git | available，路径版本已固定 |
| Trigger Channel Gates | Claude Keychain auth | 仅沙箱外 available |
| Git context | 隔离 fixture + real diff | available |
| Job control | detached PID + JSON/log | 沙箱外 available；沙箱内写回失败 |
| Hook | 真实 Stop wire JSON | available |
| Plugin trust UI | `/hooks` | 未安装 plugin，未覆盖 |

Environment Contract preflight 已满足：工具身份、实现 SHA、fixture commit、有效认证目标均为解析后的具体值，而非 profile 推断。

## DAG Schedule

`E2E-01 → {02,03} → {04,05,06,08,09} → 07 → 10 → 11`

- 先通过真实认证门；task 后检查 Git 状态再 review。
- result 等待完成；cancel 使用独立 job；Stop gate 使用 fixture 专属配置。

## Scenario Results

| Scenario | Status | Expected | Actual | Diagnosis | Issue | Evidence / scene |
|---|---|---|---|---|---|---|
| E2E-01 outside auth/setup | `passed` | 真实登录可见 | authenticated=true | `environment` | — | [证据](#e2e-01-outside-authsetup) |
| E2E-02 sandbox setup | `failed` | 同一登录可见 | 误报 false | `product` | [ISSUE-002](issues/ISSUE-002-sandbox-auth-state.md) | [证据](#e2e-02-sandbox-setup) |
| E2E-03 synchronous task | `passed` | 固定标记且无写入 | 完全匹配 | `product` | — | [证据](#e2e-03-synchronous-task) |
| E2E-04 review | `failed` | 找出算术回归 | prompt 缺失 | `product` | [ISSUE-001](issues/ISSUE-001-review-prompt-swallowed.md) | [证据](#e2e-04-review) |
| E2E-05 adversarial | `failed` | 返回挑战 findings | prompt 缺失 | `product` | [ISSUE-001](issues/ISSUE-001-review-prompt-swallowed.md) | [证据](#e2e-05-adversarial) |
| E2E-06 background result | `passed` | running→completed→result | 完整通过 | `product` | — | [证据](#e2e-06-background-result) |
| E2E-07 sandbox finalization | `failed` | status 写回 completed | `EPERM` | `product` | [ISSUE-002](issues/ISSUE-002-sandbox-auth-state.md) | [证据](#e2e-07-sandbox-finalization) |
| E2E-08 cancel | `passed` | cancelled/无结果/PID 消失 | 全部满足 | `product` | — | [证据](#e2e-08-cancel) |
| E2E-09 transfer | `passed` | apostrophe 保留、非 faithful | 正确 | `product` | — | [证据](#e2e-09-transfer) |
| E2E-10 Stop live review | `failed` | structured verdict | 安全 block，但未审查 | `product` | [ISSUE-001](issues/ISSUE-001-review-prompt-swallowed.md) | [证据](#e2e-10-stop-live-review) |
| E2E-11 recursion guard | `passed` | active 时直接 pass | 正确 | `product` | — | [证据](#e2e-11-recursion-guard) |

## Evidence & Failure Scenes

### E2E-01 outside auth/setup

- Probe：沙箱外 `node scripts/claude-companion.mjs setup --json`。
- Expected/actual：installed/authenticated 为 true；符合。
- Raw（身份脱敏）：
```json
{"installed":true,"authenticated":true,"version":"2.1.207 (Claude Code)","authMethod":"claude.ai"}
```
- Re-query：同命令沙箱外重跑；无额外清理。

### E2E-02 sandbox setup

- Probe：默认 sandbox 运行 setup；expected 同一登录可见；actual 误报。
```json
{"installed":true,"authenticated":false,"version":"2.1.207 (Claude Code)","authMethod":"none"}
```
- Re-query：分别在默认 sandbox 与沙箱外运行 setup；无清理。

### E2E-03 synchronous task

- Probe：真实 task 要求只返回固定标记；expected 固定标记/session/无写入；actual 符合。
```json
{"ok":true,"result":"CC_PLUGIN_CODEX_E2E_TASK_OK","session_id":"e86c8721-e028-4a50-8718-23e12e62dc04"}
```
```text
 M app.js
```
- Re-query：重跑后 `git status --short`；session 保留 7 天。

### E2E-04 review

- Probe：真实 diff 上沙箱外 `review --json`；expected 指出 `+`→`-`；actual prompt 未到达。
```json
{"ok":false,"error":"Error: Input must be provided either through stdin or as a prompt argument when using --print"}
```
- Re-query：在保留 fixture 重跑；fixture 禁止清理至 ISSUE-001 复测。

### E2E-05 adversarial

- Probe：`adversarial-review 'arithmetic regression' --json`；expected findings；actual 同 E2E-04。
```json
{"ok":false,"error":"Error: Input must be provided either through stdin or as a prompt argument when using --print"}
```
- Re-query/scene：同 E2E-04。

### E2E-06 background result

- Probe：background→status→result（沙箱外）；expected 完整转换；actual 符合。
```json
{"id":"850e2349-de2e-4c66-97f6-52587130b9c1","status":"running","pid":29020}
{"id":"850e2349-de2e-4c66-97f6-52587130b9c1","status":"completed","pid":29020}
{"ok":true,"result":"CC_PLUGIN_CODEX_E2E_BACKGROUND_OK","session_id":"5ea67005-3911-4784-8ecc-a2ed85cd6719"}
```
- Re-query：沙箱外 result；job/log/session 保留 7 天。

### E2E-07 sandbox finalization

- Probe：job 结束后默认 sandbox status；expected 写回；actual EPERM。
```json
{"ok":false,"error":"EPERM: operation not permitted, open '/Users/hex1n/.codex/claude-companion/jobs/7a2cf055c8e438b3/850e2349-de2e-4c66-97f6-52587130b9c1.json'"}
```
- Re-query：新建后台 job，结束后默认 sandbox status；原 job 已由沙箱外修正为 completed。

### E2E-08 cancel

- Probe：启动长 job 后立即 cancel，再查 status/result/ps；expected cancelled、无结果、PID 消失；actual 符合。
```json
{"id":"49cd15ac-1749-4151-964c-c2ec4d349d49","status":"cancelled","pid":30637}
{"ok":false,"error":"Job 49cd15ac-1749-4151-964c-c2ec4d349d49 was cancelled"}
```
`ps -p 30637` exit 1 且无输出。Re-query：沙箱外 status/result；日志保留 7 天。

### E2E-09 transfer

- Probe：含 `O'Brien` 的 digest；expected 保留且非 faithful；actual 符合。
```json
{"ok":true,"kind":"summary-seed","faithful_import":false,"argv":["claude","... Goal: preserve O'Brien input; Next: verify"]}
```
- Re-query：同一 transfer；无状态。

### E2E-10 Stop live review

- Probe：fixture config 启用 gate，真实 Stop input，沙箱外；expected structured verdict；actual 安全 block 但未审查。
```json
{"decision":"block","reason":"Claude review gate could not complete: Error: Input must be provided either through stdin or as a prompt argument when using --print. Fix setup or disable the review gate explicitly."}
```
- Re-query：`CLAUDE_COMPANION_CONFIG_ROOT=<fixture>/config node hooks/review-gate.mjs < <fixture>/stop-input.json`，active=false；config/input 保留。

### E2E-11 recursion guard

- Probe：active=true；expected 直接 pass；actual 符合。
```json
{"continue":true,"suppressOutput":true}
```
- Re-query：同 E2E-10，active=true；无新增状态。

## Failures / Defects / Plan Gaps

### DEFECT-001 — review prompt 被吞掉

- Disposition：`CONDITIONAL`；P1 product defect；separator 已修并有真实 Claude 成功证据，final safe-mode build 等待配额重置复测。
- Evidence：review profile 的 variadic `--allowedTools` 后接裸 prompt，Claude 2.1.207 把 prompt 继续解析为 tool 值。
- Issue：[ISSUE-001](issues/ISSUE-001-review-prompt-swallowed.md)。

### DEFECT-002 — sandbox 隔离 auth/state

- Disposition：`CONDITIONAL`；P1 product integration defect；setup/state 支持路径已通过，Claude-backed dependents 等待配额重置复测。
- Evidence：同 CLI/HOME，沙箱外 auth=true、内=false；写 `~/.codex` job 返回 EPERM。
- Issue：[ISSUE-002](issues/ISSUE-002-sandbox-auth-state.md)。

### GAP-001 — plugin trust UI

- Disposition：`CONDITIONAL`；未安装 marketplace plugin，无法执行 `/hooks` trust UI。前置：完成 final-build 条件复测并安装 plugin。

## Data Created & Cleanup

- Fixture `/private/tmp/cc-plugin-codex-e2e.XcSnh0`、两个 job id、测试 sessions；owner `cc-plugin-codex-e2e`，TTL 7 天。
- Seed：`scripts/seed-fixture.sh`；Cleanup：`scripts/cleanup.sh`。
- 本轮不清理，以保留失败现场。

## Re-run Instructions

```bash
bash docs/e2e-test/cc-plugin-codex/e2e-run-design-20260711T044401Z/scripts/seed-fixture.sh /private/tmp/cc-plugin-codex-e2e-rerun
node scripts/claude-companion.mjs setup --json
node scripts/claude-companion.mjs review --json
node scripts/claude-companion.mjs adversarial-review "arithmetic regression" --json
```

真实 Claude 命令需使用可访问 Keychain 的沙箱外通道。

## Next Actions for Agent

1. 修复 ISSUE-001；重跑 E2E-04/05/10/11。
2. 修复 ISSUE-002；重跑 E2E-01/02/03/06/07/08/10。
