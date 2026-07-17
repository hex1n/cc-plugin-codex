# MCP 主路径与 CLI 收缩实施计划

**模式**: Plan
**深度**: Deep
**状态**: implemented-and-verified
**日期**: 2026-07-17
**决策来源**: 用户已授权继续按“正常路径去 CLI、保留独立故障管理面”落地
**设计基础**: [2026-07-14-typed-mcp-stdin-sandbox-design.md](../decisions/2026-07-14-typed-mcp-stdin-sandbox-design.md)
**运行时基础**: [2026-07-14-typed-mcp-stdin-sandbox-implementation.md](./2026-07-14-typed-mcp-stdin-sandbox-implementation.md)
**审查输入**: Fable 5 方案审查、本机 Codex MCP prompts/resources 最小验证、现有 MCP/CLI/Skill/job lifecycle 实现与测试

## TL;DR

最终形态不是“完全没有任何命令行入口”，而是严格分离两个平面：

- **正常产品面**：Codex Skill 只调用 typed MCP tools；review、plan review、adversarial review、task、isolated write、job 查询和显式 apply/discard 都不再回退到 companion CLI。
- **故障管理面**：保留一个很小、不能启动正常 review/task 的 admin CLI，用于 MCP 不可用时执行 doctor、协议 probe、review gate 控制、job 检查/对账/取消和 artifact 检查/安全丢弃。

共享 application service 是唯一业务实现。MCP 与 admin CLI 只是两种权限不同的 adapter，禁止 MCP 反向 spawn CLI，也禁止 admin CLI 重新长成第二套正常产品 API。

MCP prompts 不进入本轮关键路径。本机验证表明当前 Codex 产品面会发现 tools 和 resources，但没有暴露或消费 prompts；协议库识别 prompts 不等于当前 Codex 可以把它作为用户工作流入口。Skills 继续承担发现、路由、轮询和结果解释。MCP resources 也不为了“协议完整”而新增，只有出现明确消费者后再设计。

预计总投入 **32–48 工时**。首轮全部使用 fake Claude、本地 fixture 和临时 `CODEX_HOME`；任何真实 Claude/Fable 复测继续需要显式授权。

## 实施结果（2026-07-17）

- MCP inventory 已从 9 个扩展为 12 个，新增 adversarial review、bounded jobs list 和 doctor；readonly task 也补齐显式 resume/continue parity。
- MCP 不再使用 `../scripts/lib/...` 跨层相对导入；`package.json#imports` 提供 `#app/*` 内部 contract，server 只依赖该 application seam。
- 9 个 Skills 已全部去除 normal CLI fallback；transfer 本地生成 seed，轮询由 Skill/客户端持有，所有 mutation 使用显式 ID。
- 受限 `claude-companion-admin` 已实现 doctor/probe、gate、job recovery 与安全 artifact 操作，不能启动正常业务或 apply。
- 原拟议的 CLI compatibility window 与 migration metrics 最终取消：旧 normal CLI 已直接移除，迁移证据由临时安装、fresh host 路由和 legacy surface/call 零值门禁提供，因此没有保留不可达的计数模块或测试。
- 迁移门禁在临时安装中以 5 个 fresh Codex app-server 进程完成 16 次 host-routed 操作，覆盖 code/plan/adversarial review、readonly task、background status/result/cancel、isolated write apply/discard；fake runtime 下 legacy CLI 调用为 0。
- 故障演练覆盖 MCP server 启动失败、corrupt job record 与 `partial_apply`；管理 mutation 均保持 fail closed。
- 旧 `scripts/claude-companion.mjs`、normal bin 与 normal-only argv parser 已删除。保留的 `scripts/lib/render.mjs` 是 MCP 结构化投影，不是 CLI 业务入口。
- 临时 host probe 首轮证明 Codex 启动插件 MCP 时不会继承调用者临时设置的 `CLAUDE_CODE_EXECUTABLE`；该次本机 Claude 调用失败且报告成本为 0。后续 fixture 通过只修改临时安装副本 `.mcp.json` 显式注入 fake runtime，5-session 验证未触发真实模型。

最终证据以本文件末尾的验证记录、全量测试、second-model review、本机缓存同步和 commit SHA 为准。

## 根问题与当前最佳路径

根问题不是 CLI 文件数量，而是正常能力存在两个公共入口：Skill 可以先走 MCP，再自动退回功能完整的 CLI。只要两条路径都能启动 review/task、选择模型、处理 job 和 apply artifact，就必须长期维护两套路由、参数矩阵、错误语义和测试，且无法证明用户实际走的是 typed MCP。

当前最佳路径：

```text
Codex user intent
      │
      ▼
Skills: discovery / routing / polling / presentation
      │ typed call, explicit job_id
      ▼
MCP tools ────────────────┐
                          ▼
                 application services
                          │
                          ├─ Claude execution
                          ├─ job/state lifecycle
                          └─ isolated artifact lifecycle

MCP unavailable
      │ explicit human break-glass action
      ▼
admin CLI ────────────────┘
  doctor / probe / gate / inspect / reconcile / cancel / safe discard
  never review / task / apply / implicit latest
```

## 决策信封

```yaml
decision: BUILD
target_outcome: MCP tools 与 Skills 成为唯一正常产品路径；companion CLI 收缩为不能执行正常业务的独立故障管理面
baseline_and_frequency: 9 个 Skill 中核心能力仍声明 MCP 不可用时自动 CLI fallback；adversarial review、setup、transfer 仍是 CLI-only；status 的 list/global/filter/session/latest/wait 语义仍主要位于 CLI
expected_benefit: 正常操作只有一个 typed contract；消除自动 fallback 和隐式 latest；减少重复参数、路由和测试矩阵；MCP 故障时仍可解除 review gate、取消作业和检查安全状态
delivery_and_maintenance_cost: 预计 32–48 工时；持续维护一个业务 service、一个 MCP adapter 和一个受限 admin adapter
status_quo_or_existing_mechanism: 保留完整 compatibility CLI，迁移风险较低但重复公共面永久存在，且无法可靠度量 MCP 是否真正接管
decision_flip_condition: 若非 Codex/CI 调用方需要成为一等用户，则保留完整 CLI；若 Codex 后续稳定暴露 MCP prompt list/get/selection，再把 prompts 作为可选 UX 增强而不是权限或迁移依赖
review_scope: implementation-authorization
review_budget: 默认仅 fake runtime、本地 fixture 与临时安装；真实 Claude/Fable 或付费路由验证需单独授权
```

若实现超过 56 工时、必须新增常驻 daemon/REST 服务、或 admin CLI 无法在 MCP 故障时独立运行，回到价值门禁重新设计。

## 已验证事实、假设与边界

### 已验证事实

1. 当前 `mcp/server.mjs` 暴露 9 个 typed tools，并直接调用 `scripts/lib/service.mjs`，没有通过 CLI 间接执行。
2. 已有 MCP 能力覆盖 code review、plan review、read-only task、isolated write start/apply/discard，以及显式 `job_id` 的 status/result/cancel。
3. adversarial review、setup/review-gate、transfer 和高级 job 列表语义仍位于 `scripts/claude-companion.mjs`。
4. hooks 直接 import `scripts/lib/config.mjs`、job lifecycle 等共享模块，不依赖 companion CLI；因此删除正常 CLI 不会切断 review gate hook。
5. `setReviewGateEnabled`、`inspectClaudeSetup`、`reconcileJob`、`reconcileWorkspaceJobs`、`pruneWorkspaceJobs`、`listJobs` 和 `listGlobalJobs` 已存在，可复用为 service。
6. `partial_apply` / `recoveryRequired` 表示 artifact 需要人工检查，不能被通用“recover”命令自动修复或盲目 discard。
7. 本机 `codex-cli 0.144.1`：`codex exec` 启动只请求 tools；Codex app-server 还请求 resources 与 resource templates，并暴露 resource read/tool call API，但没有 prompt list/get 产品面。
8. 最近一次相关回归为 31/31 通过：MCP server、config precedence、lifecycle、session start 和 commands 测试均通过。

### 待验证假设

| 假设 | 风险 | 实施处理 |
|---|---|---|
| installed Skill 能稳定获得全部新增 MCP tools | 高 | 删除 fallback 前先做临时安装与 fresh-session smoke |
| job global/filter 查询可用显式分页 contract 替代 CLI 的隐式 session/latest | 中 | 先冻结字段、排序、cursor 与投影测试；不保留无法观测的隐式语义 |
| admin CLI 在 MCP server 无法启动时仍可读取共享状态和配置 | 高 | 以“损坏 `.mcp.json` / server 启动失败”fixture 做独立验证 |
| 本地 usage counter 足以判断旧 CLI 是否仍被调用 | 中 | 只计旧 normal command 类别并结合 Skill 静态扫描、安装缓存扫描和操作覆盖矩阵 |
| adversarial review 能安全下沉到共享 service | 中 | 独立 tool 和 service；不把 mode bool 塞进普通 review schema |

## 最佳性检查

- **Fit criteria**：唯一正常入口、typed schema、显式 job identity、MCP-down 可恢复、最少重复业务逻辑、可观察迁移、可分阶段回滚。
- **Winner**：MCP + Skills 正常面，配一个不能启动正常任务的最小 admin CLI。
- **Closest alternative**：MCP-only，删除全部 CLI。
- **为何胜出**：MCP-only 在 server 无法启动、manifest 损坏或 review gate 阻塞时没有独立控制通道；完整 compatibility CLI 又保留了全部重复面。
- **Defeat condition**：若 Codex host 提供独立于 plugin MCP server 的 doctor、gate mutation、job cancellation 和 artifact inspection，admin CLI 可以完全删除；若非 Codex 自动化调用是正式需求，完整 CLI 应保留并被当作一等 API 维护。
- **Marginal-gain stop**：本轮不增加 daemon、REST、自动 job recovery、自动 partial-apply 修复、隐式 latest、服务端长轮询、MCP prompt 编排或“为了支持协议”而新增 resources。

## 实施不变量

1. `scripts/lib/service.mjs` 及其细分 service 是业务规则的唯一实现；adapter 不复制 Git、Claude、job 或 artifact 逻辑。
2. 正常 Skill 不执行 `node .../claude-companion.mjs`，也不在 MCP 失败时自动切换传输。
3. 所有 job 操作使用显式 `job_id`；删除隐式“最近 active/finished job”语义。
4. wait/poll 属于 Skill/客户端循环：有界调用 `claude_job_status`，不在 MCP server 内持有长连接或 sleep loop。
5. `claude_adversarial_review` 是独立 typed tool；不复用 task，也不以含糊的 `mode` 扩张普通 code review。
6. MCP prompts 只可能是建议性 UX，永远不是只读、写授权、sandbox 或 apply 权限的安全边界。
7. admin CLI 不允许启动 review、plan review、adversarial review、task 或 apply artifact。
8. admin 的每个 mutation 都要求显式子命令和显式目标 ID；无交互式猜测、隐式 latest 或自动批量修改。
9. `partial_apply` 只允许 inspect 和人工 runbook；不能由 reconcile、recover 或 discard 自动消除。
10. 本地迁移计数不上传数据，不记录 prompt、patch、路径、job ID、模型输出或凭证；只记录命令类别、结果类别、时间和插件版本。
11. MCP job 列表返回有上限的安全投影，不返回 prompt、patch、日志正文或敏感 disclosure 内容。
12. requested/effective models、effort、tokens、cost、turns 和 duration 的现有报告语义不变。

## 能力归属矩阵

| 现有能力/语义 | 最终归属 | 决策 |
|---|---|---|
| code review | `claude_review_changes` | 保持 MCP |
| plan review | `claude_review_plan` | 保持 MCP |
| adversarial review | `claude_adversarial_review` | 从 CLI 抽到独立 service + MCP |
| read-only task | `claude_task_readonly` | 保持 MCP |
| isolated write start | `claude_write_task_start` | 保持 MCP |
| apply/discard | MCP 显式 tools | 正常路径保持；admin 只提供安全 discard，不提供 apply |
| status/result/cancel by ID | MCP 显式 tools | 保持 MCP |
| workspace/global/filter job list | `claude_jobs_list` | 新增有界、分页、显式 filters 的 MCP tool |
| status `--wait` | Skill 有界轮询 `claude_job_status` | 不建设 server-side wait |
| session-scoped implicit list/latest | 删除 | 当前 MCP 无可靠 host session identity；以 workspace list + 显式 ID 替代 |
| result/cancel implicit latest | 删除 | 防止对错误 job 执行操作 |
| setup/doctor | 共享 doctor service；MCP `claude_doctor` + admin `doctor` | MCP 正常诊断，admin 负责 MCP-down 诊断 |
| review-gate status/enable/disable | admin CLI | 必须在 MCP 不可用时仍能解除阻塞；mutation 不暴露为普通 MCP 工作流 |
| job reconcile/cancel | admin CLI | 仅故障管理；复用 lifecycle/service |
| artifact inspect/safe discard | admin CLI | 只读检查和明确清理；`partial_apply` fail closed |
| transfer/handoff | 本地 Skill/template | 不需要 Claude 执行或共享 job；不新增 MCP execution tool |
| MCP prompts | 延后 | 当前 Codex 产品面未暴露；不能作为 CLI 删除门禁 |
| MCP resources | 暂不新增 | 已验证客户端支持，但目前没有能证明价值的消费者 |

## 新公共 Contract

### `claude_adversarial_review`

- 输入与 `claude_review_changes` 对齐：`workspace_root`、`base`、`review_profile`、model/effort/turn/budget/timeout/background。
- 额外接受有长度上限的 `focus`。
- 固定使用 adversarial prompt 和 review output schema；只读权限不由 prompt 保证，而由 execution/service profile 保证。
- 保留 operation、review kind、subject fingerprint、usage 和 effective models。

### `claude_jobs_list`

建议输入：

```text
workspace_root   required absolute path
scope            workspace | global, default workspace
status           optional exact state
purpose          optional exact purpose
include_test     default false
updated_after    optional RFC 3339 timestamp
cursor           optional opaque cursor
limit            integer 1..100, default 20
```

返回：`jobs[]`、`next_cursor`、`has_more`。排序固定为 `updatedAt/createdAt desc + id desc`，cursor 绑定排序键与 filter fingerprint；filters 改变时旧 cursor 失效。每个 job 只返回 status 展示需要的投影。`scope=global` 必须由用户明确请求，Skill 默认只查 workspace。

### `claude_doctor`

- 只读返回 Claude CLI installed/version/auth ambiguity、plugin manifest/MCP server 可读性、review gate 状态、state root 可读写性和 sandbox compatibility 摘要。
- 不安装、不登录、不修改 gate、不发送模型请求。
- MCP server 无法启动时，由同一 doctor service 的 admin adapter 提供替代入口。

### Admin CLI

新入口建议为 `claude-companion-admin`，实现文件 `scripts/claude-admin.mjs`：

```text
claude-companion-admin doctor
claude-companion-admin mcp probe
claude-companion-admin review-gate status|enable|disable
claude-companion-admin jobs list [--workspace <path>|--global] [filters]
claude-companion-admin jobs reconcile [--workspace <path>]
claude-companion-admin jobs cancel <job-id> --workspace <path>
claude-companion-admin artifact inspect <job-id> --workspace <path>
claude-companion-admin artifact discard <job-id> --workspace <path>
```

约束：

- `mcp probe` 只执行 initialize、tools/list 和 schema sanity check，不调用真实工具或模型。
- `jobs reconcile` 只做现有 lifecycle 能证明安全的状态对账，不修改 patch 内容。
- `artifact discard` 遇到 `partial_apply` / `recoveryRequired` 必须拒绝并输出人工 runbook。
- 所有 mutation 默认人类可读地显示目标和结果；`--json` 仍可用于可验证 smoke，但不新增任意 argv passthrough。

## 验收 Oracle

全部条件满足才允许删除旧 normal CLI：

1. **能力闭合**：矩阵中每个旧 CLI 语义都有明确的迁移、删除或 admin 归属；没有“稍后再说”的未分配项。
2. **静态零 fallback**：所有 `skills/*/SKILL.md` 对正常 flow 不再引用 `claude-companion.mjs` 或 `claude-companion`；测试对 source 和安装缓存同时扫描。
3. **显式身份**：status/result/cancel/apply/discard 全部要求 job ID；测试证明不存在 implicit latest。
4. **MCP parity**：tools/list 包含新增 adversarial、jobs list 和 doctor；schemas 拒绝未知字段、越界 limit、非法 cursor/filter。
5. **故障独立性**：在 MCP manifest 损坏、server 语法错误或启动超时 fixture 下，admin doctor、review-gate、jobs list/reconcile/cancel 和 artifact inspect/safe discard 仍可运行。
6. **迁移观测门槛**：至少 10 次正常操作，覆盖 code review、plan review、adversarial review、readonly task、background status/result/cancel、isolated write apply/discard；跨至少 5 个 fresh Codex sessions；旧 normal CLI 计数为 0、自动 fallback 为 0。
7. **失败演练门槛**：完成 3 类演练——MCP 不可启动、损坏 job record、`partial_apply` artifact；每类都有确定性结果，无错误 mutation，无未记录的恢复步骤。
8. **安装一致性**：临时 `CODEX_HOME` 与本机安装缓存的 Skill、MCP server、manifest 和 admin entry 与源码一致；fresh session 实际列出新增 tools。
9. **回归**：`npm run check`、`git diff --check`、目标平台 CI 全绿；真实模型不属于默认验收。

## 范围与成本

| Phase | Scope | Effort | Risk | 主要价值 |
|---|---|---:|---|---|
| 0 | 冻结能力矩阵、schemas 与迁移 contract | 3–4h | 中 | 先决定哪些语义迁移、删除或留在 admin |
| 1 | 共享 service 深化与安全 job 投影 | 5–7h | 高 | 防止 MCP/admin 复制业务逻辑 |
| 2 | MCP adversarial/jobs list/doctor parity | 7–10h | 高 | 关闭正常 Skill 的功能缺口 |
| 3 | 最小 admin CLI 与故障管理测试 | 6–9h | 高 | 保留 MCP-down 可恢复性而不保留第二产品面 |
| 4 | Skills 切流、transfer 本地化、去自动 fallback | 3–5h | 中 | 正常调用真正统一到 typed MCP |
| 5 | 本地迁移观测、失败演练与删除门禁 | 4–6h | 中 | 用证据决定何时删除兼容层 |
| 6 | 删除旧 normal CLI、文档/发布/缓存同步 | 4–7h | 中 | 移除重复公共 API 和维护矩阵 |
| **Total** | **Core + Supporting** | **32–48h** | | |

## 目标文件与预计改动

| 文件/模块 | 预计变更 |
|---|---|
| `scripts/lib/service.mjs` | 暴露 adversarial review、job list、doctor 所需稳定 service contract；必要时拆小模块 |
| `scripts/lib/state.mjs` | 添加确定性、分页式 job 查询原语；保留现有 record 兼容 |
| `scripts/lib/job-lifecycle.mjs` | 为 admin reconcile 提供结构化、幂等结果；明确 `partial_apply` 边界 |
| `scripts/lib/setup.mjs` | 形成 transport-neutral doctor report，不执行安装或登录 |
| `scripts/lib/config.mjs` | 复用 review-gate get/set；不把 mutation 混入普通 MCP tool |
| `scripts/lib/admin.mjs` | 新增受限 admin application facade 与 mutation allowlist |
| ~~`scripts/lib/migration-metrics.mjs`~~ | 最终取消；normal CLI 直接删除，改由安装/host verifier 证明零旧入口和零 fallback |
| `scripts/claude-admin.mjs` | 新增最小 break-glass adapter |
| `mcp/server.mjs` | 注册 3 个新 typed tools；必要时把 schema/serialization 拆到 `mcp/` 子模块 |
| `scripts/claude-companion.mjs` | 先加 deprecation/usage 观测，门禁通过后删除 |
| `scripts/lib/args.mjs` | compat window 后删除或改为 admin-only parser，不保留 normal flags |
| `skills/claude-adversarial-review/SKILL.md` | 切到 `claude_adversarial_review` |
| `skills/claude-status/SKILL.md` | list 走 `claude_jobs_list`，wait 在 Skill 中有界轮询 |
| `skills/claude-setup/SKILL.md` | 正常诊断走 `claude_doctor`；显式 gate 操作指向 admin |
| `skills/claude-transfer/SKILL.md` | 直接生成本地 summary seed，不调用 CLI/MCP execution |
| 其余 `skills/*/SKILL.md` | 删除 compatibility fallback，保留 MCP unavailable 的清晰失败说明 |
| `package.json` | 过渡期增加 admin bin；最终删除 `claude-companion` normal bin，仅保留 admin bin |
| `.codex-plugin/plugin.json` | 更新能力描述、默认 prompts 文案与 build metadata |
| `README.md`, `README.zh-CN.md`, `CHANGELOG.md` | 记录唯一正常路径、admin runbook、deprecation 和 prompts 边界 |
| `test/mcp-server.test.mjs` | 新 tools/schema/structured output 与错误 contract |
| `test/commands.test.mjs` | 过渡期 deprecation；最终移除 normal CLI 行为断言 |
| `test/admin-cli.test.mjs` | 新增 admin allowlist、独立故障、mutation 与 partial-apply 测试 |
| `test/jobs-list.test.mjs` | 新增排序、过滤、cursor、limit、安全投影测试 |
| ~~`test/migration-metrics.test.mjs`~~ | 最终取消；没有 compatibility counter，相关删除门禁由 criterion verifier 覆盖 |
| `test/e2e-regressions.test.mjs` | Skill 零 fallback、transfer 本地化、安装缓存一致性 |
| `test/release.test.mjs` | bin、manifest、文档和发布 contract 更新 |

## 实施序列

### Phase 0 — 冻结 contract 与删除清单（RED）

先新增/修改测试，固定：

- 最终 MCP tool inventory 为现有 9 个加 `claude_adversarial_review`、`claude_jobs_list`、`claude_doctor`。
- jobs list 的 filter、排序、cursor、limit 和安全投影。
- status/result/cancel 只接受显式 ID；implicit latest 被删除而不是迁移。
- Skill 不允许 normal CLI fallback；transfer 不需要执行 transport。
- admin command allowlist 与明确拒绝的 `review`、`task`、`apply`、`result` 等命令。
- `partial_apply` 不可被 reconcile 或 discard 自动吞掉。

Oracle：新测试因工具/服务/admin entry 不存在而红，旧核心 MCP 测试仍绿。不要先重构再补测试。

**建议提交**：`test: freeze mcp-only workflow and admin boundary`

### Phase 1 — 把剩余业务逻辑下沉到共享 service（RED → GREEN）

1. 将 adversarial prompt/context/metadata 从 `scripts/claude-companion.mjs` 移到独立 service 函数。
2. 在 state/service 层实现 job query object：filters 标准化、稳定排序、cursor 编解码、limit 和结果投影。
3. 将 setup inspection 组合为 doctor service；区分 `missing`、`installed-auth-unknown`、`authenticated`，不要把 CLI exit code 猜测成确定登录状态。
4. 为 admin facade 建立显式 allowlist，包装现有 gate、reconcile、cancel、artifact inspect/discard。
5. 对 `partial_apply` 返回结构化 `manual_recovery_required`，附 runbook key，不尝试自动回滚。

若 service 文件继续膨胀，按 capability 拆成 `review-service.mjs`、`job-query-service.mjs`、`doctor-service.mjs`，但公共 exports 保持窄；不建立通用 command bus。

**建议提交**：`refactor: extract transport-neutral review and recovery services`

### Phase 2 — 补齐 MCP 正常产品面（RED → GREEN）

1. 注册 `claude_adversarial_review`，验证只读 execution profile、focused prompt、后台 job 和 usage 元数据。
2. 注册 `claude_jobs_list`，验证 workspace 默认、global 显式、filter/cursor/limit 和无敏感字段。
3. 注册只读 `claude_doctor`，保证不执行模型、不修改 gate、不触发安装。
4. 保持 MCP errors：schema/argument 为 `-32602`，内部结构化错误保留 error kind；未知字段 fail closed。
5. 若 `mcp/server.mjs` 因 12 个 tools 过长，只拆 schema registry 和 transport serializer，不引入框架或外部 SDK。

验证必须包括 foreground/background adversarial review、分页稳定性、损坏 cursor、global 明示和 doctor 在 auth ambiguous 时的输出。

**建议提交**：`feat: complete typed mcp workflow parity`

### Phase 3 — 建立最小独立 admin CLI（RED → GREEN）

1. 新增 `scripts/claude-admin.mjs` 与 admin-only parser。
2. 实现 doctor 与 MCP JSON-RPC probe；probe 使用子进程 stdio、固定超时和固定请求，不执行 tools/call。
3. 实现 review-gate status/enable/disable，复用 config service。
4. 实现 jobs list/reconcile/cancel 和 artifact inspect/safe discard。
5. 验证 admin 不依赖 `.mcp.json` 或 MCP server 成功启动；它可以直接 import shared modules。
6. 对所有非 allowlist 命令返回稳定错误和非零退出码。

故障 fixture：

- `.mcp.json` 缺失或 JSON 损坏。
- `mcp/server.mjs` 启动即退出或超过 probe timeout。
- job JSON 截断、进程已消失但状态仍 running。
- artifact 为 ready、apply_blocked、partial_apply 三种状态。
- review gate 已启用且 MCP 不可用。

admin mutation 测试全部使用临时 config/state/workspace root，不触碰用户真实状态。

**建议提交**：`feat: add mcp-independent break-glass admin cli`

### Phase 4 — Skills 切流并移除自动 fallback

1. adversarial Skill 调用新 MCP tool。
2. status Skill 使用 `claude_jobs_list`；等待行为写成有 deadline、固定最大 poll 次数和退避上限的客户端循环。
3. setup Skill：正常检查走 `claude_doctor`；用户明确要求 gate mutation 时，说明这是 break-glass/admin 操作并调用 admin entry。
4. transfer Skill 直接从当前上下文生成结构化 summary seed；它只输出可复制的 handoff 内容，不执行 Claude、不写 job。
5. 其余 Skill 删除 CLI fallback。MCP unavailable 时返回可诊断错误和 admin doctor 指引，不自动改变 transport。
6. 更新 prompt contract 测试：只验证 Skill/prompt 的意图语言和 tool 引用；安全性由 tool/service 测试证明。

在临时安装中逐一触发 9 个 Skill 的正/负路由 smoke，重点验证 review 不再路由到 task、plan review 不再落入 generic task。

**建议提交**：`refactor: route all normal skills through typed mcp`

### Phase 5 — 安装观测与失败演练（最终实施替代项）

原计划的一次 release compatibility window 在实施中被取消，因为最终交付不再保留可达的 normal CLI；为已删除入口增加计数器只会形成死代码和新的状态面。最终门禁改为：

1. 临时 `CODEX_HOME` 安装后逐文件核对源码、安装副本与用户缓存。
2. 通过 5 个 fresh Codex app-server 会话执行 16 次正常操作，并断言 legacy CLI surface/call 与自动 fallback 均为 0。
3. 执行 MCP server 启动失败、corrupt job 与 `partial_apply` 三类失败演练。
4. 由 `node test/verify-mcp-cli-contraction.mjs` 汇总全量测试和 installed-host verifier，作为单一机器判据。

### Phase 6 — 删除旧 normal CLI 并同步发布面

仅在全部删除门禁满足后：

1. 删除 `scripts/claude-companion.mjs` 和 normal-only parser/branches/tests。
2. 从 `package.json` 删除 `claude-companion` bin，只保留 `claude-companion-admin`。
3. 删除 normal CLI README 示例、fallback 文案和不再可达的 compatibility helpers。
4. 更新 plugin manifest、CHANGELOG 和 release tests。
5. 在临时 `CODEX_HOME` 重装并做 source/cache byte-level 或 hash 一致性检查。
6. 同步本机插件缓存后，从 fresh Codex session 复核 tools list、Skill 内容和 admin doctor。

删除后不要继续保留一个接受旧 normal command、再转调 MCP 的 shim；它会重新制造第二入口。需要一个版本过渡时，shim 只能返回迁移错误，不能执行业务。

**建议提交**：`refactor!: remove normal companion cli surface`

## MCP Prompts 与 Resources 的后续门禁

当前不实施 MCP prompts。只有同时满足以下条件才另立计划：

1. 目标 Codex 版本在产品 API 或实际启动流中调用 `prompts/list` 与 `prompts/get`。
2. 用户可以在 Codex 中发现或选择 server prompt，而不只是协议库包含对应类型。
3. 至少 3 个 fresh sessions 证明 prompt 版本更新、参数填充和 tool 引用可观测。
4. 删除所有 prompt 后，tool/service 的权限和安全测试仍完全成立。

即使门禁通过，prompts 也只用于提供常用工作流模板；Skills 是否缩减要由路由可发现性数据决定。Resources 同理：只有 capability/version/runbook 等只读内容存在明确消费方时才增加，job 状态和 artifact 内容继续优先通过有权限检查的 typed tools 返回。

## 权限、安全与数据边界

- 正常 MCP write 仍遵守 isolated workspace + explicit apply 的现有 contract。
- admin CLI 是高权限故障入口，但能力更窄；安装文档必须明确其 mutation 影响。
- review-gate disable、job cancel、artifact discard 都需要用户明确意图；Skill 不得因诊断失败自动调用。
- global job list 可能暴露跨 workspace 元数据，必须显式请求、默认关闭，并使用安全投影。
- 日志和错误不得回显 prompt、patch、artifact 正文、Claude credential path 或完整环境变量。
- 不新增外部依赖、网络 telemetry 或后台常驻进程。

## 回滚策略

每个阶段独立可回滚：

- Phase 1/2 失败：保留现有 MCP 9 tools 和完整 CLI，不切 Skill。
- Phase 3 失败：不删除 CLI fallback；先修复 admin 的独立性。
- Phase 4 fresh-session 路由不稳定：恢复 Skill fallback 仅作为一个明确的 compatibility release，并保持 usage counter；不得无期限保留。
- Phase 5 发现直接 CLI 真实需求：把该需求明确归入 MCP、admin 或正式 standalone CLI 产品决策，再重启窗口。
- Phase 6 删除后发生严重回归：从上一 release 恢复 normal CLI package/bin 和 Skill fallback；共享 service 使回滚无需恢复重复业务逻辑。

任何回滚都不得放宽 isolated write、显式 apply、review read-only 或 `partial_apply` fail-closed 边界。

## 验证命令与证据

实施过程中按阶段运行最小集合，合并前运行全量：

```bash
node --test test/mcp-server.test.mjs test/jobs-list.test.mjs test/admin-cli.test.mjs
node --test test/e2e-regressions.test.mjs test/commands.test.mjs
node --test test/lifecycle.test.mjs test/job-state.test.mjs test/write-apply.test.mjs test/review-gate.test.mjs
npm run check
node test/verify-mcp-cli-contraction.mjs
git diff --check
```

安装验证使用临时 `CODEX_HOME`，不污染默认配置。真实用户态缓存同步属于 Phase 6 的显式安装步骤；如果 sandbox 阻止写入缓存目录，应请求对应最小权限，不绕过边界。

### 最终验证记录

- `npm run check`: 99 tests passed, 0 failed。
- `git diff --check`: passed。
- `node test/verify-installed-host-routing.mjs`: 5 fresh Codex app-server sessions、16 host-routed normal operations、12 tools、9 Skills、0 automatic fallback；全部使用显式注入到临时安装副本的 fake Claude。
- verifier 在执行操作前逐文件比较源码与临时安装的 `mcp/`、`skills/`、manifest、MCP config、admin entry 和 package metadata；也比较本机用户缓存版本 `0.1.0+codex.20260718001845`，并确认两处均不存在旧 normal CLI 文件。
- `node test/verify-mcp-cli-contraction.mjs`: 同时运行全量回归与 installed-host verifier，输出唯一成功判据 `TASKLOOP_CRITERION: mcp-cli-contraction-complete`。
- 故障演练：MCP server 启动失败时 admin gate 仍可工作；corrupt job 保留原始记录并投影为 `corrupt_job_record`；`partial_apply` 拒绝自动 discard。
- independent second-model 首轮指出 focus 无上限、非严格 RFC 3339、错误码、排序以及未固化 host 证据；实现已增加 2000 字符上限、严格 timestamp、`-32602` invalid-query 映射、`updatedAt/createdAt` 排序，并将 5-session gate 固化为仓库 verifier。最终复审结果记录在 taskloop review evidence 中。

## 下一项最小验证

实施前先做 **Phase 0 的 contract-only RED test**：

1. 在 `test/mcp-server.test.mjs` 断言新增 3 个 tool 名称和关键 schema。
2. 在 `test/e2e-regressions.test.mjs` 断言正常 Skills 不包含 companion CLI fallback。
3. 新建 `test/admin-cli.test.mjs`，断言 admin 拒绝 `review` 与 `task`，并能在不存在 `.mcp.json` 的 fixture 中执行 `doctor`。

该验证不调用真实 Claude、不修改产品代码，预计 1–1.5 小时；失败形态能直接证明实施缺口，适合作为第一批 RED tests。

## Excluded

- 真实 Claude/Fable 付费复测。
- MCP prompt/resource 的产品化。
- 非 Codex 的正式 standalone CLI API。
- daemon、REST、Web UI 或远程 job service。
- 自动重试、fallback model、resume chain 或隐式最新 job。
- 自动修复/回滚 `partial_apply`。
- admin apply、commit、push、merge 或批量 discard。
- 改写 Claude execution backend、stdin contract、isolated workspace 或 sandbox 设计。
