# Typed MCP、stdin 与隔离写执行实施计划

**模式**: Plan
**深度**: Deep
**状态**: ready-for-implementation-after-security-gate
**日期**: 2026-07-14
**输入来源**: 关联决策、当前仓库实现与测试、三项一次性最小验证、Claude Code 2.1.208 本机 CLI、Anthropic 官方 sandbox/worktree/permissions 文档
**设计来源**: [2026-07-14-typed-mcp-stdin-sandbox-design.md](../decisions/2026-07-14-typed-mcp-stdin-sandbox-design.md)
**相关计划**: [2026-07-14-plan-review-implementation.md](./2026-07-14-plan-review-implementation.md)

## TL;DR

分七个可独立回滚的阶段实施：先验证 sandbox 配置、仓库形态和隔离 backend 能否 fail-closed；再把 prompt 改走 stdin；随后抽取 CLI/MCP 共用 application service、加入 typed MCP read/review/job 工具；最后在安全门禁后加入隔离 write start/apply/discard，并切换 Skills 与本机安装。

预计 **72–108 工时**。前三阶段不会改变现有 CLI contract；write MCP 在 sandbox、backend 与 apply 冲突门禁通过前保持未发布或 experimental。默认测试不调用真实 Claude/Fable。

## 当前最佳路径

1. **先落 stdin**：改动小、已原型验证、独立降低 argv 暴露。
2. **再抽 application service**：CLI 先成为 service adapter，确保迁移期间只有一套业务规则。
3. **MCP 先承载 read/review/jobs**：验证 typed protocol、后台生命周期和安装缓存，不把安全风险与协议风险一起上线。
4. **write 单独过安全门禁**：隔离 baseline、sandbox、artifact、apply/discard 全部闭合后才暴露工具。
5. **最后切 Skill 路由**：CLI 保留至少一个发布周期作为兼容回退。

## 决策信封

```yaml
decision: BUILD
target_outcome: typed MCP 成为 Codex 主调用协议，prompt 不进入 argv，写任务只在隔离工作区产生并经显式 apply 修改源工作区
baseline_and_frequency: 所有当前 Skill 调用经 shell CLI；所有 Claude prompt 进入 argv；write 直接作用于源 workspace
expected_benefit: 每次调用消除 shell flag/quoting 漂移和 prompt argv 暴露；每次 write 将提前修改源 workspace 的概率从设计允许降为 0，并提供冲突检测与 discard
delivery_and_maintenance_cost: 72–108 工时交付；持续维护 MCP protocol、隔离 Git fixture、sandbox compatibility manifest 和 macOS/Linux matrix
status_quo_or_existing_mechanism: CLI+stdin 可解决 prompt 暴露，但不能解决 typed routing 与 write isolation
decision_flip_condition: sandbox setting sources 无法 fail-closed，或 baseline/apply 对目标仓库类型不可靠；此时 write 部分切容器/VM或延期，read/review MCP 继续
review_scope: implementation-authorization
review_budget: fake runtimes and local fixtures by default; paid online validation requires explicit authorization
```

## 验收判据

完成必须同时观察到：

1. Codex 从安装插件的 `.mcp.json` 列出并调用 typed tool；MCP server 不 spawn CLI adapter。
2. 前台、后台、resume、structured failure 的 Claude argv 都不包含 prompt，stdin 内容与原 prompt hash 一致。
3. 现有 CLI 命令、profiles、Fable/model/effort、budget、status/result/cancel 和旧 job record 全部兼容；结果同时报告 requested/effective models，上游 auxiliary model 不被误报为插件自动选择。
4. read/review MCP 无 write 字段；write 只能通过独立 `claude_write_task_start`。
5. write job 启动后，源工作区的 tracked、index、untracked 内容和 status 不变。
6. 隔离 baseline 精确包含 staged、unstaged、untracked、删除、binary 和 file mode；不自动复制 ignored secrets。默认 standalone clone 不使用 hardlink/alternates；worktree 只在 G3 通过的平台启用。
7. 每次 write start 都在 Claude 启动前执行 runtime preflight；sandbox 不可用、CLI 版本未验证、policy hash 不匹配、配置被扩大或 escape hatch 未关闭时返回 `write_capability_unavailable`，且 Claude executable 未被调用。
8. 成功 write 只进入 `awaiting_apply`；没有任何路径自动 apply、stage、commit、merge 或 push。
9. apply 对相同 baseline 成功并复现隔离结果；agent-changed path 发生并发变化时进入不可覆盖的 `apply_blocked`；只有 agent-untouched path 漂移时，首次 apply 零修改并要求用户基于同一 patch hash 显式确认 context drift。
10. patch/prompt/正文不进入 job JSON、status、events、普通错误或 MCP 文本摘要。
11. discard/expiry 清理隔离目录和 Git administrative state；失败可观测且可重试。
12. `npm run check`、`git diff --check`、临时安装与本机安装缓存一致性验证通过。

## 下一步验证

在写生产实现前，先完成三个不改变公共行为的 gate：

- **G1 runtime sandbox gate**：证明 job-local settings 能排除 inherited allowWrite/excludedCommands，且 `failIfUnavailable=true` 和 `allowUnsandboxedCommands=false` 生效；产出 CLI-version/platform/policy-hash compatibility manifest。
- **G2 repository-shape gate**：用最小 fixture 明确 submodule、sparse checkout、Git LFS、symlink、file mode 和超大 untracked 的支持/拒绝矩阵，并作为版本化测试 artifact。
- **G3 backend-selection gate**：分别验证 standalone clone 与 worktree 对 source working tree、source `.git/HEAD`、`.git/objects` 的写隔离、cleanup 和性能；standalone clone 是默认，worktree 只有全部安全条件通过后才能成为平台优化。

G1 失败时继续 stdin/MCP read-only，暂停 write；G2 中无法安全复制的形态初版 fail closed，不扩大实现。G3 中 worktree 失败时保持 standalone clone；两个 backend 都失败才暂停 write。

## 实施不变量

1. MCP 与 CLI 调用同一 application service；不得维护两份参数默认值、profile 或 job lifecycle。
2. 所有子进程使用 `shell: false`；任何需要 shell 组合的行为都拆成结构化 spawn。
3. prompt 只存在于内存和当前已有的短生命周期 `0600` job request；不进入 argv 或 durable job record。
4. read-only 与 isolated-write 是不同 capability，不能通过任意布尔参数升级。
5. write baseline 是用户启动时工作区的快照，不是只有 HEAD，也不是 origin/default branch。
6. worktree/checkout 不是 security boundary；standalone clone 是初版默认，worktree 必须由 G3 按平台授权；sandbox unavailable 必须失败。
7. apply 永远显式、非 stage、非 commit、非 push，且失败不自动 merge/retry。
8. 任意日志、MCP result 和错误信息默认只包含 hash、统计、路径清单和状态，不包含 patch 正文。
9. 插件不自动选择 Opus/Fable/Haiku、retry、resume、fallback 或增加预算；上游 auxiliary model 通过 `effective_models` 如实审计，不能只凭 requested model 承诺“绝不使用 Haiku”。
10. Windows native 初版不承诺 write sandbox；macOS、Linux/WSL2 按门禁结果声明支持。

## 范围与成本

以下 scope table 是总投入的权威定价。后续阶段标题中的估时用于排期，部分测试/文档时间已分摊到 supporting 行，不应再次累加。

| Scope | Component | Effort | Risk | Value |
|---|---|---:|---|---|
| Core | G1 runtime sandbox、版本 compatibility 与平台 fail-closed gate | 8–12h | 高 | 决定 write 是否可安全发布并防止 CLI 升级后静默失效 |
| Core | G2 repository-shape matrix + G3 backend selection | 8–12h | 高 | 在投入 write 实现前固定支持面与 clone/worktree 边界 |
| Core | Claude invocation 统一与 stdin 前后台迁移 | 4–6h | 中 | 消除 prompt argv 暴露 |
| Core | application service 抽取、CLI adapter 兼容 | 8–12h | 高 | 避免 MCP/CLI 双业务逻辑 |
| Core | MCP stdio server、typed schemas、read/review/job tools | 10–14h | 中 | 替代外层 shell 主协议 |
| Core | 隔离 baseline/workspace manager | 12–18h | 高 | 写任务不触碰源工作区 |
| Core | patch artifact、冲突检测、apply/discard/expiry | 10–16h | 高 | 关闭改动所有权与生命周期 |
| Supporting | 安全、兼容、安装和跨平台回归 | 8–12h | 高 | 证明 fail-closed 与无回归 |
| Supporting | Skills、README、发布与本机同步 | 4–6h | 低 | 完成主入口切流和交付 |
| **Total** | **Core + Supporting** | **72–108h** | | |

Optional、不计入总投入：

- 容器/VM runner：另估 40–80h。
- ignored dependency allowlist/setup hook：另估 8–16h。
- 自动三方 merge、commit、push：明确不做。
- 非 Git VCS adapter、remote executor、patch stacking：明确不做。

若 core + supporting 超过 108h，或必须加入容器 runner 才能支持默认 write，重新运行价值门禁并拆为 read-MCP 与 secure-write 两个版本目标。

## 目标模块

| 文件/模块 | 预计变更 |
|---|---|
| `.codex-plugin/plugin.json` | 声明 `mcpServers`，更新 capability/default prompts/build metadata |
| `.mcp.json` | 新增本地 stdio MCP server 配置 |
| `mcp/server.mjs` | JSON-RPC initialize、tools/list、tools/call、错误映射与 shutdown |
| `mcp/tools.mjs` | typed tool schemas 与 service 参数映射 |
| `scripts/lib/service.mjs` | 统一 review/task/job/write application operations |
| `scripts/claude-companion.mjs` | 收敛为 CLI parse/render adapter，不直接拥有业务 dispatch |
| `scripts/lib/claude.mjs` | `buildClaudeInvocation()`、stdin、sandbox/settings 输入 |
| `scripts/claude-job-worker.mjs` | 后台 stdin pipe、write workspace cwd、artifact finalize |
| `scripts/lib/process.mjs` | 统一 foreground/logged spawn 的 stdin/backpressure/error contract |
| `scripts/lib/write-workspace.mjs` | 隔离 checkout、dirty baseline、quota、cleanup |
| `scripts/lib/sandbox-policy.mjs` | job-local settings、platform probe、fail-closed validation |
| `config/sandbox-compatibility.json` | 已验证 Claude CLI 精确版本、平台、policy schema/hash；任何变更需重跑 G1 |
| `scripts/lib/patch-artifact.mjs` | baseline→agent patch、manifest、hash、apply check |
| `scripts/lib/state.mjs` | transport/capability/artifact additive metadata 与 apply lock |
| `scripts/lib/render.mjs` | CLI 与 structured MCP 共享的稳定 result shape |
| `skills/*/SKILL.md` | 主路径改用 MCP；CLI 作为明确回退 |
| `README.md`, `README.zh-CN.md` | typed tools、stdin、安全边界、apply/discard、平台支持 |
| `test/mcp-server.test.mjs` | MCP handshake、schema、工具调用、错误与安装 fixture |
| `test/stdin-transport.test.mjs` | 前后台/resume/failure argv 与 stdin contract |
| `test/write-workspace.test.mjs` | dirty baseline 与 repository-shape matrix |
| `test/sandbox-policy.test.mjs` | settings、平台 probe、fail unavailable 与 escape hatch |
| `test/write-apply.test.mjs` | apply/discard/conflict/cleanup/expiry |

文件名可在实现时按现有模块深度微调，但 responsibility 不得重新塞回 CLI script 或 worker。

## 实施序列

### 阶段 0：G1/G2/G3 安全、仓库形态与 backend 门禁（16–24h）

先写测试/探针，不改公共入口。

#### G1 sandbox policy

建立 `test/sandbox-policy.test.mjs` 与最小 probe：

- macOS 检查 Seatbelt 可用；Linux/WSL2 检查 bubblewrap、socat 与 namespace 前提。
- 生成 job-local settings，固定：
  - `sandbox.enabled=true`
  - `sandbox.failIfUnavailable=true`
  - `sandbox.allowUnsandboxedCommands=false`
- 验证 `--setting-sources` 只加载允许 scope；制造 user/project settings 中的额外 `allowWrite`/`excludedCommands`，确认不能进入 effective policy。
- 明确 `--safe-mode` 与 `--settings` 不可同时作为方案，因为 safe mode 会禁用相关 customization。
- 若 Claude CLI 没有无费用的 effective-config introspection，则自动测试验证生成与 argv contract；真实 enforcement smoke 单独列为发布前显式授权项，不伪造结论。
- 验证通过后写入 `config/sandbox-compatibility.json`：Claude CLI 精确版本、OS/platform、policy schema version、canonical policy SHA-256 和 probe evidence version。
- `sandboxPolicy.preflight()` 每次 write start 都重新读取当前 CLI version/platform、重新生成 policy 并比较 hash；不在 manifest、hash mismatch 或 prerequisite 缺失时返回 `write_capability_unavailable`，且必须发生在创建 workspace 与 spawn Claude 之前。
- MCP `tools/list` 可以根据 preflight 隐藏 write tools，但 `claude_write_task_start` 本身仍重复检查；无 bypass flag、环境变量或用户 override。

**门禁**：无法证明 inherited settings 不扩大权限时不写入 compatibility entry，write MCP 必然 unavailable；Claude CLI 版本变化自动使旧 entry 失效，必须重跑 G1 才能恢复。计划继续阶段 1–3。

#### G2 repository shapes

在 temp repos 覆盖：

- staged + unstaged 同文件与不同文件；
- untracked regular file、symlink、目录树；
- deletion、rename、executable bit、binary；
- submodule、sparse checkout、LFS pointer；
- ignored `.env` 与 dependency dir 不复制；
- file count/byte quota；FIFO/socket 等特殊文件 fail closed。

输出版本化 support matrix，至少包含 repository shape、supported/rejected、拒绝阶段、fixture 和 evidence command。初版可以拒绝复杂仓库，但错误必须发生在 Claude 启动前。

#### G3 backend selection

对 standalone clone 与 worktree 分别运行相同 fixture：

- 在 Claude sandbox 等价进程中尝试修改 source working tree marker、source `.git/HEAD`、`.git/config` 和 `.git/objects`；全部必须失败。
- 隔离 workspace 内普通文件写入、Git read/status/diff 和必要 test subprocess 必须成功。
- cleanup 后 source Git administrative state、worktree list 和 plugin state 不残留 orphan。
- 记录小型与中型 fixture 的创建时间和磁盘增量；性能只决定是否优化，不降低安全门禁。
- standalone clone 禁止 hardlink、shared alternates 或回指 source object store；它是初版 fallback/default。
- worktree 只有在每个声明支持的平台都通过 source `.git` 写入阻断后，才写入 compatibility manifest 成为该平台可选 backend。

**门禁**：阶段 4 开始前必须冻结 `write_workspace_backend`。默认 `standalone-clone-v1`；未通过 G3 的 worktree 不能由配置强行启用。若两个 backend 都失败，write capability unavailable。

**建议提交**：

1. `test: define runtime sandbox compatibility gate`
2. `test: define repository-shape support matrix`
3. `test: select isolated write workspace backend`

### 阶段 1：统一 invocation 并迁移 stdin（4–6h）

#### RED

新增 `test/stdin-transport.test.mjs`，fake Claude 同时捕获 argv 和 stdin：

- foreground task/review；
- background stream-json；
- model、Fable、effort、schema、turns、budget；
- resume/continue；
- exit nonzero、max turns、max budget、malformed payload；
- timeout/cancel 前后 stdin pipe 正确关闭；
- prompt 包含 flag、空格、换行、Unicode 和大文本。

所有 case 断言：argv 不含 prompt 和独立 `--` prompt separator；stdin hash 等于 rendered prompt hash。

#### GREEN

- 将 `claudeArgs(profile, prompt, options)` 替换为 `buildClaudeInvocation(profile, prompt, options)`。
- builder 返回 `{ command, args, stdin }`，调用方不能遗漏 stdin。
- `runClaude()` 将 stdin 传入已有 `runCommand()`。
- `claude-job-worker.mjs` 的 stdin 从 `ignore` 改为 `pipe`，spawn 后 `end(prompt)`；处理 early exit/EPIPE，不把 prompt 写入 stderr。
- 更新现有 fake Claude fixtures 从 `process.argv.at(-1)` 改为读取 stdin。
- transfer 命令若只是生成摘要 seed，保持原有输出 contract，但不得把真实执行路径重新引回 argv。

#### 验证

```bash
node --test test/stdin-transport.test.mjs test/background.test.mjs test/task-options.test.mjs test/resume.test.mjs test/timeout.test.mjs
npm run check
```

**建议提交**：`refactor: send Claude prompts over stdin`

### 阶段 2：抽取共享 application service（8–12h）

目标是先让现有 CLI 成为新 service 的第一个 adapter，行为完全不变。

#### RED

- 为每个 command 固定 service request/result contract。
- snapshot 当前 CLI JSON 输出与错误分类。
- 证明 defaults/profile/config precedence 只解析一次。
- 证明 render 层不参与业务决策。

#### GREEN

新增 `scripts/lib/service.mjs`：

```text
reviewChanges(request)
runReadonlyTask(request)
startIsolatedWrite(request)   // 阶段 4 前返回 capability unavailable
getJob(request)
getJobResult(request)
cancelJob(request)
applyWriteResult(request)     // 阶段 5 前 unavailable
discardWriteResult(request)   // 阶段 5 前 unavailable
```

- 将 config、validation、prompt render、collector、execute/job orchestration 从 CLI dispatch 移入 service。
- service 返回对象或 typed errors；CLI adapter 最后调用 `render*()`。
- 保持 `parseArgs()`、usage 和现有 shell CLI 公共 contract。
- 不让 service 依赖 `process.argv`、TTY 或 MCP。

#### 验证

```bash
node --test test/commands.test.mjs test/config-precedence.test.mjs test/job-state.test.mjs test/background.test.mjs
npm run check
```

#### `runtime-service-v1-ready` milestone

以下条件全部满足后，plan-review 才能开始 service integration：

- `refactor: extract shared Claude application service` commit 已落到目标分支并记录 SHA。
- service request/result/error contract 有固定测试，CLI adapter snapshot 无回归。
- `scripts/lib/service.mjs` 不依赖 `process.argv`、TTY、CLI renderer 或 MCP。
- `npm run check` 全绿。

collector、prompt 和 schema 可在 milestone 前独立开发；任何 dispatch、job metadata 或 `claude_review_plan` 集成必须等待 milestone。实施完成记录写入 `Runtime service contract: v1-ready @ <sha>`。

**建议提交**：`refactor: extract shared Claude application service`

### 阶段 3：加入 typed MCP read/review/job tools（10–14h）

#### MCP server

- 新增 `.mcp.json` 与 `mcp/server.mjs`。
- 实现 newline-delimited JSON-RPC stdio：`initialize`、`ping`、`tools/list`、`tools/call`。
- 未知 method、未知 tool、schema error 和 service error 使用稳定 JSON-RPC/MCP error mapping。
- stdout 只写协议消息；debug/error 写 stderr，且经过敏感信息清洗。
- server 直接 import service，不 spawn CLI。

#### 首批 tools

```text
claude_review_changes
claude_task_readonly
claude_job_status
claude_job_result
claude_job_cancel
```

- schemas 使用 `additionalProperties:false`。
- `workspace_root`、profile、model、effort、turn/budget/timeout、background 各有明确类型。
- review 与 task schema 不共享非法字段；read-only task 没有 write。
- result 同时返回 concise text 和 structuredContent；usage/cost/session/error 不丢失。

#### Codex 插件加载

- manifest 增加 `mcpServers: "./.mcp.json"`。
- 临时 `CODEX_HOME` 安装 fixture 完成 install、initialize、tools/list 和 tools/call。
- 如果 Codex MCP roots 能稳定提供当前 workspace，则验证并用于 confinement；否则保留显式绝对 `workspace_root` + realpath/Git-root 校验，并记录限制。
- 至少一次 fresh Codex session discovery 属于发布前 smoke；若会消耗模型配额，需显式授权。

#### 验证

```bash
node --test test/mcp-server.test.mjs test/commands.test.mjs test/job-state.test.mjs
npm run check
```

**建议提交**：`feat: expose read-only Claude operations over typed MCP`

### 阶段 4：隔离 write start 与 sandbox（18–28h）

只有阶段 0 的 G1/G2/G3 满足已声明平台门禁、`write_workspace_backend` 已冻结后才进入。

#### Workspace manager

新增 `scripts/lib/write-workspace.mjs`：

1. realpath source Git root，获取 workspace lock。
2. 捕获 HEAD、tracked diff、untracked manifest、status 和 baseline fingerprint。
3. 按 G3 冻结的 backend 在 plugin state root 创建 job-owned isolated workspace；默认 `standalone-clone-v1` 具有独立 object store，不使用 hardlink/alternates。
4. 重放 tracked binary diff，复制允许的 untracked entries。
5. 校验 source snapshot 与 isolated snapshot 等价。
6. 创建 synthetic baseline commit，释放短期 prepare lock。

阶段 4 不再重新选型 backend。若实现发现 G3 结论不成立，立即使 write capability unavailable 并返回阶段 0 重跑门禁，不在实现中静默切换或放宽边界。当前 worktree 原型只证明 dirty-state 复制机制可行，不构成 worktree 安全授权。

#### Sandbox policy

- job-local settings 权限 `0600`。
- 每次 write start 首先调用 `sandboxPolicy.preflight()`，核对 CLI exact version、platform prerequisite、policy schema/hash 和 G3 backend authorization；失败发生在 workspace create 和 Claude spawn 前。
- sandbox required、fail unavailable、disable unsandboxed escape。
- permission mode `acceptEdits`，cwd 仅为 isolated workspace。
- deny sensitive home/source/state paths；不生成任意 excluded command。
- Claude invocation/job record 标记 `sandbox_required=true`；只有 probe 与启动 contract 成功才标记 `sandbox_verified=true`。

#### Write tool

新增 `claude_write_task_start`：

- 不与 `claude_task_readonly` 共享 write bool。
- foreground 也通过 job lifecycle 执行，以保留 workspace ownership。
- Claude 成功后 finalize patch artifact，状态为 `awaiting_apply`，不返回完整 patch。
- failure/cancel 保留 workspace 到 TTL，允许 discard；不允许 apply 未完成 artifact。

#### 验证

- fake Claude 尝试写 source root、home marker、plugin state marker，全部被 policy/路径 contract 拒绝。
- source working tree/index/status 在 prepare、running、awaiting_apply 全阶段不变。
- background cancel、timeout、worker crash 后 workspace 可追踪和清理。
- sandbox prerequisite 缺失时 Claude executable 未被调用。
- Claude CLI version 或 canonical policy hash 改变时 write tool 自动 unavailable；更新 compatibility manifest 前不能由配置恢复。
- 使用 worktree backend 的平台重复 G3 source `.git` write probe；使用 standalone clone 的平台断言无 hardlink/alternates/back-reference。

**建议提交**：

1. `feat: create isolated baselines for write jobs`
2. `feat: fail closed on unsandboxed write execution`
3. `feat: add typed isolated write task start`

### 阶段 5：patch artifact、apply/discard 与恢复（10–16h）

#### RED

新增 `test/write-apply.test.mjs`：

- agent 新增/修改/删除 tracked 与 baseline-untracked 文件；
- binary、rename、mode change；
- agent-touched path changed：`apply_blocked` 且源零修改；
- 只有 agent-untouched path 漂移：首次 apply 返回 `context_drift_confirmation_required` 且源零修改；使用同一 patch hash 显式 `allow_context_drift=true` 后才继续；
- context drift 确认携带错误或过期 patch hash：拒绝且零修改；
- `git apply --check` failure；
- duplicate apply/discard 幂等或明确冲突；
- apply 与 discard 并发只有一个胜者；
- cleanup failure、process restart、TTL expiry 可恢复；
- patch content 不出现在 state/events/render/MCP text。

#### GREEN

- `patch-artifact.mjs` 生成 binary patch、path manifest、baseline/result fingerprint、hash，文件模式 `0600`。
- `state.mjs` 增加 artifact lifecycle 和 workspace-scoped apply lock。
- `claude_write_task_apply` 只接收 job id/opaque token、可选 `allow_context_drift` 和必须匹配的 `expected_patch_hash`，不接收任意 patch path。
- apply 顺序：lock → agent-changed path fingerprint compare → full baseline drift classify → 必要时零修改返回 confirmation required → `git apply --check` → apply → result verify → state transition → cleanup。
- agent-changed path conflict 不允许 override；agent-untouched context drift 只有用户基于同一 frozen patch hash 的第二次显式调用可以确认。
- apply result 审计 `context_drift_detected`、drift path count 和 confirmation，不记录文件正文。由于当前没有可靠 read-set，这是一项显式接受的语义边界，不声称能证明补丁仍符合所有变化后的上下文。
- `claude_write_task_discard` 删除 artifact/workspace 并记录 terminal status。
- startup reconciliation 清理超过 TTL 且无 active process 的 workspace；`awaiting_apply` 默认 TTL 应保守，并在 config/文档中可见。
- cleanup 失败不抹掉 terminal operation，记录 `cleanup_pending` 供下次 reconciliation。

#### 验证

```bash
node --test test/write-workspace.test.mjs test/write-apply.test.mjs test/job-state.test.mjs test/lifecycle.test.mjs
npm run check
```

**建议提交**：`feat: add explicit apply and discard lifecycle for write jobs`

### 阶段 6：Skills 切流、plan-review 接入、发布与本机同步（运行时部分 4–6h；plan-review 另计 8–12h）

#### Skill routing

- `claude-review` 使用 `claude_review_changes`。
- `claude-task` 对 inspect/read-only 使用 `claude_task_readonly`，对显式写授权使用 `claude_write_task_start`。
- `claude-status/result/cancel` 使用对应 MCP tools。
- Skill 不再要求通过 shell 拼 `node claude-companion.mjs ...`；CLI 只列为 MCP unavailable 的明确回退。
- 写 Skill 必须向用户报告 `awaiting_apply`，不能把完成 Claude 执行描述为已修改源 workspace。
- apply 必须来自用户明确指令；不得在 write task 完成后自动调用。

#### plan-review

- collector、prompt、schema 可独立开发；dispatch、job metadata、service integration 和 MCP tool 必须等待 `runtime-service-v1-ready @ <sha>` milestone。
- milestone 未记录时，plan-review 不得复制 service 逻辑或发布 shell-only 临时执行路径。
- milestone 通过后按现有 plan-review 计划完成 integration 与 metadata。
- 新增 `claude_review_plan`，直接调用共享 review service。
- 不先发布 shell-only `claude-plan-review` 再迁移。
- plan review 的实际开发 8–12h 仍归原计划，不重复计入本计划 72–108h。

#### 文档与发布

- README 区分 transport、permission、edit isolation、OS sandbox 四层。
- 明确 macOS/Linux/WSL2/Windows 支持矩阵和 prerequisite。
- 明确 prompt 走 stdin，但 Claude 本地 session/history 仍受其自身设置控制。
- 明确 patch diff context 的敏感性、TTL 与 apply conflict 行为。
- 更新 plugin build metadata，保持 package base version contract。
- 临时 `CODEX_HOME` 安装验证后，再执行本机官方安装路径同步。

```bash
codex plugin add cc-plugin-codex@personal --json
codex plugin list
```

- 比较 source/cache manifest、MCP server、skills 和 runtime 文件 hash。
- 新开 Codex session 刷新 MCP/Skill metadata。
- 真实 Claude/Fable 和 fresh-session tool-selection smoke 只有在用户再次授权后运行。

**建议提交**：`feat: route Codex Claude skills through typed MCP`

## 测试矩阵

| 维度 | Cases |
|---|---|
| Transport | CLI, MCP, foreground, background, resume, cancel |
| Claude result | success, nonzero, max-turns, max-budget, malformed, timeout |
| Runtime controls | quick/standard/deep, sonnet/opus/fable/full id, low/medium/high effort |
| Git baseline | clean, staged, unstaged, both, untracked, delete, rename, binary, mode |
| Apply | clean, unrelated concurrent change, overlapping change, duplicate, race |
| Sandbox | macOS available/unavailable, Linux prerequisites available/missing, inherited settings attack, CLI version skew, policy hash mismatch |
| Backend | standalone clone no hardlink/alternates, worktree source `.git` write probe, cleanup/orphan, performance evidence |
| Privacy | argv, job JSON, events, stderr, MCP text, status/result serialization |
| Compatibility | old CLI, old job record, installed cache, plugin manifest, Skill inventory |

测试 fixture 必须全部放在临时目录，不能使用真实用户仓库作为 destructive target。

## 迁移与回滚

### 迁移顺序

```text
CLI argv prompt
  → CLI stdin prompt
  → CLI over shared service
  → MCP read/review over shared service
  → MCP isolated write experimental
  → MCP becomes Skill default
  → CLI compatibility period
```

### 回滚单元

- stdin commit 可独立回滚。
- MCP manifest/server 可移除，CLI/service 不受影响。
- write tools 可从 `tools/list` 隐藏，read/review MCP 继续工作。
- Skill 可退回 CLI adapter，不回滚 state/service。
- 已存在 `awaiting_apply` workspace 在版本回滚前必须先 apply/discard，或由兼容 cleanup utility 处理。

不得通过回滚自动删除未 apply 的 workspace；先列出 artifact 和 expiry，再由用户决定 discard。

## 发布门禁

```bash
node --test test/stdin-transport.test.mjs
node --test test/mcp-server.test.mjs
node --test test/sandbox-policy.test.mjs test/write-workspace.test.mjs test/write-apply.test.mjs
npm run check
git diff --check
```

随后完成：

1. 临时 `CODEX_HOME` marketplace install + MCP handshake。
2. fake Claude public-interface foreground/background/read/write/apply/discard E2E。
3. 源码与安装缓存 hash 一致性。
4. 平台 sandbox prerequisite 报告。
5. `config/sandbox-compatibility.json` 与当前 CLI exact version/platform/policy hash 一致；G2 support matrix 和 G3 backend evidence 可追溯。
6. 若获得授权：一次 fresh Codex tool discovery、一次受限真实 Claude read-only smoke、一次最小 isolated write→discard；默认不 apply 到用户仓库。

## 实施完成记录模板

```text
Status: implemented | partially-implemented
Commits: <sha list by phase>
Tests: <commands and counts>
MCP tools exposed: <names>
Sandbox platforms verified: <platform/version/evidence>
Sandbox compatibility manifest: <version/hash>
Write workspace backend: <standalone-clone-v1 | authorized-worktree + G3 evidence>
Repository shapes supported/rejected: <matrix link>
Runtime service contract: v1-ready @ <sha>
Installed plugin version: <version>
Online Codex/Claude validation: not run | authorized result and cost
Pending write artifacts: 0 | <explicit list>
Known limitations: <remaining items>
```
