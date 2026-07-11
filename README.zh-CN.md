# cc-plugin-codex

简体中文 | [English](README.md)

`cc-plugin-codex` 让 Codex 能够把代码审查和项目任务委托给已登录的 Claude Code CLI。它是 `openai/codex-plugin-cc` 的反向配套插件：Codex 仍然负责编排，Claude Code 则作为本地子进程运行。

本插件没有运行时 npm 依赖。它要求 Node.js 18 或更高版本、支持插件的 Codex，以及已经完成认证且可以正常运行的 `claude` 命令。

插件提供八个技能：环境诊断、代码审查、对抗性审查、任务委托、会话移交、任务状态、结果读取和任务取消。

## 安装

先把本仓库加入个人 Codex marketplace，再安装插件：

```text
/plugin marketplace add <owner-or-path>/cc-plugin-codex
/plugin install cc-plugin-codex@personal
```

安装后重启 Codex，使技能和 hooks 重新加载。运行 `/claude-setup` 可检查 Node.js、Claude Code、认证访问、插件存储和可选 review gate 配置。setup 只做诊断，不会替你安装软件或登录 Claude Code。

开发源码时，可以直接在本仓库中运行：

```sh
node scripts/claude-companion.mjs setup
node scripts/claude-companion.mjs review
```

## 更新

刷新 marketplace、重新安装插件，然后重启 Codex：

```text
/plugin marketplace update personal
/plugin install cc-plugin-codex@personal
```

`.codex-plugin/plugin.json` 中的构建元数据后缀用于刷新本地缓存；公开版本的基础版本仍与 `package.json` 保持一致。

技能文案使用 `<PLUGIN_ROOT>` 表示由 agent 解析的插件安装根目录。它不是 shell 环境变量，因此命令既不依赖目标仓库，也不依赖插件缓存的版本化目录层级。`/claude-setup` 会输出实际插件根目录、skills 目录和 manifest 路径，便于诊断。

## 配置

任务默认使用只读的 Claude plan 模式。只有在确实需要 Claude 修改工作区时，才使用 `/claude-task --write`。常用参数包括 `--model`、`--max-turns`、`--max-budget-usd`、`--prompt-file`、`--resume`、`--continue`、`--fresh` 和 `--background`。

环境变量：

| 变量 | 默认值 | 用途 |
| --- | ---: | --- |
| `CLAUDE_COMPANION_MODEL` | 未设置 | task 默认 Claude 模型 |
| `CLAUDE_COMPANION_MAX_TURNS` | 未设置 | task 默认最大轮数 |
| `CLAUDE_COMPANION_MAX_BUDGET_USD` | 未设置 | task 默认预算上限 |
| `CLAUDE_COMPANION_REVIEW_BASE` | 未设置 | review 默认基准引用 |
| `CLAUDE_COMPANION_BACKGROUND_TIMEOUT_MS` | `3600000` | 后台任务最长运行时间 |
| `CLAUDE_COMPANION_STARTING_TIMEOUT_MS` | `60000` | starting 状态失效时间 |
| `CLAUDE_COMPANION_RETENTION_DAYS` | `30` | 已完成任务保留天数 |
| `CLAUDE_COMPANION_MAX_COMPLETED_JOBS` | `100` | 每个工作区保留的已完成任务数量 |
| `CLAUDE_COMPANION_REVIEW_GATE` | 未设置 | 覆盖 review gate 状态：`1`/`true`/`yes`/`on` 或 `0`/`false`/`no`/`off` |

运行时配置优先级为：CLI 参数、项目配置、用户配置、环境变量、内置默认值。项目配置位于 `.codex/cc-plugin-codex.json`；用户配置位于 `~/.codex/claude-companion/config.json`，也可以通过 `CLAUDE_COMPANION_CONFIG_FILE` 指定。两者都使用以下结构：

```json
{
  "task": { "model": "sonnet", "maxTurns": 8, "maxBudgetUsd": 5 },
  "review": { "base": "main" },
  "jobs": { "backgroundTimeoutMs": 3600000 }
}
```

Claude 启动前会拒绝未知 section、未知字段、无效 JSON 和非正数限制。写权限不能写入配置文件；每个可写任务仍必须显式传入 `--write`。

Codex 提供 `PLUGIN_DATA` 时，插件任务和配置存放在其中；直接运行脚本时，回退到用户的 Codex 数据目录。任务记录按工作区隔离，并采用原子写入。

只要 Claude CLI 提供相应字段，前台和后台完成结果都会输出 token 使用量、各模型使用量、总成本、turn 数、API 耗时和总耗时。JSON 结果额外提供跨模型的 `total_tokens` 汇总字段；旧版 CLI 缺少的数据会返回 `null`。

## Prompt 契约

Prompt 是 `prompts/` 下带版本的文件，不是藏在命令处理器里的字符串。模板只允许白名单变量：缺少变量或传入意外变量都会在 Claude 启动前失败。每个被追踪的任务都会保存模板名称、版本和 SHA-256 hash，便于审计实际使用的 prompt 契约。

review 和 Stop gate prompt 使用 `schemas/` 下的 JSON Schema。插件仍保留可读文本，但机器决策使用 Claude 的结构化输出。用户任务文本会被包装成不可信任务内容，绝不会被当作插件控制指令。

## 安全模型

- review、adversarial review、transfer 和默认 task 使用 Claude plan 模式及只读导向工具。
- 写权限必须通过 task 的 `--write` 显式开启，并使用 Claude `acceptEdits` 模式。
- 可选 Stop review gate 默认关闭。使用 `setup --enable-review-gate` 开启，在 Codex 中检查并信任该 hook；使用 `setup --disable-review-gate` 关闭。
- Claude 认证信息始终保留在 Claude Code 的凭据存储中；插件不会读取或保存凭据。
- 后台 prompt 请求文件仅文件所有者可读，由 worker 消费后立即删除。任务状态只保存元数据和最终结果。
- 取消操作会终止本插件创建的进程树。在进程树信号机制不同的平台上，这是 best-effort 行为。

## 后台任务

使用 `--background` 启动可追踪任务。后台 worker 消费 Claude 的 `stream-json` 事件，并报告 investigating、editing、verifying、retrying 和 finalizing 等阶段。例如：

```sh
node scripts/claude-companion.mjs task --background --write "Implement the change"
node scripts/claude-companion.mjs status --all
node scripts/claude-companion.mjs status <job-id> --wait --timeout-ms 300000
node scripts/claude-companion.mjs result
node scripts/claude-companion.mjs cancel
```

不传 ID 的 `status` 返回当前 Codex 会话的最新任务；`--all` 返回工作区完整历史。不传 ID 的 `result` 和 `cancel` 会选择当前会话中最新的适用任务。会话开始时会校正失效记录；会话结束时会清理过期的已完成记录，但绝不会终止仍在运行的任务。

## 平台支持

源码面向 macOS、Linux 和 Windows，并在 GitHub Actions 中使用 Node.js 22。macOS 和 Linux 运行完整行为测试；在 fake CLI fixture 替换为 Windows 原生可执行文件之前，Windows 只验证元数据和 JavaScript 语法。

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| macOS | 已在本地验证 | 支持完整源码测试和 Claude CLI E2E |
| Linux | CI 目标 | 需要本机已登录的 Claude Code CLI |
| Windows | 语法 CI 目标 | 已检查元数据和语法；行为 fixture 的可移植性仍待完善 |

CI 的行为覆盖当前验证 macOS 和 Linux。真实 Claude 调用仍依赖凭据和本机 Claude Code 行为，因此属于单独的认证 E2E 检查。

## 验证

运行自包含发布检查：

```sh
npm run check
```

它会检查 JavaScript 语法、元数据一致性、八个技能入口和完整 Node 测试套件。`node scripts/check.mjs --syntax-only` 只检查元数据和语法。

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
