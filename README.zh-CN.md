# cc-plugin-codex

简体中文 | [English](README.md)

`cc-plugin-codex` 让 Codex 通过 typed MCP 工具，把代码审查和项目任务委托给已登录的 Claude Code CLI。它是 `openai/codex-plugin-cc` 的反向配套插件：Codex 仍然负责编排，Claude Code 则作为本地子进程运行。

本插件没有运行时 npm 依赖。它要求 Node.js 18 或更高版本、支持插件的 Codex，以及已经完成认证且可以正常运行的 `claude` 命令。

插件提供九个技能：环境诊断、代码审查、方案审查、对抗性审查、任务委托、会话移交、任务状态、结果读取和任务取消。

## Typed MCP 工具

Codex 的唯一正常入口是 `.mcp.json` 声明的本地 stdio MCP server。12 个 typed tools 覆盖只读任务、代码/方案/对抗审查、隔离写任务启动、显式 apply/discard、显式 ID 的 job 生命周期、有界 job 列表和只读诊断。MCP server 通过稳定的 `#app/*` contract 调用 application service，不通过 shell，也不会 spawn CLI adapter。Prompt 通过 stdin 传给 Claude，不进入 argv。

Skills 负责发现、路由、客户端轮询和结果展示；MCP 不可用时不会自动切换传输。虽然 MCP 协议定义了 prompts/resources，但当前已验证的 Codex 产品面没有暴露 server prompts，因此 MCP prompts 不是工作流或安全依赖。

方案审查只接受仓库内一个 UTF-8 文件（最大 256 KiB），任务记录只保存文件标签和 SHA-256 指纹。可显式指定 `fable` 或 `claude-fable-5`；Skill 会把自然语言别名 `fable5` 规范化为后者。

## 设计参考

本项目参考了 [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
的产品思路。该项目让 Claude Code 用户调用 Codex 完成审查和委托任务；本项目
探索相反方向：由 Codex 继续负责编排，并把任务委托给用户本机的 Claude Code
CLI。

## 安装

先把本仓库加入个人 Codex marketplace，再安装插件：

```text
/plugin marketplace add <owner-or-path>/cc-plugin-codex
/plugin install cc-plugin-codex@personal
```

安装后重启 Codex，使技能和 hooks 重新加载。运行 `/claude-setup` 可检查 Node.js、Claude Code、认证访问、插件存储和可选 review gate 配置。setup 只做诊断，不会替你安装软件或登录 Claude Code。

开发源码或 MCP 故障恢复时，只使用受限 admin 入口：

```sh
node scripts/claude-admin.mjs doctor
node scripts/claude-admin.mjs mcp probe
```

旧 normal `claude-companion` CLI 已在迁移门禁通过后删除。正常操作只能通过 Skills 与 typed MCP 执行；admin 入口不能启动 review/task，也不能 apply artifact。

## 更新

刷新 marketplace、重新安装插件，然后重启 Codex：

```text
/plugin marketplace update personal
/plugin install cc-plugin-codex@personal
```

`.codex-plugin/plugin.json` 中的构建元数据后缀用于刷新本地缓存；公开版本的基础版本仍与 `package.json` 保持一致。

技能文案使用 `<PLUGIN_ROOT>` 表示由 agent 解析的插件安装根目录。它不是 shell 环境变量，因此命令既不依赖目标仓库，也不依赖插件缓存的版本化目录层级。`/claude-setup` 会输出实际插件根目录、skills 目录和 manifest 路径，便于诊断。

## 配置

任务默认使用只读 `standard` profile：Sonnet、medium effort、最多 8 turns、第 6 turn 开始收口、$1.50 软预算和 300 秒超时。只有在确实需要 Claude 修改工作区时才请求写任务。写任务会在独立 clone 中运行并停在 `awaiting_apply`，需要另一次明确 apply 才会修改源工作区。typed request 字段包括 `task_profile`、`model`、`effort`、`max_turns`、`finalize_at_turn`、`max_budget_usd`、`context`、`resume_session_id`、`continue_session` 和 `background`。

Task profile 是显式资源 envelope：

| Profile | 模型 | Effort | Max turns | 收口 turn | 软预算 | 超时 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| `quick` | Sonnet | low | 4 | 3 | $0.50 | 120s |
| `standard` | Sonnet | medium | 8 | 6 | $1.50 | 300s |
| `deep` | Opus | high | 16 | 12 | $5.00 | 900s |

插件不会根据 prompt 内容自动选择 deep 或 Opus。只有显式传入 `--task-profile deep` 或 `--model opus` 才会请求 Opus。`--model fable` 会原样透传，并可覆盖任一 task/review profile。插件不主动请求 Haiku，也不会传入 `--fallback-model`；Claude CLI 仍可能在内部选择辅助模型，插件会通过 `effective_models` 和 `model_usage` 如实展示。

环境变量：

| 变量 | 默认值 | 用途 |
| --- | ---: | --- |
| `CLAUDE_COMPANION_TASK_PROFILE` | `standard` | task 默认 profile：`quick`、`standard` 或 `deep` |
| `CLAUDE_COMPANION_TASK_EXECUTION_LEASE` | `off` | 启用持久 task 检查点与显式 typed resume |
| `CLAUDE_COMPANION_MODEL` | 未设置 | task 模型覆盖，包括 `sonnet`、`opus` 或 `fable` |
| `CLAUDE_COMPANION_EFFORT` | 未设置 | task effort 覆盖：`low`、`medium` 或 `high` |
| `CLAUDE_COMPANION_MAX_TURNS` | 未设置 | task 最大轮数覆盖 |
| `CLAUDE_COMPANION_FINALIZE_AT_TURN` | 未设置 | task 收口 turn 覆盖 |
| `CLAUDE_COMPANION_MAX_BUDGET_USD` | 未设置 | task 软预算覆盖 |
| `CLAUDE_COMPANION_TASK_TIMEOUT_MS` | 未设置 | task 墙钟超时覆盖 |
| `CLAUDE_COMPANION_REVIEW_BASE` | 未设置 | review 默认基准引用 |
| `CLAUDE_COMPANION_REVIEW_MODEL` | 未设置 | review 类命令的默认 Claude 模型 |
| `CLAUDE_COMPANION_REVIEW_PROFILE` | `standard` | 默认审查预算档位：`quick`、`standard` 或 `deep` |
| `CLAUDE_COMPANION_REVIEW_EVIDENCE_LEASE` | `off` | 启用实验性的单调用、MCP 有界 Review 取证路径 |
| `CLAUDE_COMPANION_BACKGROUND_TIMEOUT_MS` | `3600000` | 后台任务最长运行时间 |
| `CLAUDE_COMPANION_STARTING_TIMEOUT_MS` | `60000` | starting 状态失效时间 |
| `CLAUDE_COMPANION_RETENTION_DAYS` | `30` | 已完成任务保留天数 |
| `CLAUDE_COMPANION_MAX_COMPLETED_JOBS` | `100` | 每个工作区保留的已完成任务数量 |
| `CLAUDE_COMPANION_WRITE_ARTIFACT_TTL_MS` | `604800000` | 未 apply 的终态写 artifact 在 SessionStart 自动 discard 前的保留时间 |
| `CLAUDE_COMPANION_REVIEW_GATE` | 未设置 | 覆盖 review gate 状态：`1`/`true`/`yes`/`on` 或 `0`/`false`/`no`/`off` |

运行时配置优先级为：typed MCP 请求字段、项目配置、用户配置、环境变量、内置默认值。项目配置位于 `.codex/cc-plugin-codex.json`；用户配置位于 `~/.codex/claude-companion/config.json`，也可以通过 `CLAUDE_COMPANION_CONFIG_FILE` 指定。两者都使用以下结构：

```json
{
  "task": {
    "profile": "standard",
    "executionLeaseEnabled": false,
    "profiles": {
      "quick": { "model": "sonnet", "effort": "low", "maxTurns": 4, "finalizeAtTurn": 3, "maxBudgetUsd": 0.5, "timeoutMs": 120000 },
      "standard": { "model": "sonnet", "effort": "medium", "maxTurns": 8, "finalizeAtTurn": 6, "maxBudgetUsd": 1.5, "timeoutMs": 300000 },
      "deep": { "model": "opus", "effort": "high", "maxTurns": 16, "finalizeAtTurn": 12, "maxBudgetUsd": 5, "timeoutMs": 900000 }
    }
  },
  "review": {
    "base": "main",
    "model": "sonnet",
    "profile": "standard",
    "evidenceLeaseEnabled": false,
    "profiles": {
      "gate": { "model": "sonnet", "effort": "low", "maxTurns": 4, "finalizeAtTurn": 3, "evidenceUnits": 2, "evidenceMaxTurns": 6, "maxBudgetUsd": 0.2, "timeoutMs": 90000 },
      "quick": { "model": "sonnet", "effort": "low", "maxTurns": 6, "finalizeAtTurn": 4, "evidenceUnits": 3, "evidenceMaxTurns": 7, "maxBudgetUsd": 0.3, "timeoutMs": 120000 },
      "standard": { "model": "sonnet", "effort": "medium", "maxTurns": 12, "finalizeAtTurn": 9, "evidenceUnits": 5, "evidenceMaxTurns": 9, "maxBudgetUsd": 1, "timeoutMs": 240000 },
      "deep": { "model": "opus", "effort": "high", "maxTurns": 24, "finalizeAtTurn": 20, "evidenceUnits": 8, "evidenceMaxTurns": 12, "maxBudgetUsd": 3, "timeoutMs": 600000 }
    }
  },
  "jobs": { "backgroundTimeoutMs": 3600000 }
}
```

启用 Task Execution Lease 后，只读或隔离写 task 在触发 turn/cost 断路器时可返回
`checkpointed`，其中包含 session、已完成工作、剩余工作、验证信息、usage 与累计成本。
插件不会自动续跑；只有显式调用 `claude_task_resume` 并传入该 job ID 才会继续。
隔离写任务只能在原有且重新验证通过的 sandbox 中续跑，未完成时禁止 apply，只有收到
有效完成回执后才进入 `awaiting_apply`。模型、effort、profile、turn、预算、timeout 与
background 仍由调用方显式控制，不会自动 fallback 或扩大预算。

Claude 启动前会拒绝未知 section、未知字段、无效 JSON、非正数限制，以及超过内置安全上限的 review 配置。写权限不能写入配置文件；每个可写任务必须显式调用隔离写 tool，并在完成后显式 apply。

Codex 提供 `PLUGIN_DATA` 时，插件任务和配置存放在其中；直接运行脚本时，回退到用户的 Codex 数据目录。任务记录按工作区隔离，并采用原子写入。

只要 Claude CLI 提供相应字段，完成结果和结构化预算失败都会输出请求模型、实际模型、token 使用量、各模型使用量、总成本、turn 数、API 耗时和总耗时。结构化结果额外提供跨模型的 `total_tokens` 汇总字段；上游缺少的数据会返回 `null`。

task、result、review 和 adversarial-review 技能必须在面向用户的回复中回显这些指标。后台任务刚启动时还没有最终 usage；完成后通过 `claude-result` 获取。

## Prompt 契约

Prompt 是 `prompts/` 下带版本的文件，不是藏在命令处理器里的字符串。模板只允许白名单变量：缺少变量或传入意外变量都会在 Claude 启动前失败。每个被追踪的任务都会保存模板名称、版本和 SHA-256 hash，便于审计实际使用的 prompt 契约。

review 和 Stop gate prompt 使用 `schemas/` 下的 JSON Schema。插件仍保留可读文本，但机器决策使用 Claude 的结构化输出。用户任务文本会被包装成不可信任务内容，绝不会被当作插件控制指令。

审查 profile 会限制 turn、软预算和墙钟时间，但不会自动串行调用或 fallback 到其他模型。gate、quick、standard 请求 Sonnet；只有显式 deep review 请求 Opus。每次 review 必须报告已检查/跳过文件、不确定性、预算是否耗尽，以及需要时的定向 follow-up profile。小范围扫描使用 `quick`，日常审查使用 `standard`，安全、并发、迁移和核心状态机使用 `deep`。typed MCP 预算字段可以覆盖本次调用的 profile 默认值。

实验性的 Evidence Lease 路径默认关闭。启用后，每个 Review 只有一次 Claude 调用，且只暴露 `review_diff`、`review_file`、`review_context` 三个只读 MCP 工具；quick、standard、deep 分别获得 3、5、8 evidence units。额度归零时服务端实时把 phase 切为 `finalizing`，后续调用只返回不含新证据的结构化拒绝。`evidence_lease_exhausted` 表示正常停止调查，`cost_budget_exhausted` 与 `turn_limit_reached` 才是执行熔断。任何一种状态都不会自动 resume、retry、切换模型或追加预算。Review 的 `finalize_at_turn` 在 feature flag 关闭期间仅作为 deprecated 兼容提示保留。

Claude 的 `--max-turns` 限制 agentic turns，而上游返回的 `num_turns` 使用更宽的 usage 计数口径，因此数值可能更大。美元预算是 Claude CLI 可能略微超过的软目标；只有墙钟超时由插件强制作为硬执行上限。插件会保留两种 turn 数据和最终成本用于审计。

Evidence Lease 关闭时，大型 review 继续使用有界 manifest 与旧 diff adapter。启用后，diff 和补充上下文只能由 job-local evidence MCP 返回：每次响应最多 64 KiB，并通过 realpath 严格限制在工作区内。

`context=summary|diff|full` 声明发送的上下文粒度，不会暗中改写 prompt。显式只读续接只允许二选一：`resume_session_id` 或 `continue_session`；默认就是新任务，隔离写任务不支持 resume。结果和后台状态会返回简短披露摘要。`finalize_at_turn` 用于提示 Claude 在硬 turn 上限前开始停止扩展调查并收口。

## 安全模型

- 启用 Evidence Lease 的 review/adversarial review 会关闭全部 Claude 内置工具，使用精确 MCP allowlist，并从唯一空 control cwd 启动。feature-off 兼容路径和默认只读 task 保持原有 plan-mode 行为。
- 写权限必须通过 task 的 `--write` 显式开启，并先通过精确 Claude 版本、平台、策略 hash 和 canonical executable hash 的 sandbox preflight；Claude `acceptEdits` 只在独立 standalone clone 中运行。
- 成功写任务只生成 owner-only patch artifact 并停在 `awaiting_apply`。Apply 不会 stage、commit、merge 或 push；重叠路径漂移会硬阻断，非重叠漂移需要携带相同 patch hash 再次确认；discard 会删除 artifact 和隔离工作区。如果 apply 已开始但无法验证结果，任务进入 `recovery_required`：插件不自动回滚或清理，必须人工检查保留的 artifact。
- 可选 Stop review gate 默认关闭。只有用户明确要求时才通过 `claude-companion-admin review-gate enable|disable` 修改；该 break-glass 入口在 MCP 不可用时仍可工作。gate 使用独立预算（默认 4 turns、$0.20、90 秒），并缓存 30 分钟内未变化的 verdict，避免重复 Stop 反复调用模型。
- Claude 认证信息始终保留在 Claude Code 的凭据存储中；插件不会读取或保存凭据。
- 后台 prompt 请求文件仅文件所有者可读，由 worker 消费后立即删除。任务状态只保存元数据和最终结果。
- 取消操作会终止本插件创建的进程树。在进程树信号机制不同的平台上，这是 best-effort 行为。

## 后台任务

通过相应 Skill/MCP tool 请求后台执行。后台 worker 消费 Claude 的 `stream-json` 事件，并报告 investigating、editing、verifying、retrying 和 finalizing 等阶段。`claude_jobs_list` 默认只返回有界的工作区历史；global 和 filters 必须显式请求。status、result、cancel、apply、discard 都必须提供 job ID，不再存在隐式 latest。等待由客户端有界轮询 `claude_job_status`，server 不持有长轮询。会话开始时会校正失效记录；会话结束时会清理过期的已完成记录，但绝不会终止仍在运行的任务。

MCP 无法启动时，`claude-companion-admin` 只允许 doctor/probe、review-gate 控制、job list/reconcile/cancel、artifact inspect/安全 discard；不能启动 review/task，也不能 apply artifact。`partial_apply` 永远需要人工恢复，不能自动 discard。

终态 phase 与状态保持一致：`done`、`failed`、`cancelled`、`timed_out`。Claude 的 `error_max_turns` 等原始错误 subtype 会被保留并映射为稳定错误类型、恢复建议和可用的 resume session。Resume 始终需要显式触发；当后台 resume 能关联到历史任务时，status/result JSON 会显示 `parent_job_id` 和 `cumulative_chain_cost_usd`，插件不会自动 resume 或重试。旧版任务只在读取时归一，并标记为 `legacy-partial`，不会回写历史文件。

## 平台支持

源码面向 macOS、Linux 和 Windows，并在 GitHub Actions 中使用 Node.js 22。macOS 和 Linux 运行完整行为测试；在 fake CLI fixture 替换为 Windows 原生可执行文件之前，Windows 只验证元数据和 JavaScript 语法。

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| macOS | Claude 2.1.208 写入已验证 | Seatbelt + compatibility manifest；其他版本 fail closed |
| Linux | read/review 为 CI 目标；write 默认不可用 | write 需要 bwrap+socat 及验证后的 manifest 条目 |
| Windows | read/review 语法 CI；write 不支持 | 初版不承诺 native write sandbox |

CI 的行为覆盖当前验证 macOS 和 Linux。真实 Claude 调用仍依赖凭据和本机 Claude Code 行为，因此属于单独的认证 E2E 检查。

## 验证

运行自包含发布检查：

```sh
npm run check
```

它会检查 JavaScript 语法、元数据一致性、九个技能入口和完整 Node 测试套件。`node scripts/check.mjs --syntax-only` 只检查元数据和语法。

## 故障排查

- **找不到 `claude`：** 安装 `@anthropic-ai/claude-code`，确认它位于 `PATH` 中，然后重新运行 `/claude-setup`。
- **Claude 报告认证失败：** 交互式运行 `claude` 并完成登录。插件不能代替你登录。
- **Codex 无法访问 Claude 凭据：** 自动审批模式下，如果已知 workspace 边界会阻止 Claude，skill 会直接发起可升级权限的工具调用，不会先要求你确认；完全访问模式下则直接执行，不申请 escalation。workspace sandbox 且禁止审批时无法读取外部凭据存储，应切换权限配置而不是重复尝试。手动审批模式只有在确实需要 escalation 时才会弹出确认。如果 host policy 拒绝仓库内容外发，只有权限配置或 host authorization 实际变化后才应重试；仅在对话中表示同意并不会改变该边界。
- **任务似乎卡住：** 运行 `/claude-status <id> --wait --timeout-ms ...`。SessionStart 校正也会标记死亡、失效或超时任务。
- **review 没有包含 diff：** 大型变更会提供改动文件清单，而不是直接注入过大 diff；Claude 可以使用只读工具检查文件。
- **更新后 skill 没有变化：** 重新安装插件并重启 Codex；marketplace cache 使用 manifest 版本作为 key。

## 卸载

先关闭可选 gate，再卸载插件并重启 Codex：

```text
/claude-setup --disable-review-gate
/plugin uninstall cc-plugin-codex@personal
```

卸载插件不会删除 Claude Code 或其认证信息。如果不再需要，可以单独删除插件数据目录中持久化的任务历史。

## 许可证

Apache-2.0。参见 `LICENSE` 和 `NOTICE`。
