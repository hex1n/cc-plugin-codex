# MCP 主路径与 CLI 收缩 E2E 执行报告

## Execution Summary

- 选择集：Core `MCP-E2E-001`～`008`，Extended `009`～`010`；按计划不执行 `011`、`012`。
- 结果：`passed=10`、`failed=0`、`blocked=0`、`skipped=2`。
- installed-host：5 个 fresh Codex app-server sessions、16 次操作、12 tools、9 Skills、0 legacy CLI surface、0 automatic fallback。
- 全量回归：99/99 passed；aggregate criterion 输出 `TASKLOOP_CRITERION: mcp-cli-contraction-complete`。
- 模型边界：所有 Claude 执行均为临时安装内显式注入的 fake runtime，`total_cost_usd=0`；未执行真实 Claude/Fable 或自然语言 Skill 路由。
- 缺陷：无 `OPEN` actionable root cause；未创建 `issues/`。
- 清理：未执行，按计划 preserve traces 7 天。

## Run Lineage & Emergent Scenarios

- Upstream plan：[`../2026-07-18-mcp-primary-transport-e2e-test-plan.md`](../2026-07-18-mcp-primary-transport-e2e-test-plan.md)，`e2e-plan/v1`。
- Upstream run：none。
- Downstream：none。
- Status：closed。
- Emergent scenarios：none；执行结果没有产生计划外 P0/P1 风险。

## Environment State Ledger

- Target：local macOS；source `/Users/hex1n/cc-plugin-codex`；Codex app-server + installed `cc-plugin-codex@personal`。
- Datasource：两个临时 verifier 根内的 Git workspace、plugin cache、job JSON/events/log、write/config roots；用户 cache 仅做只读 parity。
- Deployment/freshness evidence：source commit `a1e95b07b4d9bcf0df989af384b68212c77ae47c`；plugin version `0.1.0+codex.20260718001845`；host verifier 对 source/temp install/user cache 做逐文件相等检查；aggregate criterion fresh pass。
- Isolation namespace：`cc-plugin-host-verifier-IEE2wX`（第一轮）与 `cc-plugin-host-verifier-dcK4sh`（aggregate 内第二轮）；其他 fixtures 使用各测试声明的 `claude-admin-*`、`jobs-list-*` 等 prefix。
- Created data：两个临时 `CODEX_HOME`、两个 Git workspaces、8 个持久 job records、临时 admin/jobs/MCP/recovery fixtures、E2E 计划与本报告。
- Cleanup policy：preserve traces，TTL 7 天；只有用户明确要求时才执行计划中的 destructive cleanup 命令。
- Remaining traces：两个 verifier 根及测试 runner 的临时 fixture；本机 plugin cache 保持已安装状态；计划/报告永久保留。
- Tool permissions：Node/Git/Codex 可执行；personal marketplace 可读；临时目录可写；用户 plugin cache 可读；无真实模型凭据调用、无网络生产操作。

## Run Metadata

- Environment：local/test。
- Started：`2026-07-18T00:16:24Z`（第一轮 verifier root birth time）。
- Finished：`2026-07-18T00:19:14Z`（报告取证完成前）。
- Node：`/opt/homebrew/bin/node`, `v26.0.0`。
- Codex：`/opt/homebrew/bin/codex`, `codex-cli 0.144.5`。
- Git：`/usr/bin/git`, `2.50.1 (Apple Git-155)`。
- Plugin cache：`/Users/hex1n/.codex/plugins/cache/personal/cc-plugin-codex/0.1.0+codex.20260718001845`。
- Data policy：preserve traces。
- Execution Contract Override：none；用户要求 planner-first 已在任何 E2E trigger 前落实为上游计划。

## Environment & Capability Map

| Facet | Result | Evidence |
|---|---|---|
| Node/Git/Codex toolchain | available | 具体路径/版本见 Run Metadata |
| Trigger channel | available | `codex app-server --stdio` + `mcpServer/tool/call` |
| Personal marketplace | available | root `/Users/hex1n` |
| Temporary plugin install | available | 两轮 verifier 成功安装并启动 |
| User cache parity | available | version `...001845` 可读且逐文件相等 |
| Fake Claude | available | 只写临时 `.mcp.json` 与 sandbox compatibility manifest |
| Admin recovery surface | available | 8/8 fixtures passed |
| Job/RFC3339 probes | available | 2/2 fixtures passed |
| Real Claude/Fable | not used | `OUT-OF-SCOPE` |
| Natural-language Skill routing | not triggered | `CONDITIONAL`，需模型用量授权 |
| Windows runner/VM | unavailable | `OUT-OF-SCOPE` |

## DAG Schedule

- 并行根：`N6` admin、`N7` jobs、`N9` model/effort contract、`N10` recovery。
- host 链：adapter 内串行执行 `N1 → N2 → N3 → N4 → N5`，写与 cancel 节点隔离。
- aggregate：所有上述节点通过后独占执行 `N8`；内部创建第二个 fresh verifier root，不复用第一轮 job IDs。
- `N11`、`N12` 按计划 skipped；没有触发外部模型或不存在的平台。

## Scenario Results

| Scenario | Status | Expected | Actual | Diagnosis | Issue | Evidence / scene |
|---|---|---|---|---|---|---|
| MCP-E2E-001 | `passed` | source/temp/user parity；12 tools、9 Skills、无旧 CLI | 全部满足 | `product` | — | [host evidence](#host-evidence-001-005) |
| MCP-E2E-002 | `passed` | code/plan/adversarial/task dedicated routing | 四类 evidence 均返回 | `product` | — | [host evidence](#host-evidence-001-005) |
| MCP-E2E-003 | `passed` | background→completed→result | job completed，`host-ok` | `product` | — | [job evidence](#job-state-evidence-003-005) |
| MCP-E2E-004 | `passed` | explicit ID running→cancelled | 两轮 cancel jobs 均 cancelled | `product` | — | [job evidence](#job-state-evidence-003-005) |
| MCP-E2E-005 | `passed` | isolated write 明确 discard/apply | 两轮各一 discarded、一 applied | `product` | — | [job evidence](#job-state-evidence-003-005) |
| MCP-E2E-006 | `passed` | MCP-down admin 可恢复且拒绝 normal commands | 8/8 passed | `product` | — | [admin evidence](#admin-evidence-006) |
| MCP-E2E-007 | `passed` | bounded、安全投影、invalid→`-32602` | 2/2 passed | `product` | — | [jobs evidence](#jobs-evidence-007) |
| MCP-E2E-008 | `passed` | 99 tests + aggregate complete | 99/99；criterion complete | `product` | — | [aggregate evidence](#aggregate-evidence-008) |
| MCP-E2E-009 | `passed` | Fable/model/effort argv 与 metadata contract | 20/20 targeted tests passed | `product` | — | [contract evidence](#contract-evidence-009) |
| MCP-E2E-010 | `passed` | corrupt 隔离、`partial_apply` fail closed | 5/5 recovery + admin partial fixture passed | `product` | — | [recovery evidence](#recovery-evidence-010) |
| MCP-E2E-011 | `skipped` | natural-language intent 捕获真实 Skill/tool | 按 `CONDITIONAL` 不消耗 Codex agent model | `plan` | — | [deferred evidence](#deferred-evidence-011-012) |
| MCP-E2E-012 | `skipped` | Windows native Core 子集 | macOS run，按 `OUT-OF-SCOPE` 不执行 | `tooling` | — | [deferred evidence](#deferred-evidence-011-012) |

## Evidence & Failure Scenes

### Host evidence 001-005

- Probe：`node test/verify-installed-host-routing.mjs`
- Expected：fresh install/parity、5 sessions、16 operations、12 tools、9 Skills、0 legacy/fallback。
- Actual raw：

```json
{"criterion":"installed-host-routing-complete","fresh_sessions":5,"operations":16,"tools":12,"skills":9,"legacy_cli_surface":false,"automatic_fallbacks":0,"evidence":["code-review","plan-review","adversarial-review","readonly-task","background-start","background-status","background-result","cancel-start","cancel-status","cancel","write-discard-start","write-discard-status","write-discard","write-apply-start","write-apply-status","write-apply"]}
```

- Created entity identifiers：root `cc-plugin-host-verifier-IEE2wX`; jobs `02aa452c-30b2-41a9-9973-e412e7c0ba11`, `0409576b-f13f-4995-9b0f-45338edf8bd7`, `c3f1a88e-2ba3-4afc-98ce-c7a71e7a739f`, `cefa6a1d-7b79-449c-8a1f-3cf9e502a4c8`。
- Re-query：`node test/verify-installed-host-routing.mjs`（fresh）；现存 state 可用下节 `jq` 命令审计。
- Retained scene：完整 root 保留；cleanup 未执行，安全。

### Job state evidence 003-005

- Probe：只投影两轮 verifier 的非敏感 job fields。
- Expected：success job=`done`；cancel job=`cancelled`；write jobs=`discarded|applied`；cost=0。
- Actual raw（第一轮）：

```json
[
  {"id":"02aa452c-30b2-41a9-9973-e412e7c0ba11","status":"completed","phase":"discarded","operation":"task","write":true,"artifactStatus":"discarded","requestedModel":"sonnet","effectiveModels":["fixture-model"],"totalCostUsd":0},
  {"id":"0409576b-f13f-4995-9b0f-45338edf8bd7","status":"cancelled","phase":"cancelled","operation":"task","write":false,"artifactStatus":null,"requestedModel":"sonnet","effectiveModels":null,"totalCostUsd":null},
  {"id":"c3f1a88e-2ba3-4afc-98ce-c7a71e7a739f","status":"completed","phase":"applied","operation":"task","write":true,"artifactStatus":"applied","requestedModel":"sonnet","effectiveModels":["fixture-model"],"totalCostUsd":0},
  {"id":"cefa6a1d-7b79-449c-8a1f-3cf9e502a4c8","status":"completed","phase":"done","operation":"task","write":false,"artifactStatus":null,"requestedModel":"sonnet","effectiveModels":["fixture-model"],"totalCostUsd":0}
]
```

- Aggregate fresh-run identifiers：root `cc-plugin-host-verifier-dcK4sh`; jobs `24c2f680-8533-46ad-919a-21c97f65ad91` (discarded), `97c6d3fb-6162-4a70-929b-1f075a640b61` (applied), `a7f7f9e0-e8e5-4420-ae03-4129d2f2ab70` (done), `fb86c076-8a09-4559-9950-f93a5249a682` (cancelled)。
- Re-query：

```bash
jq -s 'map({id,status,phase,operation,write,artifactStatus,requestedModel,effectiveModels,totalCostUsd})' /var/folders/8x/2zb93d5x3qx2fml_5zbv2hnr0000gn/T/cc-plugin-host-verifier-IEE2wX/state/ce237b65b2bf61cd/*.json
```

- Retained scene：JSON/events/log/isolated roots 均保留；未读取或写入真实用户 jobs。

### Admin evidence 006

- Probe：`node --test test/admin-cli.test.mjs`
- Expected：normal commands 拒绝；doctor/probe/gate 在 missing/broken MCP 下可用；recovery 显式且 `partial_apply` fail closed。
- Actual raw：

```text
✔ admin CLI rejects normal product commands
✔ admin doctor remains useful when the MCP manifest is unavailable
✔ admin review-gate controls remain available without MCP
✔ admin MCP probe performs only initialize and tool discovery
✔ admin MCP probe reports a broken server without affecting offline gate controls
✔ admin jobs list and reconcile use explicit workspace state
✔ admin recovery commands reject list-only filters
✔ admin artifact inspection refuses to discard partial apply recovery state
tests 8; pass 8; fail 0; skipped 0
```

- Created entity identifiers：fixture jobs `stale-start`, `partial`; config/state roots use `claude-admin-*` prefixes。
- Re-query：`node --test test/admin-cli.test.mjs`。
- Retained scene：test temp roots，preserve 7d。

### Jobs evidence 007

- Probe：`node --test test/jobs-list.test.mjs`
- Expected：stable cursor、安全投影、严格 RFC3339/闰秒、invalid args `-32602`。
- Actual raw：

```text
✔ MCP job listing is workspace-scoped, bounded, and cursor-stable
✔ MCP job listing rejects malformed cursor and non-RFC-3339 timestamps as invalid arguments
tests 2; pass 2; fail 0; skipped 0
```

- Created entity identifiers：`older-user`, `newest-user`, `hidden-e2e`。
- Re-query：`node --test test/jobs-list.test.mjs`。
- Retained scene：`jobs-list-*` temp roots，preserve 7d。

### Aggregate evidence 008

- Probe 1：`node test/verify-mcp-cli-contraction.mjs`。
- Raw：

```text
TASKLOOP_CRITERION: mcp-cli-contraction-complete
```

- Probe 2：`npm run check`。
- Raw full TAP：[attachments/npm-run-check.txt](attachments/npm-run-check.txt)。Summary：

```text
tests 99
pass 99
fail 0
cancelled 0
skipped 0
todo 0
```

- Probe 3：`git diff --check`; raw output empty, exit 0。
- Created entity identifiers：aggregate verifier root/jobs 见 Job state evidence。
- Re-query：`node test/verify-mcp-cli-contraction.mjs`；`npm run check`；`git diff --check`。
- Retained scene：aggregate root `cc-plugin-host-verifier-dcK4sh`。

### Contract evidence 009

- Probe：`node --test test/mcp-server.test.mjs test/stdin-transport.test.mjs test/config-precedence.test.mjs`。
- Expected：`model=fable` / `claude-fable-5`、`effort=high` 进入 invocation 与 requested metadata，effective model 独立报告；stdin 不进入 argv。
- Actual raw：

```text
✔ config precedence is project over user over environment over defaults
✔ task profile overrides merge without losing inherited envelope fields
✔ invalid configuration fails before Claude starts
✔ review profiles cannot exceed absolute safety ceilings
✔ review gate environment override is explicit and validated
✔ typed MCP lists tools and runs a read-only task through the shared service
✔ typed read-only tasks preserve explicit resume semantics
✔ typed doctor reports setup without invoking a model or mutating state
✔ typed plan review uses the review capability and reports immutable subject metadata
✔ typed adversarial review is a dedicated read-only MCP capability
✔ background plan review persists subject metadata without plan content
✔ background failures preserve plan subject and usage metadata through MCP
✔ MCP write rejects an unverified executable before workspace creation
✔ verified temporary plugin copy completes public MCP write discard and apply
✔ MCP rejects unknown fields before invoking Claude
✔ MCP rejects oversized adversarial focus before invoking Claude
✔ plugin manifest exposes the local MCP server
✔ admin and MCP adapters keep transport-neutral service boundaries
✔ foreground Claude receives the rendered prompt only through stdin
✔ background stream-json Claude receives the rendered prompt only through stdin
tests 20; pass 20; fail 0; skipped 0
```

- Created entity identifiers：fixture session `mcp-session`; requested models asserted by test are `fable` and `claude-fable-5`；effective fixture model `claude-sonnet-test`。
- Re-query：同 probe command。
- Retained scene：test temp roots；没有真实模型调用。

### Recovery evidence 010

- Probe：`node --test test/lifecycle.test.mjs test/write-apply.test.mjs`，并消费 admin evidence 中的 partial fixture。
- Expected：corrupt records 隔离；partial apply 保留 recovery state 且拒绝 discard。
- Actual raw：

```text
✔ SessionEnd prunes expired terminal artifacts but preserves active and corrupt records
✔ workspace status isolates a corrupt job record instead of failing
✔ global status discovers other workspaces and hides E2E jobs by default
✔ reconciliation does not mislabel a worker after cancellation is requested
✔ write artifacts apply explicitly, block overlap, confirm context drift, and discard
tests 5; pass 5; fail 0; skipped 0
```

- Created entity identifiers：`broken`, `recovery`, `partial`。
- Re-query：`node --test test/lifecycle.test.mjs test/write-apply.test.mjs test/admin-cli.test.mjs`。
- Retained scene：dedicated fixture roots，preserve 7d。

### Deferred evidence 011-012

- MCP-E2E-011：未运行。最低证据要求是 fresh Codex agent turn 的 tool trace，现有 verifier 的 `skills/list` 只证明 discovery；本轮没有获得模型用量授权。
- MCP-E2E-012：未运行。当前 host 为 macOS，没有 Windows runner/VM；该场景在计划中为 out-of-scope。
- Cleanup safety：没有为这两个场景创建任何数据。

## Failures / Defects / Plan Gaps

| Item | Disposition | Evidence | Impact |
|---|---|---|---|
| GAP-01 natural-language Skill routing | `CONDITIONAL` | 只完成 Skill discovery 与 direct MCP host calls | 不影响 typed MCP integration verdict；不能声称 agent router 已验证 |
| GAP-02 installed-host Fable argv capture | `CONDITIONAL` | contract-level 009 passed；host adapter 未导出 argv | Fable/effort contract 已验证，installed-host parity 仍可强化 |
| GAP-03 real Claude/Fable cost/model routing | `OUT-OF-SCOPE` | fake jobs cost=0 | 不外推真实上游模型选择或费用 |
| GAP-04 Windows native | `OUT-OF-SCOPE` | macOS environment | 不外推 Windows process/path behavior |
| GAP-05 performance/concurrency | `CONDITIONAL` | 无 source-backed threshold / host concurrency adapter | 不给出性能或并发 E2E verdict |
| GAP-06 retained temp traces | `ACCEPTED` | owner prefixes + TTL 7d | 占用少量本机临时存储 |

没有 `OPEN` item，也没有 product/environment/tooling defect。

## Data Created & Cleanup

- Host root 1：`/var/folders/8x/2zb93d5x3qx2fml_5zbv2hnr0000gn/T/cc-plugin-host-verifier-IEE2wX`。
- Host root 2：`/var/folders/8x/2zb93d5x3qx2fml_5zbv2hnr0000gn/T/cc-plugin-host-verifier-dcK4sh`。
- 两个 root 各含临时 `CODEX_HOME`、workspace、state、writes、config、fake executable；共 8 个持久 job records。
- 其余 Node test fixtures 使用自有 temp prefixes，固定 entity IDs 记录在各 evidence block。
- Cleanup 未执行；TTL 7 天。若用户明确授权：

```bash
find "${TMPDIR%/}" -maxdepth 1 -type d -name 'cc-plugin-host-verifier-*' -mtime +7 -exec rm -rf -- {} +
```

## Re-run Instructions

Core fresh rerun：

```bash
node test/verify-installed-host-routing.mjs
node --test test/admin-cli.test.mjs test/jobs-list.test.mjs
node test/verify-mcp-cli-contraction.mjs
```

Extended rerun：

```bash
node --test test/mcp-server.test.mjs test/stdin-transport.test.mjs test/config-precedence.test.mjs
node --test test/lifecycle.test.mjs test/write-apply.test.mjs
```

全量与格式：

```bash
npm run check
git diff --check
```

## Next Actions for Agent

none。当前没有 `OPEN` actionable root cause。若用户另行授权真实 Codex agent 用量，则新建增量 run 执行 `MCP-E2E-011`；不要修改本报告的既有 verdict。
