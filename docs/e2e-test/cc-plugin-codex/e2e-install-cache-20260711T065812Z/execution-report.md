# cc-plugin-codex 安装缓存与平台发布门 E2E 报告

## Execution Summary

- 选择集：产品化计划切片 6 的 personal marketplace 安装缓存 E2E，以及切片 5 的 Windows 实机证据门。
- 结果：`passed=8`、`failed=0`、`blocked=1`、`skipped=0`。
- 安装缓存：新版本 `0.1.0+codex.20260711065000` 已安装、启用，源码与缓存关键文件哈希逐项相同。
- 缓存路径真实执行：setup、task、review、background/status/result、cancel 全部通过；两个新 ephemeral Codex task 也真实发现并调用安装后的 skills。
- Windows native：当前执行机为 macOS 且没有 Windows runner/VM/tool surface，状态为 `BLOCKED-BY-TOOLING`；三平台 GitHub Actions fixture 仍由 CI 配置覆盖，但不冒充实机 Claude 证据。
- Data policy：preserve traces；未清理缓存、sessions 或 tracked jobs。

## Run Lineage & Emergent Scenarios

- Upstream plan：`../../../plans/2026-07-11-cc-plugin-codex-productization.md`。
- Upstream run：`../e2e-rerun-productization-20260711T064715Z/execution-report.md`。
- Status：安装缓存场景 closed；Windows native 仍被特定工具能力阻塞。

| Emergent scenario | Source trigger | Risk family | Backflow target | Status |
|---|---|---|---|---|
| E2E-15 stale installed cache | installed version 仍为 `...053729`，缺少最新 schema fix | deployment freshness | cachebuster/release | `closed` |

## Environment State Ledger

- Target：personal marketplace `personal`；源码 `/Users/hex1n/cc-plugin-codex`；安装缓存 `/Users/hex1n/.codex/plugins/cache/personal/cc-plugin-codex/0.1.0+codex.20260711065000`。
- Datasource：marketplace manifest、Codex plugin cache、保留 fixture `/private/tmp/cc-plugin-codex-e2e.XcSnh0`、用户态 Claude job state。
- Deployment/freshness evidence：`codex plugin add` 返回新 installedPath；`codex plugin list` 显示 installed/enabled 新版本；manifest、`claude.mjs`、review/Stop prompts、setup skill、hooks 哈希 source/cache 完全一致。
- Runtime：Codex CLI `0.144.1`；Claude Code `2.1.207`；Node `v26.0.0`；macOS host。
- Isolation namespace：fixture `cc-plugin-codex-e2e`；jobs `1913ae90-32db-49a3-a1bf-3c07815833f3`、`25cf8c67-46c3-4957-9423-f6ce17e07be5`。
- Created data：新 cache version、Claude sessions、2 个 tracked jobs。
- Cleanup policy：preserve traces，TTL 7 天；旧 cache 未删除。
- Remaining traces：新旧 plugin cache、job JSON/log、Claude sessions、fixture diff。
- Tool permissions：沙箱外读取/更新本机 Codex plugin cache 与 Claude 登录态；无 Windows runner/VM。

## Run Metadata

- 时间：2026-07-11T06:50Z–2026-07-11T06:58Z。
- Execution Contract Override：无；安装更新属于本地 E2E 环境准备，保留全部证据。
- Build fingerprint：manifest SHA `ee62fb36f59793e09daf71ae97478e887307e2d7e1ba9da3b41a57a70f1685fa`；`claude.mjs` SHA `2989ac5ca683a129e62a4af2caab73115208428e3648dbf725f5950917744e3a`。

## Environment & Capability Map

| Facet | Result |
|---|---|
| Personal marketplace | available，local source symlink |
| Plugin install/update | available，`codex plugin add` |
| Versioned installed cache | available，fresh `...065000` |
| Claude auth | available，`authenticated=true` / `claude.ai` |
| Cache-path CLI execution | available |
| Git fixture | available，预设 `app.js:2` 算术回归 |
| Background process control | available，status/result/cancel |
| Windows native runner/VM | `BLOCKED-BY-TOOLING`，当前无此 capability |
| Three-platform local fixtures | GitHub Actions matrix declared；本机仅运行 macOS suite |

## DAG Schedule

`marketplace discovery → stale-cache fingerprint → cachebuster → npm check → plugin add → hash parity → setup → task → review → background/status/result → cancel/PID/result → plugin list freshness → Windows capability gate`。

模型调用串行执行以避免 Claude session 配额竞争；cancel 使用独立 job；Windows gate 在能力发现后停止，不伪造平台通过。

## Scenario Results

| Scenario | Status | Expected | Actual | Diagnosis | Issue | Evidence / scene |
|---|---|---|---|---|---|---|
| CACHE-01 install/freshness | `passed` | 新版本安装并 enabled | `...065000` installed/enabled | `environment` | — | [证据](#cache-01-installfreshness) |
| CACHE-02 hash parity/setup | `passed` | 缓存与源码一致，auth 可见 | 6 组哈希一致；authenticated | `product` | — | [证据](#cache-02-hash-paritysetup) |
| CACHE-03 cached task | `passed` | 缓存 helper 返回固定 marker | `CC_PLUGIN_CACHE_TASK_OK` | `product` | — | [证据](#cache-03-cached-task) |
| CACHE-04 cached review | `passed` | structured finding 定位回归 | high finding at `app.js:2` | `product` | — | [证据](#cache-04-cached-review) |
| CACHE-05 cached background | `passed` | completed/status/result/session | done、exit 0、marker/session | `product` | — | [证据](#cache-05-cached-background) |
| CACHE-06 cached cancel | `passed` | cancelled、PID gone、result 拒绝 | hard cancellation，符合 | `product` | — | [证据](#cache-06-cached-cancel) |
| CACHE-07 fresh Codex setup skill | `passed` | 新 task 发现安装 skill 并从缓存执行 | setup once，authenticated | `product` | — | [证据](#cache-07-fresh-codex-setup-skill) |
| CACHE-08 fresh Codex lifecycle skills | `passed` | 新 task 调用 task/status/result/cancel | completed marker + cancelled job | `product` | — | [证据](#cache-08-fresh-codex-lifecycle-skills) |
| PLATFORM-01 Windows native | `blocked` | Windows path/taskkill/CRLF/Claude 实机证据 | 当前无 Windows runner/VM | `tooling` | — | [证据](#platform-01-windows-native) |

## Evidence & Failure Scenes

### CACHE-01 install/freshness

- Probe：`codex plugin add cc-plugin-codex@personal --json`；随后 `codex plugin list`。
```json
{"pluginId":"cc-plugin-codex@personal","name":"cc-plugin-codex","marketplaceName":"personal","version":"0.1.0+codex.20260711065000","installedPath":"/Users/hex1n/.codex/plugins/cache/personal/cc-plugin-codex/0.1.0+codex.20260711065000","authPolicy":"ON_INSTALL"}
```
```text
cc-plugin-codex@personal  installed, enabled  0.1.0+codex.20260711065000  /Users/hex1n/plugins/cc-plugin-codex
```
- Created entity：cache version `0.1.0+codex.20260711065000`。
- Re-query：`codex plugin list`；不要用旧 `...053729` 目录作为新鲜证据。

### CACHE-02 hash parity/setup

- Probe：source/cache `shasum -a 256`；从 cache installedPath 执行 setup。
```text
manifest source/cache ee62fb36f59793e09daf71ae97478e887307e2d7e1ba9da3b41a57a70f1685fa
claude.mjs source/cache 2989ac5ca683a129e62a4af2caab73115208428e3648dbf725f5950917744e3a
review.md source/cache 17c5baa852404e04b591f661b19faf9fb10b5fa94f53e9085891e02ed987dee7
stop-review-gate.md source/cache 8ec740c796874d5b36a98f5e307570a3b18210d99a2afc4a7728b6710c9421ce
claude-setup/SKILL.md source/cache 1101dca91facd4461840d890f526b45b7b1e5e8cddca6ed12015ea15b03b4dd3
hooks.json source/cache b13e6e5a880b08f9e4912ee2611e4625fae59c1bceb3d04ef4eb9fffc465ab54
```
```json
{"installed":true,"authenticated":true,"authenticationState":"authenticated","version":"2.1.207 (Claude Code)","authMethod":"claude.ai"}
```
- Re-query：相同 source/cache SHA 命令和 cache-path setup。

### CACHE-03 cached task

- Probe：cache-path `claude-companion.mjs task ... --json`。
```json
{"ok":true,"result":"CC_PLUGIN_CACHE_TASK_OK","structured_output":null,"session_id":"fd9192a1-f3ad-4475-a67d-1ddc637acc3e","resume_hint":"claude --resume fd9192a1-f3ad-4475-a67d-1ddc637acc3e"}
```
- Created entity：Claude session `fd9192a1-f3ad-4475-a67d-1ddc637acc3e`。
- Re-query：从相同 cache installedPath 在 fixture 根执行；不得改回源码路径。

### CACHE-04 cached review

- Probe：cache-path `review --json`。
```json
{"ok":true,"structured_output":{"verdict":"needs-attention","summary":"app.js changes add from addition to subtraction","findings":[{"severity":"high","title":"add function subtracts instead of adds (contract inversion)","file":"app.js","line_start":2,"line_end":2,"confidence":0.98}]},"session_id":"3b914b5e-ff9e-4192-b26e-5fbd5a2b1fd6"}
```
- Re-query：同 cache-path review；fixture HEAD/diff 未清理。

### CACHE-05 cached background

- Probe：cache-path background task → status wait → result。
```json
{"id":"1913ae90-32db-49a3-a1bf-3c07815833f3","status":"completed","phase":"done","exit_code":0,"session_id":"27cf70e1-c6f8-4cfe-8fe2-a9a102dc3298","prompt_name":"task-wrapper","prompt_version":1}
{"ok":true,"result":"CC_PLUGIN_CACHE_BACKGROUND_OK","session_id":"27cf70e1-c6f8-4cfe-8fe2-a9a102dc3298"}
```
- Re-query：cache-path status/result 同 job id。

### CACHE-06 cached cancel

- Probe：cache-path 启动 `sleep 120` job → cancel → `ps -p 28928` → result。
```json
{"id":"25cf8c67-46c3-4957-9423-f6ce17e07be5","status":"cancelled","pid":28928,"session_id":"b1a45c4d-14bf-486e-836d-c3676e7fb6e4","cancellation":"hard_process_tree"}
{"ok":false,"error":"Job 25cf8c67-46c3-4957-9423-f6ce17e07be5 was cancelled"}
```
- `ps -p 28928` 无进程行；result exit 1。
- Re-query：cache-path status/result；不重新启动任务。

### CACHE-07 fresh Codex setup skill

- Probe：全新 ephemeral Codex task，workspace-write sandbox，已验证 hooks 后仅对本次自动化使用 `--dangerously-bypass-hook-trust`；明确要求调用 installed `cc-plugin-codex:claude-setup`。
```text
thread_id=019f4ffa-f0a5-7140-9849-8b5614ab9989
loaded_skill=/Users/hex1n/.codex/plugins/cache/personal/cc-plugin-codex/0.1.0+codex.20260711065000/skills/claude-setup/SKILL.md
helper=/Users/hex1n/.codex/plugins/cache/personal/cc-plugin-codex/0.1.0+codex.20260711065000/scripts/claude-companion.mjs
Claude CLI: 2.1.207 (Claude Code)
Authenticated: yes
Authentication state: authenticated
Review gate: disabled
```
- Expected/actual：新 task 从 installed cache 发现 skill，setup exactly once；符合，无文件编辑。
- Created entity：ephemeral Codex thread `019f4ffa-f0a5-7140-9849-8b5614ab9989`（不持久化 session files）。
- Re-query：用相同 `codex exec --ephemeral` prompt 新建另一 task；不得把本次 thread 当作新鲜证据复用。

### CACHE-08 fresh Codex lifecycle skills

- Probe：全新 ephemeral Codex task，要求只使用 installed `claude-task/status/result/cancel` skills 完成后台成功与取消两条链。
```text
thread_id=019f4ffd-1f0b-7a21-a645-5079cc3d9169
loaded_skills=claude-task,claude-status,claude-result,claude-cancel from cache ...065000
completion_job=23ded5ff-6a90-40a0-b21f-b522d8f5710a status=completed phase=done write=false exit_code=0
completion_result=CODEX_SKILL_BACKGROUND_OK session=c22834f5-4dba-47b0-a9f6-9324f0c0937e
cancellation_job=463ab158-d7a9-473b-aeb2-66e758cddc22 status=cancelled write=false cancellation=hard_process_tree pid=36108
```
- Expected/actual：新 Codex task 自行解析 skill 指令并从 installed cache 调用 helper；成功链与取消链均符合。
- Created entities：ephemeral thread `019f4ffd-1f0b-7a21-a645-5079cc3d9169`；jobs `23ded...`、`463ab...`；Claude sessions `c228...`、`3ccc...`。
- Re-query：新建 ephemeral Codex task，使用同一 installed skill 名；现有 terminal jobs 仅供审计，不作为新鲜触发证据。

### PLATFORM-01 Windows native

- Probe：执行能力发现（host/runner/VM）。
```text
host=macOS
windows-runner=unavailable
windows-vm=unavailable
remote-ci-trigger=unavailable (workspace has no git remote/repository metadata)
```
- Expected：Windows native Node/Claude、path spaces、`.cmd` executable、CRLF、`taskkill /T /F` 证据。
- Actual：缺少 Windows execution capability；产品代码未在 Windows 实机执行。
- Classification：`BLOCKED-BY-TOOLING`，不是 product failure。
- Re-query：在 Windows runner/VM 执行 `npm run check` 和 authenticated cache-path E2E。

## Failures / Defects / Plan Gaps

### E2E-15 stale installed cache

- Disposition：`CLOSED`。
- Classification：`environment defect`。
- Actual：旧 installed cache 为 `0.1.0+codex.20260711053729`，不含 schema dialect fix。
- Resolution：开发 cachebuster 更新为 `0.1.0+codex.20260711065000` 并重新安装；source/cache hash parity 与 cache-path E2E 通过。

### PLATFORM-01 Windows native

- Disposition：`BLOCKED-BY-TOOLING`。
- Missing capability：Windows runner/VM 或可调用的 remote CI execution surface。
- Preconditions：可执行 Windows shell、Node、Git 与 Claude Code；若无真实 Claude 凭据，至少 fixture suite 可先运行，authenticated E2E 仍保持 blocked。

没有 `OPEN` actionable product root cause。

## Data Created & Cleanup

- Created：cache `...065000`、sessions `fd9192...`、`3b914...`、`27cf...`、`b1a45...`、jobs `1913...`、`25cf...`。
- Ownership：personal marketplace / `cc-plugin-codex-e2e` fixture。
- Cleanup：未执行，preserve traces；卸载/删除旧 cache 不属于本轮授权目标。
- TTL：7 天后可按上游 cleanup/quarantine 流程处理 E2E job/fixture；当前 installed cache 保留供新 Codex task 验证。

## Re-run Instructions

```bash
codex plugin add cc-plugin-codex@personal --json
node /Users/hex1n/.codex/plugins/cache/personal/cc-plugin-codex/0.1.0+codex.20260711065000/scripts/claude-companion.mjs setup --json
node /Users/hex1n/.codex/plugins/cache/personal/cc-plugin-codex/0.1.0+codex.20260711065000/scripts/claude-companion.mjs task 'Do not use tools or edit files. Reply exactly CC_PLUGIN_CACHE_TASK_OK' --json
node /Users/hex1n/.codex/plugins/cache/personal/cc-plugin-codex/0.1.0+codex.20260711065000/scripts/claude-companion.mjs review --json
```

从保留 fixture 根执行 Claude-backed probes。任何新代码变更后必须再次提升 cachebuster，并重新证明 source/cache hash parity。

## Next Actions for Agent

无 OPEN product 项。Windows native 保持 `BLOCKED-BY-TOOLING`，只有获得 Windows runner/VM 或 remote CI execution surface 后才能继续。
