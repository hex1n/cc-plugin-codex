# MCP Review Evidence Lease 实施计划

- 日期：2026-07-18
- 状态：validated / ready for offline implementation
- 模式：Plan
- 深度：Deep
- 决策：BUILD；先完成离线契约，再经显式授权执行分阶段同包络 A/B

## 1. 当前最佳结论

Review 路由应收敛为：

> 一次用户请求、一次 Claude 调用、只暴露有界的只读 MCP 证据工具，并由服务端 Evidence Lease 强制结束调查阶段。

Evidence Lease 是服务端维护的证据额度。每次读取 diff、文件或搜索上下文都会消耗额度；最后一次合法响应明确通知模型进入总结阶段，之后的工具调用只返回结构化拒绝，不再返回证据。现有 `max_turns`、`max_budget_usd` 和超时继续存在，但只作为最终熔断器，不再承担正常收敛职责。

本计划：

- 替代 `finalize_at_turn` 软提示作为主要收敛机制。
- 拒绝把“双调用 + no-tool resume”作为默认方案或自动兜底。
- 不改变既有模型/profile、外层 typed MCP、只读 review、写任务 sandbox 等已落地决策。
- 不引入 Agent SDK。

最佳性摘要：适配标准是单 invocation 完成率、critical 检出、clean approve、覆盖真实性与 completed review 总成本；当前胜者是单调用 MCP Evidence Lease，最接近的替代方案是双调用 no-tool resume。若 caller/invariant fixture 漏掉 critical，或重复 A/B 的成本中位数改善不足 20%，胜者即被推翻。本轮到此停止付费架构探索，不再扩展 Agent SDK、自动 rescue、动态路由或 MCP prompts。

下一步验证：先冻结不产生模型费用的 fake CLI/stdio 契约，证明精确工具面、单 invocation、CLI-owned MCP、唯一 executionCwd、原子 lease revision、startup fail-close 与 cancel cleanup；全部通过后才申请 6 次早停 A/B。

## 2. 第一性原理重构

### 2.1 真正要优化的对象

要优化的不是单次调用价格，而是：

> 每个可信、完整、可交付 Review 的总成本。

当第一次调用在调查中途触发 turn/budget 限制，第二轮又重新建立上下文时，即便每次都遵守单次上限，逻辑任务仍可能付出两次成本却只得到一次结果。因此预算必须围绕“完成的逻辑任务”设计，而不是只围绕“一个进程”设计。

### 2.2 必须同时成立的结果约束

一个正常 Review 必须：

1. 在一次 Claude 调用内返回结构化终态。
2. 在调查阶段只能访问有界、只读、仓库内的证据。
3. 到达证据额度时可以继续总结，但不能继续扩大调查。
4. 不自动 resume、retry、切换模型或追加预算。
5. 如实报告检查范围、跳过范围、使用量、请求模型与实际模型。
6. 内层 MCP 故障时 fail closed，不退回 Bash、Read、Grep 等内置工具。

## 3. 验证事实与设计推导

### 3.1 历史失败样本

- 历史记录中发现 9 次限制失败：4 次 `max_turns`，5 次 `max_budget`。
- 其中 7 次发生在 taskloop workspace，4 次后来显式 resume 同一个 session。
- 一个可复现样本配置为 12 turns，实际报告 13 turns 后失败；23 秒后显式 resume 才完成。
- 多个失败在限制触发时仍处于 `stop_reason=tool_use`，说明任务停在调查阶段，而不是稳定的总结边界。

推导：硬 turn/budget 限制只能熔断，不能保证在限制前形成可交付结果。

### 3.2 双调用受控收尾验证

最小真实验证证明：失败 session 可以通过第二次 no-tool resume 生成结构化结果；同一失败 session 的分叉 A/B 中，受控 resume 比开放 resume 的增量成本低 56.16%，逻辑任务总成本低约 38.5%。

但在更真实的 Review fixture 上：

- 共享调查：`$0.0997478`。
- no-tool 受控分支：总链路 `$0.210824`，覆盖不完整，并耗尽分支预算。
- 开放工具分支：总链路 `$0.2171504`，覆盖完整。
- 受控分支仅节省 2.91%，没有达到预注册的 20% 成本门槛，且质量更差。

此外，resume 的 `--max-budget-usd` 是“每次调用重置”，不是逻辑 session 累计预算。插件若采用双调用，必须自行计算剩余额度，否则会把总预算隐式放大。

推导：双调用 no-tool resume 具备技术可行性，但不具备默认生产方案的经济性和质量稳定性；不得自动采用。

### 3.3 单调用 MCP Evidence Lease 验证

临时原型只暴露三个只读 MCP 证据工具，并使用 3 次调用的服务端租约：

- 离线协议验证：前三次允许，第四次拒绝；拒绝不返回新证据。
- 真实 Sonnet/low：一次 Claude 调用成功完成。
- 成本：`$0.0871305`，5 turns。
- 工具事件：3 次 MCP 证据调用 + StructuredOutput。
- 未暴露 Bash、Read、Grep 等内置仓库或 shell 工具。
- 检出已知的高危授权判断赋值错误。
- 租约恰好耗尽，模型遵守 `remaining=0`，没有发起第四次真实调用。

相对于上述同 fixture 的两条双调用路径，成本方向性降低约 58.67% 和 59.88%。这不是严格生产 A/B：提示词、工具面和 Claude CLI patch 版本可能有差异，因此不能把 59% 当成承诺值。

原型也暴露了质量风险：它识别了核心高危 bug，但没有像开放分支那样单独报告缺失的拒绝路径测试。

推导：单调用 MCP Evidence Lease 是当前最佳候选，但必须用多个 fixture 校准工具能力与租约额度，质量不能用一次成功样本外推。

### 3.4 Claude CLI 隔离契约验证

在本机 Claude Code 2.1.214 上，静态帮助与真实 init 事件共同证明：

- `--tools ""` 才是关闭全部内置工具的明确机制；`--strict-mcp-config` 只限制 MCP 配置来源，不能替代它。
- 当前 Review profile 明确允许 `Read/Grep/Glob/Bash(...)`，因此必须修改现有 adapter，不能假设 built-ins 默认不可见。
- `--safe-mode` 会同时禁用显式 MCP；Evidence Review 不得使用 safe mode。
- 以下组合在保留登录态的同时，把工具面收敛为三个证据工具与 schema 产生的 `StructuredOutput`：

```text
--setting-sources ""
--disable-slash-commands
--strict-mcp-config
--mcp-config <job-local-config>
--tools ""
--allowedTools <exact-qualified-evidence-tool-list>
--permission-mode dontAsk
--json-schema <review-result-schema>
```

真实 canary 下，用户级 hooks、12 个 enabled plugins、skills、slash commands 和 `CLAUDE.md` 均未进入 init/runtime；内置 Bash/Read/Grep/Glob/Edit/Write 也未出现。`dontAsk` 不扩大能力，因为工具面已由 `--tools ""` 与精确 allowlist 硬限制；`plan` mode 在强制调用探针中没有调用 MCP，不作为生产路径。

`CLAUDE_CONFIG_DIR` 不能切到 job-local 目录：空目录或只复制 OAuth 元数据都会失去登录态。获胜机制是保留默认 config/auth，仅把 Claude 的 `executionCwd` 指向 mode `0700` 的唯一空 job-control 目录；真实仓库只通过经过 realpath 验证的 `REVIEW_ROOT` 传给 MCP。该机制同时保留认证并把 auto-memory 隔离到空命名空间。

推导：生产启动参数必须是固定的类型化构造，不允许 profile 自由拼接 argv；worker 必须从 init 事件验证 MCP 已连接且工具集合精确相等，缺失或多出任何工具都 fail closed。

### 3.5 stdio MCP 与生命周期验证

真实进程探针确认了最简单的所有权模型：

- Claude CLI 直接 spawn stdio MCP；实测 MCP 的 PPID 就是 Claude PID。
- worker 只需直接持有 Claude PID，并复用现有 process-tree termination；不应自行启动第二个 MCP 子进程。
- cancel Claude 或 Claude 正常退出后，MCP 均在 300ms 内消失，没有残留进程。
- 无效 MCP 配置约 1.6s 即在 init 中显示 `failed`；worker 应立即终止 Claude，并把通用 `error_during_execution` 映射为 `mcp_startup`。
- 成功调用中 lease 在约 7.9s 耗尽，结构化 result 在约 14.7s 返回；因此必须有独立实时 phase 通道，不能等 result 后才标记 `finalizing`。

该实时通道使用 job-local `lease-state.json`：目录 mode `0700`，文件 mode `0600`，MCP 以临时文件 + rename 原子更新并递增 `revision`；worker 约每 100ms 轮询，仅读取 `serverPid/serverPpid/revision/phase/updatedAt` 与 lease 指标。文件不得包含 prompt、diff、源码片段或完整工具参数。

推导：进程关系和 phase 通道已经由真实 lifecycle 探针验证，不再把“worker 同时拥有两个子进程”或“从 Claude stream 猜测 lease”列为候选设计。

### 3.6 语义修正

当前 `budget_exhausted` 混合了不同含义。实施后必须拆分为：

- `evidenceLeaseExhausted`：调查证据额度耗尽。
- `costBudgetExhausted`：Claude 调用成本上限触发。
- `turnLimitReached`：Claude 调用轮次上限触发。

Evidence Lease 正常耗尽不等于任务失败；它是“停止调查、开始总结”的相位信号。

## 4. 范围与非目标

### 4.1 本次范围

- Review 路由的内层只读 MCP 证据服务。
- Evidence Lease 的计算、执行、状态与遥测。
- Claude 单调用的严格 MCP 配置和工具 allowlist。
- Review job 生命周期、取消、超时与 fail-closed 行为。
- Review skills、README 与测试更新。

### 4.2 明确非目标

- 不使用 Agent SDK。
- 不实现自动 resume、retry、模型 fallback 或预算追加。
- 不恢复正常产品路径中的 Review CLI。
- 不向模型暴露 Bash、shell、任意文件工具。
- 不改变 task/write 路由；写操作继续使用独立 sandbox 设计。
- 不在本阶段引入 MCP prompts。MCP 协议支持 prompts，但它解决发现/交互入口，不强制本次 Review 的运行时工具边界；当前 Codex 消费者也尚未消费 prompt list/get。外层继续由 skills 路由，内层一次性 review prompt 继续通过 stdin 注入。
- 不做动态模型路由、成本 dashboard 或跨 job 学习系统。

## 5. 不可破坏的约束

1. 外层正常产品路径仍是 typed MCP tools + skills。
2. Claude 子进程继续使用 `shell: false`，prompt 通过 stdin 传输，不能进入 argv。
3. Review 始终只读；所有路径必须限定在 workspace root。
4. 请求的模型和 effort 必须原样执行，包括显式 Fable。
5. 不新增 Haiku profile 或 Haiku fallback；若 Claude 内部实际使用辅助模型，必须在 effective models 中如实报告。
6. 内层 MCP 不可用或崩溃时直接失败，不得回退到内置工具。
7. 硬 turn、cost、timeout 上限保留为最终熔断器。
8. job 元数据不得保存 prompt 或证据正文，只保存有界指标。
9. Review 禁止 `--safe-mode`；必须使用 `--tools ""`、精确 MCP allowlist、空 `--setting-sources`、禁用 slash commands 和 `dontAsk`。
10. 默认 Claude config 只用于认证；不得复制凭证，也不得替换 `CLAUDE_CONFIG_DIR`。
11. 每个 job 必须使用唯一空 `executionCwd`；仓库路径只能经受信 `REVIEW_ROOT` 进入 MCP。
12. init 工具集合或 MCP 连接状态不精确匹配时立即 `mcp_startup` 失败，不得继续生成“降级 Review”。

## 6. 目标架构

```text
Codex skill
    |
    v
plugin typed MCP review tool
    |
    v
review service / worker
    |  创建 0700 job-control cwd、MCP config、lease state path
    |  启动一次 Claude，固定 isolation flags
    v
Claude process
    |  CLI 直接 spawn/拥有 stdio MCP 子进程
    v
job-local evidence MCP  ----atomic 0600 lease-state----> worker phase poller
    |  REVIEW_ROOT 指向真实仓库
    v
Evidence Lease reducer -> allow / finalize / deny
```

每个 Review job 只启动一次 Claude。Claude CLI 根据 job-local strict MCP config 直接启动 stdio MCP；worker 不单独 spawn MCP，但负责 Claude 进程树、init 验证、lease state 轮询和 job 终态。Claude 只能看到精确 allowlist 中的三个证据工具和 `StructuredOutput`。

## 7. Evidence Lease 设计

### 7.1 工具面

首版采用少量通用、领域有界的工具，避免为单个 fixture 过拟合：

- `review_diff`：读取有界 diff 和变更文件清单。
- `review_file`：读取 workspace 内的明确文件或行段；限制单次文件数和总字节数。
- `review_context`：在 workspace 内返回有界的引用、调用者与测试上下文；不接受 shell 片段。

server name、三个 tool name 与 Claude-qualified allowlist 由同一常量模块生成，禁止分别手写。首版不增加第四个工具；若三个 fixture 证明上下文能力不足，再以新的离线契约与 A/B 评估扩展。

建议的首版安全上限：

- 每次 `review_file` 最多 5 个文件。
- 每次响应最多 64 KiB。
- 搜索结果限制数量、单条长度和总字节数。
- 拒绝绝对路径、workspace 外路径、符号链接逃逸、设备/特殊文件。

这些数值是实施初值，最终默认值必须由 fixture A/B 校准。

### 7.2 加权额度

生产实现使用 evidence units，而不是只计算调用次数：

- diff/context 基础消耗：1 unit。
- file 消耗：`1 + ceil(returnedBytes / 32 KiB)`，并受单次上限约束。
- 无结果搜索仍消耗基础 unit，防止无限探测。
- 被策略拒绝且未返回证据的调用不消耗 unit，但计入 denied calls。

候选 profile 初值：

| Profile | Evidence units | 初始 `maxTurns` | 定位 |
| --- | ---: | ---: | --- |
| quick | 3 | 7 | 小型变更 |
| standard | 5 | 9 | 常规 Review |
| deep | 8 | 12 | 调用者、测试和跨文件不变量 |

首版保持现有公共 enum `quick/standard/deep`，不引入尚不存在的 `gate` profile。`maxTurns` 初值按“最大合法证据调用数 + 4 个综合/结构化输出 turns”计算，仍是待 fixture 校准的最终熔断值，不承担正常收敛。

### 7.3 每次响应的协议

每次工具响应都附带：

```json
{
  "evidenceLease": {
    "limitUnits": 5,
    "usedUnits": 5,
    "remainingUnits": 0,
    "exhausted": true,
    "phase": "finalizing",
    "instruction": "No more evidence is available. Synthesize the final review now."
  }
}
```

规则：

- 最后一次合法证据响应即设置 `remainingUnits=0` 和 `phase=finalizing`。
- 后续调用返回成功的结构化 denial，不返回新证据，避免把协议拒绝误判为传输故障并重试。
- server 端额度是唯一事实来源；prompt 中的提醒不能提升额度。
- `finalize_at_turn` 保留为兼容期 soft hint 并标记 deprecated，不再控制运行时。后续破坏性版本再移除。
- `deniedCalls >= 2` 产生 telemetry 告警；不自动 retry/resume，也不因 denial 追加 evidence units。硬 `maxTurns` 最终终止拒绝循环。

## 8. 状态、遥测与生命周期

### 8.1 Job record

以向后兼容的 additive 字段扩展 job record：

```json
{
  "evidenceLease": {
    "revision": 4,
    "phase": "finalizing",
    "limitUnits": 5,
    "usedUnits": 5,
    "remainingUnits": 0,
    "exhausted": true,
    "allowedCalls": 3,
    "deniedCalls": 0,
    "bytesReturned": 42117,
    "filesExamined": ["src/auth.mjs"],
    "filesSkipped": []
  },
  "evidenceLeaseExhausted": true,
  "costBudgetExhausted": false,
  "turnLimitReached": false
}
```

只保存指标和规范化路径，不保存 prompt、diff、文件内容、搜索片段或完整工具参数。

### 8.2 Phase

- `investigating`：仍可取得新证据。
- `finalizing`：Evidence Lease 已耗尽，或模型主动停止调查并生成结构化结果。
- `completed` / `failed` / `cancelled`：保持现有终态语义。

phase 必须由 Evidence Lease 状态实时驱动，不能等到 result event 才事后标记 finalizing。

MCP 每次 lease 变化后原子写入 `lease-state.json` 并递增 `revision`；worker 忽略倒退、重复或格式错误的 revision。状态文件损坏、超时不更新或 server PID 与 init 不一致均 fail closed，不能从 Claude 文本推断或补写 phase。

### 8.3 进程治理

- worker 只直接 spawn Claude；Claude CLI 直接拥有 stdio MCP 子进程。
- worker 在 init 后验证 required server=`connected` 且 tool set 与精确期望集合相等；失败映射为 `mcp_startup` 并终止 Claude 进程树。
- cancel/timeout 使用现有 process-tree termination 终止 Claude 及 MCP，并验证没有孤儿进程。
- 内层 MCP 启动失败、握手失败、中途退出或 lease state 失真时，Review fail closed。
- 不在同一个 job 内重启 MCP、resume Claude 或切换工具面。

## 9. 预计代码改动

| 文件/模块 | 变更 |
| --- | --- |
| `scripts/lib/review-evidence-lease.mjs` | 新增纯函数 reducer、加权额度、路径/字节策略 |
| `scripts/review-evidence-mcp.mjs` | 新增 job-local stdio MCP server 和只读证据工具 |
| `scripts/lib/claude.mjs` | 增加固定类型化 isolation flags、strict MCP config 与精确 allowlist；Review 禁用 safe mode/plan mode |
| `scripts/lib/service.mjs` | Review 路由配置 Evidence Lease 与唯一 job-control cwd；task/write 不变 |
| `scripts/claude-job-worker.mjs` | 只直接管理 Claude 进程树；校验 init、轮询 lease state、映射 `mcp_startup` |
| `scripts/lib/state.mjs` | 增加兼容的 lease 与 exhaustion 字段 |
| `scripts/lib/claude-stream.mjs` | 区分 MCP 证据调用、StructuredOutput 和真实外部工具；验证精确 init 工具面 |
| `scripts/lib/config.mjs` | 增加 Review profile 的内部 evidence units 配置 |
| `scripts/lib/render.mjs` | 安全展示 lease、覆盖范围和三个独立 exhaustion 原因 |
| `mcp/server.mjs` | 仅在公共契约验证后增加类型化 override；本阶段不添加 MCP prompts |
| Review skills | 改为单调用 Evidence Lease 心智模型，继续禁止自动 resume |
| `README.md` / `README.zh-CN.md` | 说明边界、状态和故障语义 |

## 10. 实施顺序

### Phase 0：冻结行为契约

先写失败测试，固定以下不变量：

- 一个逻辑 Review 只产生一次 Claude invocation；worker 不直接 spawn MCP。
- argv 精确包含 `--tools ""`、空 setting sources、禁用 slash commands、strict MCP、精确 allowlist、`dontAsk` 和 JSON Schema，且不含 safe mode/plan mode。
- init 中 required MCP 必须 connected，工具集合精确为三个 evidence tools + `StructuredOutput`；built-in Bash/Read/Grep/Glob/Edit/Write 不可见。
- Claude 使用默认 config/auth 和唯一空 `executionCwd`；MCP 仅通过 `REVIEW_ROOT` 看到仓库。
- lease 耗尽后不能取得任何新证据。
- 内层 MCP 故障不回退。
- 模型、effort、预算不被隐式改变。

完成条件：契约测试在现有实现上按预期失败。

### Phase 1：纯 Evidence Lease 与安全策略

1. 实现纯 reducer 和加权 unit 计算。
2. 实现路径 containment、符号链接、特殊文件和字节上限校验。
3. 实现 allow/finalize/deny 三态协议。
4. 用单元测试覆盖边界、并发/重复请求和异常输入。

完成条件：不启动 Claude 即可确定性验证租约与文件边界。

### Phase 2：内层 MCP server

1. 实现 stdio MCP 生命周期和三个候选证据工具。
2. 每次响应注入结构化 lease metadata。
3. 实现耗尽后的无证据 denial。
4. 实现独立协议测试：initialize、list tools、允许调用、最后一次 finalizing、后续 denial。

完成条件：离线 probe 能证明额度、路径和响应大小都由 server 强制执行。

### Phase 3：单调用集成

1. 为 Claude adapter 增加固定类型化 flags、MCP config 与精确 allowlist。
2. Review service 创建 mode `0700` 的唯一空 job-control cwd、MCP config 和 lease state path，然后只启动一次 Claude。
3. Claude CLI 直接 spawn stdio MCP；MCP 环境只接收可信 `REVIEW_ROOT` 与 lease state path。
4. worker 从 init fail closed 校验连接与工具集合，并统一处理完成、cancel、timeout 和进程树异常。

完成条件：fake Claude 集成测试证明单调用、无 resume、无工具逃逸、故障 fail closed。

### Phase 4：状态与可观测性

1. 添加 Evidence Lease 指标和三个独立 exhaustion 字段。
2. MCP 用 mode `0600` 的原子 revision state 文件发布 lease；worker 约 100ms 轮询并在耗尽时立即进入 `finalizing`。
3. 保持旧 job record 可读取、可渲染。
4. 使用记录继续汇总单次 invocation 的成本、turns、token usage 和 effective models。

完成条件：新旧 job fixture 均能稳定读取；不会把 StructuredOutput 误计为外部工具。

### Phase 5：文档与 skills

1. 更新 review skills 的调用契约和失败语义。
2. 将 `finalize_at_turn` 标为兼容期 deprecated soft hint。
3. 文档明确 Evidence Lease 与 cost/turn limit 的区别。
4. 文档明确不自动 resume、不切模型、不追加预算。

完成条件：文档、schema、实现和测试使用同一套术语。

### Phase 6：同包络质量/成本验证

在显式授权后进行付费 A/B。候选实现和当前实现必须使用同一 Claude CLI 版本、Sonnet/low、profile、prompt 输入和总成本包络，并预注册判定方式。

至少包含：

1. diff-local 明显 bug：授权判断中的赋值错误。
2. caller/invariant bug：问题只能从调用者或跨文件不变量确认。
3. clean diff：验证误报率与 approve 能力。

分两段执行：

1. 早停段：每个 fixture、每个 arm 各运行 1 次，共 6 次付费调用；任一质量门槛失败立即停止并拒绝候选。
2. 放行段：只有早停段全绿才补足到每个 fixture、每个 arm 3 次，共 18 次付费调用；按预注册的 fixture 内中位数与汇总中位数判定成本。

一次成功样本只用于早停，不能支持默认启用。完成条件见第 11 节；没有通过时 feature flag 必须保持关闭。

## 11. 验收标准

### 11.1 离线与自动化验收

- lease reducer 确定性执行加权额度。
- 最后一次合法响应进入 finalizing；后续调用不返回证据。
- 绝对路径、越界、符号链接逃逸和特殊文件全部拒绝。
- 文件数、搜索结果数和响应字节上限不可绕过。
- Claude prompt 只经 stdin 传输，不进入 argv。
- strict MCP 下 built-in Bash/Read/Grep 不可用。
- fake Claude 全流程只有一次 invocation 和一次 StructuredOutput 终态。
- fake Claude 证明 CLI 而非 worker spawn MCP，且 init 工具集合精确匹配。
- 默认 config/auth 保留，job-control cwd 隔离且清理，`REVIEW_ROOT` 是 MCP 唯一仓库入口。
- Evidence Lease 耗尽时 phase 实时变化。
- lease state 使用 0700 目录、0600 文件、原子 rename 与单调 revision；坏状态 fail closed。
- cancel/timeout 后 Claude 与 MCP server 均无孤儿进程。
- MCP startup 失败映射为 `mcp_startup`，中途故障 fail closed，且没有工具 fallback。
- `deniedCalls >= 2` 可观测；maxTurns 与合法 evidence calls + 4 的策略一致，且不触发自动重试。
- 旧 job record 可读取和渲染。
- requested/effective model、effort、turns、usage 和 cost 报告准确。

### 11.2 付费 A/B 放行门槛

必须同时满足：

- 三个 fixture 全部完成结构化终态。
- 所有已知 critical bug 被检出。
- clean fixture 被正确批准，不制造 blocker/critical 误报。
- `filesExamined`、`filesSkipped` 和 uncertainty 与真实覆盖一致。
- 每个 arm 每个 fixture 至少 3 次；相比当前基线，completed review 的预注册汇总成本中位数至少降低 20%。
- 不发生自动 resume、模型 fallback、budget 增长或工具逃逸。
- effective models 如实报告，包括 Claude 内部可能出现的辅助模型。

若任一质量门槛失败，即使更便宜也不得默认启用。

## 12. 发布与回滚

1. 以内部 feature flag 落地，默认关闭。
2. 完成全部离线和 fake 测试。
3. 获得显式授权后执行三 fixture 付费 A/B。
4. 先为 quick profile 小范围启用。
5. 基于本地 job telemetry 观察完成率、覆盖、denied calls 和每次完成成本。
6. 再决定是否启用 standard；deep 最后启用并单独校准。

回滚只切换 feature flag 回到现有单调用有界 Review adapter。一个运行中的 job 不得自动切换实现或发起第二次调用。

## 13. Value Gate

### 13.1 价值判断

BUILD。

理由：历史 9 次限制失败和 4 次显式 resume 已证明存在重复付费问题；真实 fixture 又否定了默认双调用收尾。单调用 MCP Evidence Lease 在最小真实验证中同时满足强制边界、核心 bug 检出和显著方向性成本降低，值得进入受控实现与 A/B。

### 13.2 预计成本

| 工作项 | 预计耗时 |
| --- | ---: |
| 纯 lease、安全边界 | 8–12h |
| 内层 MCP server 与证据工具 | 10–14h |
| Claude/service/worker 生命周期集成 | 10–14h |
| 状态、渲染、配置 | 6–8h |
| 自动化测试 | 11–15h |
| skills、文档、发布准备 | 3–5h |
| 合计 | 48–68h |

不包含显式授权后的模型调用费用和长期观察周期。

### 13.3 翻案条件

出现任一情况，应停止默认发布并保持 feature flag 关闭：

- caller/invariant fixture 因工具面受限而漏掉 critical bug。
- clean fixture 产生不可接受的严重误报。
- 同包络 A/B 的 completed review 成本改善不足 20%。
- 内层 MCP 启动/清理显著降低可靠性。
- Evidence Lease 导致覆盖声明不真实或无法审计。

此时可保留为 opt-in 实验，或回到当前单调用软提示方案；不得改用自动双调用 rescue。

## 14. Bestness Check

### Fit criteria

- 单请求、单 invocation、稳定终态。
- 优化 completed review 总成本。
- 不牺牲 critical bug 检出、clean approve 和覆盖真实性。
- 不使用 SDK、hooks、shell 或自动 resume。
- 服务端强制边界、fail closed、可审计；认证保留但用户定制与 auto-memory 隔离。

### 当前胜者

单调用 MCP Evidence Lease。

### 最接近的替代方案

双调用 no-tool resume。它在极小 fixture 上便宜，但真实 Review 只节省 2.91% 且覆盖更差，因此落败。

### 胜者的失败条件

如果通用、有界 MCP 工具无法覆盖调用者/测试/跨文件不变量，或内层 MCP 开销使同包络成本改善低于 20%，当前胜者应被推翻。

### 边际停止点

本轮不继续探索 Agent SDK、shell hooks、动态模型路由、自动 resume、task/write 重构、MCP prompts 或成本 dashboard。它们不会帮助回答当前最关键问题：能否在一次受控调用中低成本地产出可信 Review。

## 15. Inversion：最可能失败的方式

| 失败方式 | 防线 |
| --- | --- |
| 深度 Review 需要更多上下文 | profile 化 units；保留有界 read/search；deep 最后发布 |
| 模型忽略 finalizing 指令 | server 在额度后强制 denial；硬 turn/cost 继续熔断 |
| 只找到明显 bug，漏掉测试/调用者问题 | 三 fixture 质量门槛；覆盖字段必须真实 |
| MCP server 崩溃后工具面扩大 | fail closed；禁止 built-in fallback |
| safe mode 把显式 MCP 一起禁用 | Review 明确禁用 safe mode；测试固定完整 argv |
| 用户 settings/plugins/hooks/CLAUDE.md 污染评审 | 空 setting sources、禁用 slash commands、精确 init tool set 与 behavioral canary |
| job-local config 导致认证丢失 | 保留默认 config/auth；只隔离唯一空 executionCwd，禁止复制凭证 |
| MCP startup 失败仍生成降级结果 | init 必须 connected 且 tool set 精确相等；否则 `mcp_startup` fail closed |
| denial 形成新一轮循环 | `deniedCalls >= 2` 告警；maxTurns=合法证据调用上界+4；不 retry/resume |
| 路径或符号链接泄露 workspace 外内容 | realpath containment、特殊文件拒绝和安全测试 |
| job 记录泄露源码/prompt | 只保存指标和规范化路径，不保存证据正文 |
| 内部辅助模型造成认知偏差 | 不请求 Haiku，但如实记录 effective models |

## 16. 下一次最有价值的验证

停止继续做付费架构探针。下一步先实现并冻结 Phase 0–2 的全离线 fake CLI/stdio 契约：精确 init tool set、MCP status、单 invocation、固定 flags、唯一 executionCwd/空 memory、lease 原子 revision、startup fail-close 与 cancel cleanup。随后用 fake Claude 完成 Phase 3–4 集成，不产生模型费用。

只有离线契约全部通过，才申请 6 次早停 A/B；早停全绿后再申请补足到 18 次。任何阶段都不自动 resume、retry、追加预算或切换模型。

该顺序能最早淘汰协议、安全和生命周期错误，同时避免在实现尚不可信时继续消耗模型费用。
