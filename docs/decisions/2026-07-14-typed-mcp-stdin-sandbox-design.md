# Typed MCP、stdin 与隔离写执行设计

**模式**: Decision
**深度**: Deep
**状态**: accepted-for-implementation
**日期**: 2026-07-14
**输入来源**: 当前仓库实现与测试、三项一次性最小验证、Claude Code 2.1.208 本机 CLI、Anthropic 官方 sandbox/worktree/permissions 文档
**关联实施计划**: [2026-07-14-typed-mcp-stdin-sandbox-implementation.md](../plans/2026-07-14-typed-mcp-stdin-sandbox-implementation.md)
**关联方案审查计划**: [2026-07-14-plan-review-implementation.md](../plans/2026-07-14-plan-review-implementation.md)

## TL;DR

将 cc-plugin-codex 从“Skill 通过 shell 拼 CLI 命令”演进为“Codex 通过本地 typed MCP 调用共享应用服务”；Claude 子进程继续使用 Node `spawn(..., shell: false)`，但 prompt 从 argv 改走 stdin。

写任务不再直接编辑用户工作区。插件先创建包含用户当前 staged、unstaged、untracked、删除和二进制状态的隔离写工作区，再在其中启动 Claude，并同时启用 Claude 原生 OS sandbox 与权限规则。完成后只生成相对于隔离基线的代理增量，必须由独立的 `apply` 或 `discard` 操作结束生命周期。

```text
Codex
  │ typed MCP / JSON-RPC stdio
  ▼
cc-plugin-codex MCP server
  │ direct function call
  ▼
application service ───── job/state/result
  │ spawn(shell:false), prompt via stdin
  ▼
Claude Code
  ├─ read/review: repository + bounded evidence
  └─ write: isolated checkout + native sandbox + permissions
                         │
                         ├─ apply (explicit, conflict checked)
                         └─ discard (explicit)
```

## 决策信封

```yaml
decision: BUILD
target_outcome: Codex 与插件之间具备类型化、可审计且不依赖 shell 命令拼接的调用协议；写任务不能在用户确认前直接修改源工作区
baseline_and_frequency: 每次 Skill 调用都经 shell 入口；prompt 当前进入 Claude argv；每次 task --write 都在源工作区使用 acceptEdits
expected_benefit: 消除外层 shell quoting/argv 暴露和命令矩阵漂移；把写任务的失败半径从源工作区缩小到隔离工作区；为 review/task/status/result/apply 建立稳定 typed contract
delivery_and_maintenance_cost: 预计 72–108 工时；新增 MCP server、共享应用服务、隔离写工作区与 apply/discard 生命周期，持续维护约 1 个协议层和 2 个安全适配器
status_quo_or_existing_mechanism: 保留现有 shell CLI，并仅增加文档约束与 acceptEdits 提示
decision_flip_condition: 若 Codex 不能稳定加载本地 MCP，或 Claude sandbox 无法以 fail-closed 方式隔离所支持平台，则退回 CLI+stdin，并将强隔离升级为容器/VM 独立项目
review_scope: implementation-authorization
review_budget: 首轮使用 fake Claude、本地 Git fixture 与临时 CODEX_HOME；任何真实 Claude/Fable 或付费 Codex 路由复测都需再次显式授权
```

用户已明确要求落地，价值门禁的决策来源为用户。72–108 工时包含安全闭环而不只是传输替换；若超过 108 工时、必须自研通用容器运行时，或无法 fail-closed，则重新定价。

## 根问题

问题不是“shell 本身不好”，而是三种不同责任被压在同一条隐式命令链上：

1. Codex 到插件的操作协议由自然语言 Skill 和 CLI flags 共同表达，缺少机器可验证的类型边界。
2. 插件到 Claude 的 prompt 作为进程参数传递，进入 argv、调试输出和进程检查面的风险高于 stdin。
3. `task --write` 把“允许代理写”直接等价为“允许代理写用户源工作区”，没有预览、所有权和提交前隔离。

已解决的结果应当是：

- Codex 调用 review、task、status、result、cancel、apply、discard 时使用 typed operation，不再拼 shell 命令。
- prompt 只通过 stdin 进入 Claude，不出现在 argv。
- read-only 与 write-capable 是不同 capability，不是一个易误传的布尔 flag。
- 写结果在用户源工作区之外生成；只有显式 apply 才能修改源工作区。
- worktree/checkout 负责改动隔离，OS sandbox 和 permissions 负责执行权限；两者不互相冒充。
- CLI 作为兼容适配器保留，但不再是 Codex Skill 的主入口。

## 已验证事实

### 本轮三个最小验证

1. **本地 MCP 插件链路通过**：在临时 `CODEX_HOME` 中，Codex 接受并安装带 `.mcp.json` 的本地插件；MCP server 完成 `initialize → tools/list → tools/call`，typed echo 调用成功。
2. **stdin 执行语义通过**：使用确定性 fake Claude，前台 JSON、后台 stream-json 分帧、结构化 budget failure、model/effort 参数全部保持；prompt 未进入 argv。
3. **脏工作区隔离通过**：staged、unstaged、untracked、删除和二进制状态可复制到隔离 worktree；源工作区 status 与内容不变；代理增量能从隔离基线重放。

一次性原型、临时 Codex home 和测试仓库已删除，未修改生产代码。

### Claude 方案审查

Claude Sonnet 5 使用 read-only review profile 审查了本设计与实施计划，结论为 `needs-attention`。本版已吸收两个 high findings：G1 从一次性开发验证升级为每次 write start 的 runtime preflight；worktree/clone 从阶段 4 的实现细节前移为 G3 backend selection gate。另吸收 service-stable 跨计划门禁、apply context drift 显式确认和 G1/G2/G3 分项估时。

该次请求指定 Sonnet，但 `effective_models` 还记录了少量 Haiku auxiliary usage。这证明“插件不自动选择 Haiku”不等于“上游运行时只会使用一个模型”；所有结果必须继续同时报告 requested 与 effective models。若“绝不调用 Haiku”成为硬约束，需要独立验证 Claude CLI 是否提供可执行的禁用机制，不能仅靠 profile 名称承诺。

### 当前代码事实

- 内部 Claude 启动已使用 Node `spawn(..., shell: false)`；真正的问题不是“Node 再开 Bash”，而是外层 Skill 通过 shell 调 CLI，以及 Claude review profile 仍向模型暴露受限 Bash adapter。
- `scripts/lib/process.mjs` 已支持 stdin，但 `claudeArgs()` 当前仍把 prompt 追加为 `-- <prompt>`。
- 后台 worker 当前使用 `stdio: ["ignore", "pipe", "pipe"]`，因此 stdin 迁移必须同时改前台和后台。
- `task --write` 当前只切换为 `--permission-mode acceptEdits`，没有隔离写工作区、patch ownership 或 apply/discard。
- Codex 插件 manifest 支持 `mcpServers: "./.mcp.json"`；本机官方插件也使用 Node stdio JSON-RPC server。
- Claude Code 2.1.208 本机 CLI 暴露 `--worktree`、`--settings`、`--setting-sources`、`--permission-mode`、`--safe-mode` 和 stdin text input。

### 官方运行时边界

- Claude worktree 只提供编辑隔离；非交互 `--worktree` 不会自动清理，必须由调用方管理。[Claude Code worktrees](https://code.claude.com/docs/en/worktrees)
- Claude sandbox 在 macOS 使用 Seatbelt，在 Linux/WSL2 使用 bubblewrap；默认 sandbox 不可用时可能降级，必须启用 `sandbox.failIfUnavailable=true`。[Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)
- `allowUnsandboxedCommands=false` 可关闭 Claude 的 sandbox escape hatch。[Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)
- permissions 与 sandbox 是互补层；Read/Edit deny 不等同于 Bash 的 OS 级隔离。[Claude Code permissions](https://code.claude.com/docs/en/permissions)

## 约束、惯例与待验证假设

| # | 因素 | 类型 | 设计处理 |
|---|---|---|---|
| 1 | 现有 CLI、Skill、job record 和前后台行为不能一次性破坏 | 真实约束 | 共享 service 上保留 CLI adapter，MCP 渐进切流 |
| 2 | 插件不自动选择 Opus/Fable/Haiku、retry、resume 或 fallback | 真实约束 | typed schema 只透传显式 override；审计 requested/effective models，上游 auxiliary model 不伪装成插件选择 |
| 3 | 写任务必须以 fail-closed 方式隔离 | 真实约束 | sandbox unavailable、baseline 不可复制或 apply 有冲突时直接失败 |
| 4 | 用户已有 staged/unstaged/untracked 状态不能丢失或被重新归属 | 真实约束 | 合成不可变 user baseline，代理 patch 只相对该 baseline 生成 |
| 5 | 真实模型验证会消耗配额 | 真实约束 | 默认测试使用 fake Claude；在线 smoke 独立授权 |
| 6 | CLI 是插件最稳定的公共 API | 可改变惯例 | MCP 成为主 API，CLI 退为兼容 adapter |
| 7 | `--worktree` 自带完整安全边界 | 已证伪假设 | worktree 只负责 edit isolation，必须叠加 sandbox/permissions |
| 8 | 统一 diff 文本不会包含用户旧内容 | 已证伪假设 | hunk context 可携带 baseline 内容；patch/log 按敏感 artifact 管理 |
| 9 | `--settings` 能完全覆盖用户/项目继承配置 | 待验证假设 | G1 建立已验证 CLI 版本 allowlist；每次 write start 重跑 preflight，版本或 policy hash 不匹配即 fail closed |
| 10 | 所有 Git 仓库都能复制为同等隔离基线 | 待验证假设 | 初版 fail closed：明确处理 submodule、sparse checkout、LFS、超大 untracked 文件 |

## 方案比较

| 机制 | 解决范围 | 主要失败模式 | 决策 |
|---|---|---|---|
| 保持 shell CLI + acceptEdits | 零迁移 | 无 typed contract；prompt 在 argv；直接写源工作区 | 拒绝 |
| CLI 改 stdin，写仍原地进行 | 低成本消除 argv 暴露 | 外层仍靠 shell；写失败半径不变 | 作为第一阶段，不是终局 |
| Typed MCP + Claude 自带 `--worktree` | 外层协议清晰、编辑隔离 | dirty state 不自动复制；非交互不清理；生命周期所有权不清晰 | 不直接采用 |
| Typed MCP + 插件管理隔离基线 + native sandbox | 协议、改动所有权、预览与执行边界闭合 | 实现复杂；sandbox 配置继承与 Git 边界需 fail-closed | **采用** |
| 每次任务进入容器/VM | 最强执行隔离 | 跨平台、凭证、性能、依赖和维护成本显著更高 | 强威胁模型的替代方案 |

## 最佳性检查

- **Fit criteria**：typed contract、prompt 最小暴露、源工作区零提前写入、fail-closed、兼容现有 jobs/profiles、可测试和可回滚。
- **Winner**：typed MCP + 共享应用服务 + stdin + 插件管理隔离写工作区 + Claude native sandbox/permissions；隔离 backend 默认使用无 hardlink/alternates 的 standalone clone，worktree 只有通过 G3 后才能在对应平台启用。
- **Closest alternative**：容器/VM 运行每个写任务。
- **Defeat condition**：若威胁模型包含恶意本机配置、需要隔离 Claude 主进程本身，或 native sandbox 不能排除继承配置扩大权限，容器/VM 更合适。
- **Marginal-gain stop**：初版不构建远程执行器、通用容器编排、任意 VCS adapter、自动依赖复制、自动 merge/commit/push 或跨 job patch stacking。

## 公共能力 Contract

MCP 工具按 capability 分离，避免一个 `write=true` 布尔值把只读操作升级为写操作：

```text
claude_review_changes
claude_task_readonly
claude_write_task_start
claude_job_status
claude_job_result
claude_job_cancel
claude_write_task_apply
claude_write_task_discard
```

方案审查落地后增加：

```text
claude_review_plan
```

公共输入原则：

- `workspace_root` 必须是绝对路径，经 `realpath` 和 Git root 校验；若 Codex MCP roots 可用且稳定，再增加 roots confinement。
- `model` 支持 `sonnet`、`opus`、`fable` 和完整 model id；`effort` 只允许 `low|medium|high`。
- profile、turns、soft budget、timeout 和 background 都是显式字段，不接收任意 CLI argv。
- write start 与 apply 是两个独立工具调用；普通 task 工具不存在 write 参数。
- tool result 使用稳定的 structured content，文本只作人类摘要。

CLI contract 暂不删除。CLI handler 与 MCP handler 都调用同一 application service，禁止 MCP server 反向 spawn `claude-companion.mjs`，否则只是把 shell 包装藏到 MCP 后面。

## Claude 子进程 Contract

用单一 builder 返回不可拆分的 invocation：

```js
{
  command: "claude",
  args: ["--print", "--output-format", "json", ...],
  stdin: renderedPrompt,
  cwd,
  env
}
```

不再让调用方分别调用 `claudeArgs()` 和手工处理 prompt。前台 `runCommand` 与后台 `runToLogs` 必须消费同一 invocation；任何测试捕获到 prompt 出现在 argv 都失败。

stdin 迁移不改变：

- output-format 与 stream-json framing；
- schema、model、effort、turns、budget、resume/continue；
- usage、cost、duration 和 structured failure；
- timeout、cancel 和 process-tree 终止语义。

## 隔离写生命周期

```text
preparing
  ├─ baseline failure ───────────────► failed
  ▼
running (Claude only sees isolated workspace)
  ├─ cancel/failure ────────────────► failed_or_cancelled → discard/expiry
  ▼
awaiting_apply (patch + fingerprint frozen)
  ├─ source changed/conflict ───────► apply_blocked
  ├─ explicit discard ──────────────► discarded → cleanup
  └─ explicit apply ────────────────► applied → cleanup
```

### Baseline

1. 找到并 `realpath` Git root，记录 source HEAD、status 与 baseline fingerprint。
2. 在插件 state root 下创建隔离工作区，不放入源仓库可见目录。默认 backend 是具有独立 object store、无 hardlink 和无 alternates 的 standalone clone。
3. 从 source HEAD 创建 checkout；复制 `git diff --binary HEAD` 表示的 tracked/staged/unstaged/deletion/binary 状态。只有 G3 在目标平台证明 source working tree 与 source `.git` 都不可写时，才允许用 worktree backend 优化性能。
4. 复制非 ignored untracked regular files 和 symlink 本身，不解引用 symlink；拒绝特殊文件、超额数量或超额字节。
5. 在隔离工作区建立 synthetic baseline commit；该 commit 只存在于隔离生命周期。
6. 记录 baseline tree/hash，但不把文件正文写入 job JSON 或事件日志。

初版不自动复制 ignored 文件、`.env`、凭证和依赖目录。需要 ignored build artifact 的项目必须显式配置安全 allowlist，或在后续独立设计 setup hook。

### Agent delta

Claude 结束后，插件 stage 隔离工作区的全部变化，并相对 synthetic baseline 生成 binary patch、changed-path manifest、mode/deletion metadata 和 SHA-256。patch 与日志权限为 `0600`。

“只包含代理增量”指语义上的 baseline→result 差异，不代表 patch 文本中看不到 baseline。统一 diff 的 hunk context 可能包含用户原始内容，因此：

- patch 不进入普通 status、事件日志或错误消息；
- result 默认只返回文件清单、统计和 patch hash；
- 只有 apply service 读取完整 patch；若未来提供 patch 导出，必须是显式能力。

### Apply

Apply 前必须：

1. 获取 workspace apply advisory lock。
2. 比较所有 agent-changed paths 在源工作区的当前 fingerprint 与启动时 baseline；任何冲突都进入 `apply_blocked`。
3. 比较 full baseline fingerprint。若只有 agent-untouched paths 漂移，首次 apply 返回 `context_drift_confirmation_required`，列出路径统计但不修改源工作区；用户必须使用同一 patch hash 显式 `allow_context_drift=true` 才能继续。
4. 执行 `git apply --check --binary`；失败时不修改源工作区。
5. 应用 patch 到 working tree，不自动 stage、commit、merge 或 push。
6. 再次计算 agent-changed paths 的结果 fingerprint，确认与隔离结果一致。
7. 标记 `applied` 后清理隔离 workspace；清理失败单独报告，不把已成功 apply 回滚为失败。

用户若在 job 运行期间修改了代理也修改的路径，apply 必须进入不可覆盖的 `apply_blocked`。只修改 agent-untouched paths 时，插件无法知道 Claude 是否读取并依赖过这些文件，因为当前没有可靠 read-set；显式二次确认承认这项语义风险，但不强制所有无关改动永久阻塞。插件不重试、不自动三方合并，保留 workspace 供用户 discard、重新运行任务或人工处理。

## Sandbox 与权限 Contract

写任务生成 job-local `settings.json`，至少要求：

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false
  }
}
```

实际 settings 还必须加入：

- `permissions.defaultMode=acceptEdits`，但 edit root 只能是隔离 workspace；
- sensitive path 的 `permissions.deny`；
- 必要的 sandbox `filesystem.denyRead/denyWrite`；
- 不允许任意 `excludedCommands`；
- 不扩大 source workspace、home credentials 或插件 state root 的写权限。

G1 必须验证 `--setting-sources` 与 `--settings` 的合并行为，证明 user/project/local settings 不会扩大 job policy，并将通过验证的 Claude CLI 精确版本、平台、policy schema version 和 policy hash 写入版本化 compatibility manifest。

每次 `claude_write_task_start` 在创建隔离 workspace 和 spawn Claude 之前都必须调用 `sandboxPolicy.preflight()`：

1. 读取当前 Claude CLI 版本与平台 prerequisite。
2. 生成 job-local settings 并核对 policy hash。
3. 要求当前版本存在于已验证 compatibility manifest。
4. 任一 mismatch 返回 `write_capability_unavailable`；MCP `tools/list` 可隐藏 write tools，但 write start 本身仍必须重复检查，避免会话期间版本变化。
5. 没有 CLI flag、环境变量或用户配置可以绕过该检查。

未证明前只能声称“纵深防御”，不能声称“强安全隔离”。若无法 fail-closed：

1. 初版 write MCP 保持 disabled/experimental；或
2. 将写任务迁移到独立容器/VM；
3. 不得静默退回原地 `acceptEdits`。

Read-only review 可继续使用现有 `plan` permission profile；移除内部 Bash adapter 属于后续 evidence-bundle 优化，不阻塞 typed MCP 和 stdin。

## 审计与状态

Job record 增加 additive 字段：

```text
transport: cli | mcp
operation
capability: read | review | isolated_write
source_workspace
isolated_workspace_id
baseline_fingerprint
patch_fingerprint
artifact_status: none | preparing | running | awaiting_apply | context_drift_confirmation_required | apply_blocked | applied | discarded | expired
sandbox_required
sandbox_verified
sandbox_policy_version
sandbox_policy_hash
write_capability_reason
context_drift_detected
```

不持久化 prompt、文件正文、patch 正文或敏感 settings 内容。旧 record 规范化为 null/default，record version 仅在字段语义无法 additive 兼容时升级。

## 与 plan-review 的关系

- plan target collector、prompt 和 schema 可以按原计划开发。
- application service 抽取完成前，不新增第二套执行路径。plan-review 的 service integration 必须等待阶段 2 的 `runtime-service-v1-ready` milestone：目标 commit 已落地、service contract tests 全绿、`npm run check` 通过，并在实施记录中写入 commit SHA。
- `claude_review_plan` 应直接调用共享 review service；不要先发布一个 shell-only Skill 再迁移。
- plan-review 的路由、model/effort、成本 envelope 和 subject metadata 保持原设计。
- MCP 基础层稳定后，现有 review 与 task Skills 改用 typed tools；CLI 示例继续用于人工和回退。

## 失败条件与回滚

- MCP 加载不稳定：Skills 退回 CLI adapter；共享 service 与 stdin 保留。
- stdin 出现 Claude 版本兼容问题：仅回滚 invocation transport，不回滚 MCP/service。
- write isolation 未通过安全门禁：隐藏/禁用 write MCP tools，保留 read/review MCP。
- apply 冲突率不可接受：不自动 merge，先增加冲突可观测性，再决定是否建设三方合并。
- sandbox 平台不支持：fail closed，并返回明确 prerequisite；不得自动 unsandboxed execution。

## 下一步验证

实施前最便宜且可能改变设计的检查是：

1. G1 验证 Claude 2.1.208 在 `--settings` + 受限 `--setting-sources` 下是否能排除 user/project/local 设置对 sandbox allowlist 的扩张，并分别确认 macOS 和 CI Linux 的 fail-unavailable 行为。
2. G3 同时对 standalone clone 与 worktree 执行 source working tree、source `.git/HEAD` 和 `.git/objects` 写入探针；standalone clone 是默认，只有 worktree 全部失败写入且 cleanup/performance 达标时才允许成为平台优化。

如果 G1 失败，typed MCP 和 stdin 仍继续实施，但 isolated-write 的安全执行层必须转向容器/VM或保持 experimental，不可按当前设计默认开启。如果 G3 的 worktree 探针失败，保持 standalone clone，不影响 write capability；只有两个 backend 都不能满足边界时才暂停 write。
