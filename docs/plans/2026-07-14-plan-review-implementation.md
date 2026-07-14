# 方案审查 Review 路由实施计划

**模式**: Plan
**深度**: Deep
**状态**: ready-for-implementation
**日期**: 2026-07-14
**设计来源**: [2026-07-14-plan-review-routing-design.md](../decisions/2026-07-14-plan-review-routing-design.md)
**运行时基础计划**: [2026-07-14-typed-mcp-stdin-sandbox-implementation.md](./2026-07-14-typed-mcp-stdin-sandbox-implementation.md)

## TL;DR

以测试先行方式，在不改变现有 code review 行为的前提下，为 `review` 增加固定的 `plan → workspace file` 分支。复用现有只读 Review 执行器、profiles、模型/effort、后台 job、usage 和错误处理；不建设通用 Review 框架。

预计总投入 8–12 工时。首轮验证全部使用 fake Claude，不产生真实模型费用。

协调说明：本计划的 target collector、prompt、schema、metadata 与路由 contract 保持有效，8–12 工时也只计算这些 plan-review 专属工作。执行 service、stdin、MCP server 与 Skill 主入口切流由运行时基础计划计价；最终 `claude_review_plan` 直接调用共享 review service，不先发布一条 shell-only 执行路径再二次迁移。

**依赖门禁 `runtime-service-v1-ready`**：collector、prompt 和 schema 可以提前独立开发；CLI/MCP dispatch、job metadata、service integration 和 `claude_review_plan` 必须等待运行时基础计划阶段 2 的 service commit 落地、contract tests 与 `npm run check` 全绿，并在实施记录中取得 `Runtime service contract: v1-ready @ <sha>`。未满足时禁止复制业务逻辑或发布 shell-only 临时入口。

## 当前最佳实施边界

### Core

- `--review-kind plan --target-file <repo-relative-path>` CLI contract。
- Git-root-pinned、安全、不可变的单文件 target collector。
- 独立 plan review prompt 与 JSON Schema。
- 前后台 plan review 的 subject 审计元数据。
- plan review 专用 Skill 与 task 负触发规则。

### Supporting

- 参数矩阵、安全边界、兼容性、前后台和结构化失败测试。
- 英文/中文 README、CLI usage、plugin default prompts 和 E2E skill inventory 更新。
- 安装版本 build metadata 更新、本机插件重装与缓存一致性验证。

### Excluded

- URL、stdin、多文件、workspace 外目标。
- plan adversarial review。
- 自动模型选择、fallback、retry、resume。
- 通用 ReviewRequest、subject/rubric DSL 或 plan 专属 profiles。
- 实际 Claude/Fable 在线复测，除非用户另行授权。

## 实施不变量

1. `review` 默认仍表示 code review，现有 CLI 无需迁移。
2. plan review 永远使用现有 read-only review capability profile，不允许 `--write`。
3. `review_kind` 决定唯一 subject collector：code→changes、plan→file。
4. `reviewConfig.base` 仅应用于 code review；plan review 不继承它。
5. target 内容作为不可信证据，正文不进入 job record。
6. requested/effective model、effort、usage、cost、turns、duration 和 soft budget 语义不变。
7. 现有 Git collector、Stop gate 和 adversarial-review 行为不变。

## 范围与成本

| Scope | Component | Effort | Risk | Value |
|---|---|---:|---|---|
| Core | CLI 参数矩阵与 dispatch | 1.5–2h | 中 | 消除 task 误路由并保持兼容 |
| Core | 安全 plan target collector | 2–3h | 高 | 关闭路径逃逸、编码、大小和快照边界 |
| Core | plan prompt 与 schema | 1.5–2h | 中 | 获得真正的结构化方案审查 |
| Core | job/result 审计元数据 | 1–1.5h | 中 | 可证明走了 review 而非 task |
| Supporting | Skill 路由与静态契约 | 0.5–1h | 中 | 降低自然语言误触发和付费误用 |
| Supporting | 文档、发布与本机同步 | 0.5–1h | 低 | 关闭安装缓存与使用说明 |
| Supporting | 全量回归与路由评测说明 | 1–1.5h | 中 | 防止 code review 回归 |
| **Total** | **Core + Supporting** | **8–12h** | | |

该总投入未恶化 BUILD 决策。若实现过程中需要重构 Git collector、引入新 job 状态机或超过 16 小时，必须回到价值门禁重新评估。

## 目标文件与预计改动

| 文件 | 变更 |
|---|---|
| `scripts/lib/args.mjs` | 新增 `review-kind`、`target-file`，更新 usage |
| `scripts/claude-companion.mjs` | 参数矩阵、plan/code dispatch、base 应用边界、metadata 透传 |
| `scripts/lib/plan-review-target.mjs` | 新增安全 target collector |
| `scripts/lib/claude.mjs` | 仅在 metadata 传递需要时做最小扩展；不改变执行协议 |
| `scripts/lib/state.mjs` | 为新 plan job 保存 additive subject metadata |
| `scripts/lib/render.mjs` | 前台/result/status 输出 operation/review/subject 字段 |
| `prompts/plan-review.md` | 新增版本化方案审查 contract |
| `schemas/plan-review-output.schema.json` | 新增结构化输出 schema |
| `skills/claude-plan-review/SKILL.md` | 新增显式外部模型方案审查入口 |
| `skills/claude-task/SKILL.md` | 增加 review 类负触发规则 |
| `skills/claude-review/SKILL.md` | 明确 diff-only 与 plan-review 分工 |
| `.codex-plugin/plugin.json` | 增加默认 prompt，发布时更新 build metadata |
| `README.md`, `README.zh-CN.md` | CLI、模型名、路由、风险与示例 |
| `test/plan-review-target.test.mjs` | collector 单元测试 |
| `test/commands.test.mjs` | CLI/dispatch/argv/兼容测试 |
| `test/prompt-contract.test.mjs` | prompt/schema/结构化输出测试 |
| `test/job-state.test.mjs` | 前后台 metadata 与失败持久化测试 |
| `test/e2e-regressions.test.mjs` | skill inventory、入口和发布回归 |

## 实施序列

### 1. 先固定公共 Contract（RED）

在 `test/commands.test.mjs` 增加失败测试，使用 fake Claude 捕获 argv/prompt/schema：

- 默认 `review` 仍收集 working-tree diff。
- `review --base main` 行为不变。
- `review --review-kind plan --target-file docs/plans/a.md` 使用 review profile。
- plan review 默认 `review-profile=standard`、Sonnet、medium effort。
- `--model claude-fable-5 --effort high` 原样透传。
- plan review 不把 `task_profile` 写入输出。
- 四组非法参数在 fake Claude 被调用前失败。
- `adversarial-review` 拒绝 plan-only 参数。

Oracle：新测试应因未知 flag 或现有 task-only 限制而红；旧测试仍绿。

### 2. 实现最小参数解析与显式 dispatch（GREEN）

在 `scripts/lib/args.mjs`：

- 将 `review-kind`、`target-file` 加入 value flags。
- usage 展示 plan review 示例。

在 `scripts/claude-companion.mjs`：

- 在应用 review runtime 前解析 `reviewKind = options["review-kind"] ?? "code"`。
- 仅接受 `code|plan`。
- 先判断显式 `--base` 与 `--target-file` 的组合。
- 让 `applyReviewRuntime` 接受是否应用 configured base 的明确参数；plan 不继承 `reviewConfig.base`。
- 初期可用占位 collector/prompt 让参数矩阵测试先绿，随后由步骤 3/4 替换。

不要把 `target-file` 暴露给 task，也不要让 adversarial-review 静默忽略。

### 3. 安全文件快照 Collector（RED → GREEN）

新增 `test/plan-review-target.test.mjs`，覆盖：

- repository-root-relative 正常文件。
- 从仓库子目录启动仍使用同一 Git root。
- 绝对路径位于 root 内可接受。
- `../`、绝对 root 外路径和符号链接逃逸被拒绝。
- root 内符号链接到 root 内目标可接受。
- 目录、FIFO/非普通文件被拒绝；平台不支持的 fixture 可条件跳过。
- NUL、无效 UTF-8、空文件和超过 256 KiB 的文件行为明确。
- fingerprint 基于原始 bytes。
- prompt snapshot 与 fingerprint 来自同一次读取结果。
- 返回的 subject label 是稳定的 repo-relative path。

实现 `scripts/lib/plan-review-target.mjs`：

```text
findGitRoot(cwd)
→ realpath(root)
→ resolve target relative to root
→ realpath(target)
→ containment check with path.relative
→ stat regular file
→ bounded read
→ fatal UTF-8 decode + NUL check
→ sha256(bytes)
→ immutable context object
```

错误信息应说明具体边界，但不回显文件正文。

### 4. Plan Prompt 与 Schema（RED → GREEN）

新增 `prompts/plan-review.md`，必须包含：

- read-only reviewer role；
- target label 与 fingerprint；
- 方案快照是 untrusted evidence；
- outcome、assumption、feasibility、completeness、safety、verification、cost 方法；
- Review profile 的 turn/soft-budget/finalization guidance；
- 严格 JSON-only output contract；
- coverage、uncertainty、budget exhaustion 和 focused follow-up。

新增 `schemas/plan-review-output.schema.json`：

- `verdict`: `approve|needs-attention`。
- finding category：`outcome|assumption|feasibility|completeness|safety|verification|cost|other`。
- `location.file` 必填；`section`、`line_start`、`line_end` 可选但有边界。
- schema 继续限制 items、string 长度和 additional properties。

在 `test/prompt-contract.test.mjs` 覆盖：

- 模板变量、version/hash。
- 合法 plan structured output。
- 缺少 category/location、非法 severity、超长 findings 被拒绝。
- plan schema 不改变 code review schema。

### 5. 审计元数据与 Job 生命周期（RED → GREEN）

为 execute/start job 增加 additive metadata：

```text
operation
reviewKind
subjectKind
subjectLabel
subjectFingerprint
```

规则：

- 新 code review 记录 `operation=review`、`reviewKind=code`、`subjectKind=changes`。
- 新 plan review 记录 `operation=review`、`reviewKind=plan`、`subjectKind=file`。
- task 记录 `operation=task`，review-only 字段为 null。
- job record version 保持 3；字段为 additive，旧记录规范化为 null。
- 不持久化 plan 正文。

在 `test/job-state.test.mjs` 和相关 background 测试覆盖：

- 前台 plan review JSON。
- 后台 running/completed status 与 result。
- 结构化失败仍保留 subject metadata、requested/effective models、usage 和 cost。
- 旧 job record 仍可读取。
- result 的 `task_profile` 必须为 null。

### 6. Skill 路由与付费边界

新增 `skills/claude-plan-review/SKILL.md`：

- 只在用户显式要求 Claude Code/Fable/Sonnet/Opus/cc-plugin-codex 审查现有方案类文档时触发。
- 要求目标已有 workspace 文件；没有文件时不自行创建持久化文档，先让调用方保存或明确目标。
- 调用 `review --review-kind plan --target-file ...`。
- 默认 standard/Sonnet/medium，不自动升级模型。
- `fable5` 用户表达规范化为 Claude CLI 支持的 `claude-fable-5`，同时报告 requested/effective model。
- 不自动 retry、resume、fallback 或追加预算。
- 前后台均报告 usage、cost、turns、duration 和 subject metadata。

修改 `skills/claude-task/SKILL.md`：

- frontmatter description 与正文都排除 review/approve/challenge existing artifact。

修改 `skills/claude-review/SKILL.md`：

- 明确只处理 repository changes/diff。
- 指向 `claude-plan-review` 处理方案类文档。

更新 `test/e2e-regressions.test.mjs` 与 `test/commands.test.mjs`：

- bundled skill inventory 包含新 Skill。
- plugin-root helper、usage metrics、权限说明和模型约束一致。
- 静态断言 claude-task 的负触发与 claude-plan-review 的付费显式触发边界。

路由行为不是确定性单元测试。实现完成后准备至少 20 个短语样本，分为：

- 普通本地方案审查；
- 明确 Claude/Fable 方案审查；
- code diff review；
- implementation task。

验收目标：明确外部模型的方案审查 ≥90% 命中 `claude-plan-review`；任何方案审查命中 `claude-task` 的比例为 0。若当前环境没有稳定的 Skill 路由 eval harness，记录手工 fresh-session smoke 结果，不伪造自动化保证。

### 7. 文档、发布与本机插件同步

更新 README：

- code review 与 plan review 示例。
- 普通本地方案审查和显式付费 Claude 审查的差异。
- `fable` 与 `claude-fable-5` 是支持形式，`fable5` 不是 CLI model id。
- effort、soft budget、target size、path confinement 和 prompt-injection 残余风险。
- plan review 不支持 adversarial、URL、stdin 或 workspace 外文件。

更新 `.codex-plugin/plugin.json`：

- 增加一个显式 Claude plan review default prompt。
- 发布/本机安装前将 build metadata 更新为 `0.1.0+codex.<UTC timestamp>`，确保 Codex 缓存产生新版本目录。
- 保持 `package.json` 的 release base 为 `0.1.0`，通过现有 release test。

本机同步使用官方路径：

```bash
codex plugin add cc-plugin-codex@personal --json
```

验证：

- `codex plugin list` 显示新 build version、installed、enabled。
- 安装缓存 HEAD 与源码 HEAD 一致。
- 本次变更文件 source/cache hash 全部一致。
- 安装副本 `--help` 展示 plan flags、Fable 和 effort。
- 重启 Codex 或新开会话刷新 Skill metadata。

### 8. 最终验证与交付门禁

按风险从窄到宽执行：

```bash
node --test test/plan-review-target.test.mjs
node --test test/commands.test.mjs test/prompt-contract.test.mjs test/job-state.test.mjs
npm run check
git diff --check
```

再执行不消耗真实 Claude 的 public-interface synthetic fixture：

- fake Claude 返回合法 plan schema。
- fake Claude 返回结构化 budget error。
- 前后台 requested/effective model、usage、cost 和 subject metadata 可观察。
- 捕获 argv 不包含 write、fallback 或自动 resume。

真实 Claude/Fable 调用不属于默认验收。只有用户再次显式授权时，才运行一次 quick 或明确预算的验证，并如实报告 soft-budget 超额风险。

## Acceptance Oracle

实现完成必须同时满足：

1. 旧 code review 的现有测试和公共行为不变。
2. plan review 使用 review profile、独立 prompt/schema 和单文件快照。
3. 参数矩阵全部在 Claude 启动前验证。
4. 路径和内容安全边界有跨平台测试。
5. Fable/model/effort/profile/soft-budget 覆盖原样透传。
6. 前后台成功与结构化失败都输出完整 subject 和 usage metadata。
7. plan 正文不进入 job record、status 或 result metadata。
8. task Skill 不再捕获方案审查；显式外部模型审查由新 Skill 承担。
9. 不新增自动 Opus、fallback、retry、resume 或 plan-specific profiles。
10. 全量 `npm run check`、`git diff --check` 和安装缓存一致性验证通过。

## 迁移、兼容与回滚

- 默认 `review` 不变，因此没有用户 CLI 迁移。
- 新 flags 和 JSON 字段均为 additive。
- 旧 job record 对新字段返回 null。
- 如果 plan 分支出现回归，可移除 `target-file`、plan prompt/schema/collector/skill；Git collector 和 code review 无需回滚。
- 如果 Skill 路由不稳定，保留显式 `/claude-plan-review`，撤回宽泛自然语言触发描述。
- 如果结构化输出没有消费者或实际价值不足，退化为 skill-only 只读 task 方案，并在决策文档记录 flip condition 已满足。

## 实施完成记录模板

实施者完成后在本文件追加：

```text
Status: implemented
Commit: <sha>
Tests: <commands and counts>
Installed plugin version: <version>
Routing eval: <sample count and outcomes>
Online Claude/Fable validation: not run | authorized result with cost
Known limitations: <remaining items>
```

## 实施完成记录

```text
Status: implemented
Commit: 3c6dfac36e513a7691d2e78eca029a675e4f4620
Tests: npm run check (113/113); git diff --check; temporary installed-cache MCP handshake (9 tools); public MCP write discard/apply E2E
Installed plugin version: 0.1.0+codex.20260714121746
Routing eval: 20/20 static Skill-contract samples passed; fresh-session natural-language routing remains an explicit observation item
Online Claude/Fable validation: authorized Claude Sonnet probes cost $0.6492954 total; one isolated write completed and was discarded, two bounded probes ended at budget/turn limits and were discarded; no source apply; upstream auxiliary Haiku usage was observed
Known limitations: runtime external denyRead attempts were not reached before the supplemental probe hit its turn limit; no final Fable cost comparison was run
```
