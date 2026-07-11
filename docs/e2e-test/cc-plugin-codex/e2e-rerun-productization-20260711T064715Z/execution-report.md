# cc-plugin-codex 产品化 E2E 条件复测报告

## Execution Summary

- 选择集：上游 blocked 场景 E2E-03/04/05/06/08/10/11，以及依赖的 E2E-12 只读副作用验证。
- 最终结果：`passed=8`、`failed=0`、`blocked=0`、`skipped=0`。
- 首次真实 review 暴露 Claude Code 2.1.207 schema dialect 兼容缺陷；修复后同场景与全部依赖场景通过。
- 本地质量门：`npm run check`，49/49 tests 通过。
- Data policy：preserve traces；不清理 fixture、Claude sessions、job state 或旧失败现场。

## Run Lineage & Emergent Scenarios

- Upstream plan：`../../../plans/2026-07-11-cc-plugin-codex-productization.md`。
- Upstream run：`../e2e-rerun-fix-20260711T050516Z/execution-report.md`。
- Downstream：`../e2e-install-cache-20260711T065812Z/execution-report.md`（personal marketplace 安装缓存与平台发布门）。
- 本次状态：上游配额 blocker 已解除；E2E-03/04/05/06/08/10/11 与 E2E-12 全部关闭。

| Emergent scenario | Source trigger | Risk family | Backflow target | Status |
|---|---|---|---|---|
| E2E-14 Claude schema dialect | 首次真实 review 在模型执行前拒绝 Draft 2020-12 meta-schema URI | CLI compatibility | Prompt/schema contract | `closed` |

## Environment State Ledger

- Target：本地源码 `/Users/hex1n/cc-plugin-codex`；保留 fixture `/private/tmp/cc-plugin-codex-e2e.XcSnh0`。
- Datasource：fixture Git working tree；Codex/Claude 用户态 job 与 config 存储。
- Deployment/freshness evidence：`claude.mjs` SHA `2989ac5ca683a129e62a4af2caab73115208428e3648dbf725f5950917744e3a`；`state.mjs` `8b973479eba2a98dffb06d50de41344f066d3c930f1792c9e388f33900490acd`；fixture HEAD `07515a59996dbc19a49d3b48e13546301b9bc1e9`。
- Runtime：Node `v26.0.0`；Claude Code `2.1.207`；auth `claude.ai`、`authenticated=true`。
- Isolation namespace：fixture `cc-plugin-codex-e2e`；新 job `59a2e56d-b382-4ed8-85cc-b37264f6d154`、`df858b77-4651-4dbd-bbbc-ff4fba42b370`。
- Created data：4 个 Claude sessions、2 个 tracked jobs；没有业务数据或源码编辑。
- Cleanup policy：preserve traces；TTL 沿用上游 7 天；清理入口沿用上游 `scripts/cleanup.sh`。
- Remaining traces：fixture diff、`.taskloop/untracked-writes.json`、job JSON/log、Claude sessions。
- Tool permissions：真实 Claude 调用使用沙箱外已登录凭据；fixture 内只读 review 与可取消后台任务。

## Run Metadata

- 时间：2026-07-11T06:41Z–2026-07-11T06:47Z。
- 触发面：`claude-companion.mjs` foreground/background CLI、status/result/cancel、Stop hook。
- Execution Contract Override：无；继续采用 preserve-traces 和只重跑 blocked + dependents。

## Environment & Capability Map

| Facet | Result |
|---|---|
| Claude CLI discovery/auth | `available`，2.1.207，authenticated |
| Trigger channel | 沙箱外 CLI 获准；fixture 路径与 Git 可读 |
| Local tests/static validation | `npm run check` green，49/49 |
| Structured review schema | 修复后 CLI 接受，模型返回 `structured_output` |
| Detached job state | start/status wait/result/cancel 可用 |
| Stop hook | live verdict 与 recursion guard 可用 |
| Cleanup | 可用但未执行，保留证据 |

## DAG Schedule

`freshness/setup → task → review → adversarial → background/status/result → cancel/PID/result → Stop live → recursion guard → side-effect fingerprint`。

所有 Claude-backed 节点串行执行，避免会话配额竞争；recursion guard 在 live gate 后执行；E2E-12 最后单独复跑并比较前后 SHA/mtime。

## Scenario Results

| Scenario | Status | Expected | Actual | Diagnosis | Issue | Evidence / scene |
|---|---|---|---|---|---|---|
| E2E-03 task | `passed` | 固定 marker/session | marker 与 session 返回 | `product` | — | [证据](#e2e-03-task) |
| E2E-04 review | `passed` | 找出算术回归/schema 合法 | critical/high finding at `app.js:2` | `product` | — | [证据](#e2e-04-review) |
| E2E-05 adversarial | `passed` | 对 arithmetic regression 给出证伪 finding | high finding，confidence 1 | `product` | — | [证据](#e2e-05-adversarial) |
| E2E-06 background | `passed` | completed/status/result/session | `done`、exit 0、固定 marker | `product` | — | [证据](#e2e-06-background) |
| E2E-08 cancel | `passed` | cancelled、进程消失、result 不误报完成 | hard cancellation；PID 无输出；result 拒绝 | `product` | — | [证据](#e2e-08-cancel) |
| E2E-10 Stop live | `passed` | structured block verdict | block，准确指出 `app.js` 回归 | `product` | — | [证据](#e2e-10-stop-live) |
| E2E-11 recursion guard | `passed` | active 时不调用 Claude | continue/suppressOutput | `product` | — | [证据](#e2e-11-recursion-guard) |
| E2E-12 read-only side-effect | `passed` | safe-mode review 不写用户 hook 痕迹 | SHA 与 mtime 前后相同 | `product` | — | [证据](#e2e-12-read-only-side-effect) |

## Evidence & Failure Scenes

### E2E-03 task

- Probe：`node .../claude-companion.mjs task 'Do not use tools or edit files. Reply exactly CC_PLUGIN_CODEX_E2E_TASK_OK' --json`
- Expected/actual：固定 marker、session、无编辑；符合。
```json
{"ok":true,"result":"CC_PLUGIN_CODEX_E2E_TASK_OK","structured_output":null,"session_id":"3e7c4a7d-3bf2-4fb1-90b2-21b07dc96ad1","resume_hint":"claude --resume 3e7c4a7d-3bf2-4fb1-90b2-21b07dc96ad1"}
```
- Re-query：同命令在 fixture 根执行；`git status --short` 仍只含保留 fixture 改动。

### E2E-04 review

- 首次 probe raw failure：
```json
{"ok":false,"error":"Error: --json-schema is not a valid JSON Schema: no schema with key or ref \"https://json-schema.org/draft/2020-12/schema\""}
```
- 修复：仅在传给 Claude CLI 时移除 `$schema` meta 字段；仓库 schema 与本地校验保持完整。
- Fresh probe：`node .../claude-companion.mjs review --json`。
```json
{"ok":true,"structured_output":{"verdict":"needs-attention","summary":"app.js changes add(a, b) from addition to subtraction","findings":[{"severity":"critical","title":"add() now subtracts instead of adding","file":"app.js","line_start":2,"line_end":2,"confidence":0.98}],"next_steps":["Restore return a + b","Add a unit test"]},"session_id":"2d5f3411-69a2-4cb0-8b90-f8afb73c430c"}
```
- Re-query：同 review 命令；最终副作用复跑 session `817748a5-d064-408a-b528-eebb6573e428` 仍返回同类 high finding。

### E2E-05 adversarial

- Probe：`adversarial-review 'arithmetic regression' --json`。
```json
{"ok":true,"structured_output":{"verdict":"needs-attention","summary":"add(a, b) silently performs subtraction","findings":[{"severity":"high","title":"add() subtracts instead of adds — silent arithmetic regression in exported function","file":"app.js","line_start":2,"line_end":2,"confidence":1}]},"session_id":"7e2ffbb0-5769-4913-943e-b67cb39a8c43"}
```
- Re-query：同命令；fixture `app.js:2` 仍为故障注入点。

### E2E-06 background

- Probe：后台 task → status `--wait` → result。
```json
{"id":"59a2e56d-b382-4ed8-85cc-b37264f6d154","status":"completed","phase":"done","exit_code":0,"session_id":"5c717809-ff27-4f0c-9e94-148748bead8f","prompt_name":"task-wrapper","prompt_version":1}
{"ok":true,"result":"CC_PLUGIN_CODEX_E2E_BACKGROUND_OK","session_id":"5c717809-ff27-4f0c-9e94-148748bead8f"}
```
- Re-query：`status 59a... --json` 与 `result 59a... --json`。

### E2E-08 cancel

- Probe：启动包含 `sleep 120` 的后台 task，随后 cancel、`ps -p 4704`、result。
```json
{"id":"df858b77-4651-4dbd-bbbc-ff4fba42b370","status":"cancelled","pid":4704,"session_id":"fb9ba3c9-0992-4e2d-b0f6-df935e34d7dc","cancellation":"hard_process_tree"}
{"ok":false,"error":"Job df858b77-4651-4dbd-bbbc-ff4fba42b370 was cancelled"}
```
- `ps -p 4704` 无进程行；result exit 1，未误报完成。
- Re-query：status/result 同 job id；不重新触发任务。

### E2E-10 Stop live

- Probe：fixture gate enabled，`stop_hook_active=false`，调用 `hooks/review-gate.mjs`。
```json
{"decision":"block","reason":"Claude review found actionable issues: app.js regresses the add function from return a + b to return a - b ..."}
```
- Re-query：用相同 fixture input 运行 hook；故障注入仍存在时应 block。

### E2E-11 recursion guard

- Probe：相同 hook，`stop_hook_active=true`。
```json
{"continue":true,"suppressOutput":true}
```
- Re-query：相同输入；无模型 session 或 job 被创建。

### E2E-12 read-only side-effect

- Probe：真实 review 前后比较 `.taskloop/untracked-writes.json`。
```text
before sha256=929deaf48e6672e0f99f29a4cc521c344d7bca42d4cdb88196b0e18a69577501 mtime=1783746278
after  sha256=929deaf48e6672e0f99f29a4cc521c344d7bca42d4cdb88196b0e18a69577501 mtime=1783746278
```
- Expected/actual：safe-mode 不触发用户 hook 写入；符合。
- Re-query：再次取 SHA/mtime；不需要修改 fixture。

## Failures / Defects / Plan Gaps

### E2E-14 Claude schema dialect

- Disposition：`CLOSED`。
- Classification：`product defect`。
- Root cause：Claude Code 2.1.207 的 bundled schema validator 不加载 Draft 2020-12 meta-schema URI；CLI 参数携带 `$schema` 时在模型执行前失败。
- Fix：`scripts/lib/claude.mjs` 的 CLI serialization 剥离 `$schema`，本地 schema 文件与本地 validation 保持不变。
- Closure evidence：focused prompt contract tests、49/49 full check、真实 review/adversarial/Stop 全部返回合法 structured output。

### Prior conditional items

- ISSUE-001 prompt separator：`CLOSED`；final safe-mode review/adversarial/Stop 已真实通过。
- ISSUE-002 sandbox auth/state：`CLOSED`；auth 可见、task/background/status/result/cancel 全链路通过。
- E2E-12 read-only local side-effect：`CLOSED`；前后 SHA/mtime 相同。

当前没有 `OPEN` actionable root cause。计划仍保留 Windows 实机与 marketplace 安装缓存 E2E 作为独立发布证据，不属于本次本地 Claude rerun 选择集。

## Data Created & Cleanup

- Created：Claude sessions `3e7c...`、`2d5f...`、`7e2f...`、`8177...`、`5c71...`、`fb9b...`；jobs `59a2...`、`df85...`。
- Ownership：`cc-plugin-codex-e2e` fixture namespace。
- Cleanup：未执行，preserve traces；沿用上游 `e2e-run-design-20260711T044401Z/scripts/cleanup.sh`，TTL 7 天。

## Re-run Instructions

```bash
node /Users/hex1n/cc-plugin-codex/scripts/claude-companion.mjs task 'Do not use tools or edit files. Reply exactly CC_PLUGIN_CODEX_E2E_TASK_OK' --json
node /Users/hex1n/cc-plugin-codex/scripts/claude-companion.mjs review --json
node /Users/hex1n/cc-plugin-codex/scripts/claude-companion.mjs adversarial-review 'arithmetic regression' --json
```

从 `/private/tmp/cc-plugin-codex-e2e.XcSnh0` 执行，并使用沙箱外已登录 Claude 凭据。后台与 Stop 场景按本报告中的 job/input 重建，禁止复用旧 terminal job 作为新鲜证据。

## Next Actions for Agent

无本次选择集内的 OPEN 项。后续发布门只需另行执行 Windows 实机与 marketplace 安装缓存 E2E。
