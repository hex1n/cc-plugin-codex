# 方案审查路由与 Review 扩展设计

**模式**: Decision
**深度**: Deep
**状态**: accepted-for-implementation
**日期**: 2026-07-14
**关联实施计划**: [2026-07-14-plan-review-implementation.md](../plans/2026-07-14-plan-review-implementation.md)
**运行时基础**: [2026-07-14-typed-mcp-stdin-sandbox-design.md](./2026-07-14-typed-mcp-stdin-sandbox-design.md)

## TL;DR

方案审查不再借用 `task`。保留现有 Review 执行器，只增加一个受约束的 `plan` 分支：

```text
review-kind=code → Git changes
review-kind=plan → workspace 内的单个方案文件快照
```

`subject_kind` 由 `review_kind` 派生，不开放任意组合。普通“审查方案”仍由本机通用 `plan-review` 处理；只有用户明确要求 Claude Code、Fable、Sonnet、Opus 或 cc-plugin-codex 时，才触发付费的 `claude-plan-review`。

## 决策信封

```yaml
decision: BUILD
target_outcome: 外部模型方案审查进入真正的只读 Review 协议，不再误走 task
baseline_and_frequency: 已观察到方案审查被 claude-task 捕获；一次 Fable 5 方案审查经 task 消耗 $1.086243 和 135098 tokens，且未返回正式结果
expected_benefit: 消除已知误路由，避免 task 的执行/plan-mode 行为，获得结构化审查与可审计成本；美元节省幅度待实现后测量
delivery_and_maintenance_cost: 预计 8–12 工时；不新增执行器或状态机，持续维护约为一个 collector、prompt、schema 和 skill
status_quo_or_existing_mechanism: 修改 skill 文案并继续通过只读 task 审查方案
decision_flip_condition: 如果结构化结果、审计字段和 Review 权限边界没有实际消费者，则退化为 skill-only 修复
review_scope: implementation-authorization
review_budget: 首轮只使用 fake Claude 和本地测试；任何真实 Claude/Fable 复测必须再次显式授权
```

## 根问题

当前 `review` 同时表示两件事：

1. 执行的是“评价已有成果”的审查操作。
2. 输入一定来自 Git diff。

因此，当审查对象是方案、PRD、设计或规格文件时，Skill 路由只能落入能够接收任意文本的 `task`。这不是模型选择问题，而是操作语义与输入来源被错误绑定。

已解决的结果应当是：

- “实施方案”仍走 task。
- “审查方案”走 review。
- 是否调用付费外部模型由用户意图决定。
- 模型、effort 和资源 envelope 与审查对象保持正交。
- 前后台结果能证明本次调用究竟走了 task 还是 review。

## 证据

### 已验证

- Review 执行器能够承载任意 prompt、`claude-fable-5`、effort、turns、soft budget 和 JSON Schema。
- 当前 `review --prompt-file ...` 在 dispatch 层被拒绝，错误为 `These runtime options are only supported by task`。
- Review 相关最小回归测试 27/27 通过。
- Claude Code 2.1.208 接受 `fable` 或完整名称 `claude-fable-5`；`fable5` 不是有效模型标识。
- 一次通过 task 执行的 Fable 5 方案审查在 5 turns 后达到 `$1` 软预算，实际成本 `$1.086243`、135,098 tokens、98.1 秒；模型产出了内部 plan artifact，但 job 以 `max_budget` 失败，没有正式结果。
- Fable 5 对初版设计给出有条件通过，并提出参数矩阵、路由评测和 Git-root 路径边界三项 needs-attention finding；本设计已吸收。

### 未验证

- 方案审查改走 Review 后的实际 token/美元节省幅度。
- Codex 自然语言 Skill 路由在不同会话和模型下的准确率。
- 256 KiB 文档上限是否需要根据真实方案规模调整。

这些未知不阻止最小实现，但决定后续是否扩展或退化为 skill-only 方案。

## 约束与假设

| # | 因素 | 类型 | 处理 |
|---|---|---|---|
| 1 | 现有 `review` 和 `review --base` 必须兼容 | 真实约束 | 默认 `review-kind=code`，现有参数与输出不变 |
| 2 | Review 必须保持只读 | 真实约束 | 继续使用现有 review capability profile，不开放 write |
| 3 | 不自动选择 Opus/Fable、retry、resume 或 fallback | 真实约束 | 只透传用户显式覆盖 |
| 4 | 文件边界必须独立于启动子目录 | 真实约束 | 以真实 Git root 为唯一 confinement root |
| 5 | 普通本地方案审查不应自动产生外部模型费用 | 真实约束 | 仅显式 Claude/Fable 意图触发插件 Skill |
| 6 | `review_kind` 与 `subject_kind` 需要完全正交 | 已证伪假设 | 初版固定 code→changes、plan→file，不构建交叉积 |
| 7 | Skill 路由可用布尔单测保证 | 已证伪假设 | 使用静态契约测试加多样本路由评测 |
| 8 | soft budget 是硬停止线 | 已证伪假设 | 继续明确为 soft target，真实成本可能超额 |

## 方案比较

| 方案 | 优点 | 失败模式 | 决策 |
|---|---|---|---|
| 保持现状 | 零实现成本 | 方案审查继续误走 task，语义、输出和成本不可控 | 拒绝 |
| 人工约定使用低成本 task | 实现约 0–2h | 仍无 Review schema、审计字段和确定权限边界 | 仅作临时回退 |
| 新建独立 `plan-review` 执行器 | 入口清晰 | 复制 profile、budget、job、usage 和 error plumbing | 拒绝 |
| 现有 Review 执行器增加固定 plan 分支 | 复用运行时，语义正确，改动可控 | dispatch 条件变多，需严格参数矩阵 | 采用 |
| 通用 subject×rubric Review 框架 | 理论扩展性强 | 当前只有两个固定组合，抽象成本和非法状态过多 | 推迟 |

## 最佳性检查

- **Fit criteria**：路由正确、只读安全、成本显式、结构化输出、向后兼容、最小维护面。
- **Winner**：现有 Review 执行器增加固定 `plan → file` 分支，并提供精确的付费外部审查 Skill。
- **Closest alternative**：skill-only 修复，继续调用只读 task。
- **Defeat condition**：若结构化结果和审计元数据没有实际消费者，skill-only 的 2 小时实现更经济。
- **Marginal-gain stop**：初版不增加 URL、stdin、多个文件、自动分类、通用 rubric DSL 或新的 profile 表。

## 公共 CLI Contract

### 现有代码审查

```bash
claude-companion review
claude-companion review --base main
```

等价于：

```text
review-kind=code
subject-kind=changes
```

### 方案审查

```bash
claude-companion review \
  --review-kind plan \
  --target-file docs/plans/example.md \
  --review-profile standard
```

模型和资源仍可显式覆盖：

```bash
claude-companion review \
  --review-kind plan \
  --target-file docs/plans/example.md \
  --model claude-fable-5 \
  --effort medium
```

不复用 task 的 `--prompt-file`：task prompt 是待执行意图；review target 是不可信证据。

### 参数矩阵

| Review kind | `--base` | `--target-file` | 数据收集 |
|---|---:|---:|---|
| 默认/code | 可选 | 禁止 | Git diff |
| plan | 禁止 | 必填 | 单文件不可变快照 |

以下组合在 Claude 启动前失败：

- `plan` 缺少 `--target-file`。
- `plan` 同时传入显式 `--base`。
- `code` 传入 `--target-file`。
- 未知 `--review-kind`。
- `adversarial-review` 传入 plan-only 参数；初版 adversarial review 仍只支持 diff。

`reviewConfig.base` 只在 code review 中应用。plan review 忽略 code-only 的配置默认值，但用户显式传入 `--base` 仍报错。

## 最小内部设计

不重构现有 Git collector，也不引入通用 ReviewRequest 框架。

新增：

```text
scripts/lib/plan-review-target.mjs
prompts/plan-review.md
schemas/plan-review-output.schema.json
skills/claude-plan-review/SKILL.md
```

Dispatch 保持显式分支：

```js
if (reviewKind === "plan") {
  context = await collectPlanReviewTarget({ cwd, targetFile })
  prompt = await planReviewPrompt(context, options)
  schema = schemaPath("plan-review-output")
} else {
  context = await collectReviewContext({ cwd, base: options.base })
  prompt = await reviewPrompt(context, options)
  schema = schemaPath("review-output")
}

return execute("review", prompt, context.root, options, schema)
```

现有 review profile、模型/effort、前后台执行、usage、timeout、错误处理全部复用。

## 文件目标安全 Contract

`collectPlanReviewTarget()` 必须：

1. 获取 Git root 并执行 `realpath`。
2. 将相对路径解释为 repository-root-relative；绝对路径只在最终真实路径仍位于 root 内时接受。
3. 对目标执行 `realpath`，使用 `relative()` 验证没有逃出真实 Git root。
4. 要求目标为普通文件。
5. 拒绝 NUL、无效 UTF-8 和超过 256 KiB 的内容。
6. 一次读取文件，基于原始 bytes 计算 SHA-256。
7. 将同一份不可变文本快照注入 prompt，避免审查内容与 fingerprint 发生 TOCTOU 偏差。
8. 仅持久化相对路径、hash、review kind 和 runtime metadata，不持久化正文。

符号链接解析后仍位于 root 内可以接受；解析到 root 外必须拒绝。

文档内容仍可能通过 prompt injection 影响只读审查判断。只读 profile 限制副作用，但不能保证结论不受恶意文本影响；文档必须如实说明这一残余风险。

## Plan Review Prompt 与 Schema

独立 `plan-review.md` 负责审查：

- outcome 是否明确且可验证；
- 假设与真实约束是否分离；
- 机制是否解决根问题；
- 范围、依赖、迁移和兼容性是否完整；
- 权限、数据安全、回滚和观测是否闭合；
- 测试与 acceptance oracle 是否能证伪；
- 成本与复杂度是否值得。

finding 分类收敛为：

```text
outcome
assumption
feasibility
completeness
safety
verification
cost
other
```

Finding 包含：

```json
{
  "severity": "high",
  "category": "assumption",
  "title": "...",
  "body": "...",
  "location": {
    "file": "docs/plans/example.md",
    "section": "Migration",
    "line_start": 42
  },
  "confidence": 0.9,
  "recommendation": "..."
}
```

顶层保留 `verdict`、`summary`、`findings`、`coverage`、`uncertainty`、`budget_exhausted` 和 `recommended_followup`。

## Skill 路由 Contract

| 用户意图 | 正确 Skill |
|---|---|
| “审查这个方案” | 用户级通用 `plan-review` |
| “让 Claude 审查这个方案” | 插件 `claude-plan-review` |
| “让 Fable 5 审查这个方案” | 插件 `claude-plan-review --model claude-fable-5` |
| “审查当前代码改动” | 插件 `claude-review` |
| “实现这个方案” | 插件 `claude-task` |

`claude-plan-review` 仅在用户明确指定外部 Claude 运行时时触发：

```text
Use when the user explicitly asks Claude Code, Fable, Sonnet, Opus, or
cc-plugin-codex to review an existing plan, specification, PRD, proposal,
design, or architecture document.
```

`claude-task` 增加负触发规则：

```text
Do not use to evaluate, approve, challenge, or review an existing plan,
specification, design, PRD, proposal, or repository diff.
```

Skill 路由是概率行为，不能用单个布尔测试声称 100% 保证。静态测试只验证描述和入口契约；行为验收使用多样本路由评测。

## 审计与兼容 Contract

前后台结果增加：

```json
{
  "operation": "review",
  "review_kind": "plan",
  "subject_kind": "file",
  "subject_label": "docs/plans/example.md",
  "subject_fingerprint": "sha256:...",
  "review_profile": "standard",
  "task_profile": null,
  "requested_model": "claude-fable-5",
  "effective_models": ["claude-fable-5"],
  "effort": "medium"
}
```

这些字段是 additive。初版不升级 job record version；旧记录与现有 code review 对缺失字段返回 null。所有新 plan review job 必须完整保存上述 subject 元数据，但不保存正文。

## 非目标

- 不支持 URL、stdin、多个目标文件或 workspace 外文件。
- 不提供任意 `subject_kind × review_kind` 组合。
- 不让 `adversarial-review` 在初版支持 plan target。
- 不增加 plan 专属 profile 表。
- 不自动选择 Opus/Fable、升级模型、retry、resume 或 fallback。
- 不宣称 soft budget 是硬账单上限。
- 不构建集中成本 dashboard。

## 失败条件与回退

以下证据出现时，应停止扩展并退化为 skill-only 方案：

- 下游没有消费 plan schema 或 subject 审计字段。
- 路由评测显示专用 Skill 没有显著优于明确的 `/claude-task` 使用约定。
- Review profile 的实际成本没有改善，且结构化结果也没有减少返工。

回退只需移除 plan-only CLI/collector/prompt/schema/skill；现有 code review 保持不变。实现必须避免修改 Git collector 公共行为，从而让回退保持局部。

## 验收 Oracle

1. 默认和 `--base` code review 的现有 argv、prompt、schema 与输出不回归。
2. plan review 使用 review capability profile、plan prompt/schema，且 `task_profile=null`。
3. 参数矩阵中的非法组合在 Claude 启动前失败。
4. 模型、Fable、effort、review profile 和预算覆盖原样透传。
5. Git-root 路径、符号链接逃逸、非普通文件、NUL、无效 UTF-8 和超大文件边界全部有测试。
6. subject fingerprint 与注入 prompt 的同一份 bytes 一致。
7. plan review 前后台成功和结构化失败均保存审计与 usage 字段。
8. Skill 路由评测至少包含 20 个多样化样本；明确外部模型的方案审查 ≥90% 进入 `claude-plan-review`，进入 `claude-task` 的比例为 0。
9. 全量 `npm run check` 通过。
