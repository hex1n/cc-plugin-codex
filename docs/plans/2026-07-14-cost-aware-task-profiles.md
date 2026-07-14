# Sonnet / Opus / Fable 成本感知执行计划

**模式**: Plan
**深度**: Deep
**状态**: implemented（完整检查与双轴代码审查通过）
**输入来源**: 本仓库运行时、job state、render、hooks、skills、README 与测试；Claude Code 2.1.208 `--help`；2026-07-14 历史成本记录；2026-07-14 Sonnet normal/lean 合成夹具 A/B
**模型约束**: 默认路由只请求 Sonnet/Opus；支持显式 `--model fable`；不提供 Haiku profile 或 fallback

## TL;DR

当前最佳且已实现的路径是：

1. task 默认使用 Standard/Sonnet；Quick 仍是 Sonnet，Deep 仅在用户显式选择时使用 Opus。
2. `--model fable` 在 task/review、前台/后台均原样透传，不由插件映射。
3. 成功与失败 job 都保存 requested/effective models、usage、cost、turns 和 duration。
4. resume 始终显式；可关联的后台 resume 显示父 job 与累计链路成本。
5. soft budget 不再被描述为硬账单上限；插件只对墙钟 timeout 做硬停止。
6. lean runtime 已经真实 A/B 证伪并从首发实现删除，不保留危险 opt-in。

## 当前最佳路径

### 建议

- 默认 task：`standard` / Sonnet / medium effort / 8 turns / turn 6 收口 / $1.50 soft budget / 300s timeout。
- 小任务：显式 `--task-profile quick`，使用 Sonnet / low effort / 4 turns。
- 高风险任务：显式 `--task-profile deep`，使用 Opus / high effort / 16 turns，并在帮助和输出中可见。
- Fable：仅通过 `--model fable` 或显式配置覆盖 profile 模型，其他 envelope 字段保持不变。
- Review：gate/quick/standard 请求 Sonnet；显式 deep 请求 Opus；任一 profile 可被 `--model fable` 覆盖。
- 禁止 prompt 内容路由、`--fallback-model`、自动 Sonnet→Opus/Fable、自动 resume、固定 token resume gate 和默认 capsule。

### 最佳性检查

| 检查 | 结论 |
|---|---|
| 适配标准 | 无 Haiku 默认路径；Fable 可指定；常规成本有边界；高质量路径保留；行为与实际模型可审计 |
| 当前胜者 | Sonnet 默认 + 显式 Opus/Fable + profile envelope + 完整成本观测 |
| 最接近替代方案 | 所有调用固定 Sonnet，只依赖人工 flags |
| 替代胜出条件 | Opus deep 在复杂夹具中没有可观察的质量收益；此时 deep 应改为 Sonnet/high effort |
| 边际停止点 | 不继续试验动态模型路由或 lean 旗标组合；现有 A/B 已足以拒绝其作为可发布能力 |

## 已完成的验证门

同一合成仓库、同一任务、Sonnet、low effort、4 max turns、turn 3 收口、$0.50 soft budget：

| 组 | Runtime | 结果 | Cost | Tokens | Duration | Effective models |
|---|---|---|---:|---:|---:|---|
| A | normal | 成功；发现重复 `orderId` 缺陷；包含项目 marker | $0.3044634 | 115,469 | 34.5s | `claude-sonnet-5` |
| B | lean candidate | 失败：`error_max_turns`，无最终答案 | $0.1782157 | 81,868 | 31.4s | `claude-sonnet-5`、`claude-haiku-4-5-20251001` |

B 成本下降约 41.5%，但同时违反两个预注册门槛：没有成功结果，并出现未请求的 Haiku 辅助用量。因此：

- Standard 与 Quick 保持 normal Claude runtime。
- 不发布 `--runtime-mode lean` 或 `task.runtimeMode`。
- 插件不请求 Haiku、不传 `--fallback-model`，但必须如实显示 Claude CLI 内部产生的所有 `effective_models`。
- 未来只有在 Claude CLI 提供可验证的“禁用辅助模型”能力，且新的 A/B 同时通过正确性、项目指令与成本门槛时，才重新评估 lean。

## 决策信封

```yaml
decision: BUILD
decision_source: 用户已要求按计划落地
target_outcome: 在不依赖 Haiku 降本的前提下，使默认 task/review 模型、资源 envelope 和真实成本可预测、可覆盖、可审计
baseline_and_frequency: 近 48 小时 task 23 次约 $48.843；resume 12 次约 $18.495，占 task 花费 37.9%
expected_benefit: 已交付边界与观测能力；未宣称达到 30% 整体降本，lean 的 41.5% 单次降幅因失败而无效
delivery_and_maintenance_cost: 实现范围约 3.75 工程日等价；每次 Claude CLI 大版本需复跑 argv 与真实模型观测夹具
status_quo_or_existing_mechanism: 手工传 model/turns/budget，容易遗漏且旧成功 job 缺少完整指标
decision_flip_condition: 若 profile 默认导致真实任务完成率明显下降，应只保留显式 profiles，不强制 Standard envelope
review_scope: implementation-authorization
review_budget: 已执行 2 次合成 Sonnet 调用，合计 $0.4826791；不再增加在线验证调用
```

## 根问题

根问题不是模型单价，而是 Claude 调用缺少稳定工作量边界和可信终态指标：

- task 不指定模型时继承 Claude CLI 默认，版本变化可能改变成本与质量。
- turns、收口时机、effort、soft budget 和 timeout 缺少统一 task profiles。
- 后台成功分支此前只保存 session，真实成本大量缺失。
- 请求模型与实际参与计费的模型没有分开表达。
- resume 容易重复读取与规划，且此前不显示累计链路成本。
- 自动升级或 fallback 会产生无法预测的费用。

解决后的结果是：默认 Sonnet envelope 固定；Opus/Fable 必须明确选择；每个可用终态都能回答“请求了什么、实际用了什么、用了多少”；resume 链路可见但不自动触发。

## 真实约束与已证伪假设

| 项目 | 分类 | 处理 |
|---|---|---|
| 不提供 Haiku profile/fallback | 真实约束 | 无默认/显式 Haiku profile；不传 `--fallback-model` |
| Claude CLI 可能内部使用辅助模型 | 已验证运行时行为 | 不能在调用前保证完全无 Haiku；通过 `effective_models` 如实暴露 |
| Sonnet、Opus 均可用 | 真实约束 | Sonnet 默认；Opus 仅显式 deep 或 `--model opus` |
| Claude Code 2.1.208 支持 `fable` alias | 已验证能力 | 原样透传；同时记录 requested/effective models |
| soft budget 可能超额 | 已验证行为 | 文档与 JSON 明确 soft；不宣称硬停止 |
| raw resume 占近期 task 花费 37.9% | 已验证观察 | 不自动 resume；显示 parent/cumulative chain cost |
| 固定 100k token resume gate 能可靠预测成本 | 已证伪 | 不实现 |
| capsule 默认比 raw resume 更省 | 已证伪 | 不实现默认 capsule |
| lean runtime 可保持质量并避免 Haiku | 已证伪 | 删除候选实现，不保留 opt-in |

## 运行时 Contract

### Task profiles

| Profile | 默认模型 | Effort | Max turns | Finalize at | Soft budget | Timeout |
|---|---|---|---:|---:|---:|---:|
| `quick` | Sonnet | low | 4 | 3 | $0.50 | 120s |
| `standard` | Sonnet | medium | 8 | 6 | $1.50 | 300s |
| `deep` | Opus | high | 16 | 12 | $5.00 | 900s |

覆盖规则：CLI > project config > user config > environment > profile defaults。`--model fable` 只覆盖模型；`--effort`、turns、soft budget 与 timeout 可逐字段覆盖。

### Review profiles

| Profile | 默认模型 | Effort | Max turns | Soft budget | Timeout |
|---|---|---|---:|---:|---:|
| `gate` | Sonnet | low | 4 | $0.20 | 90s |
| `quick` | Sonnet | low | 6 | $0.30 | 120s |
| `standard` | Sonnet | medium | 12 | $1.00 | 240s |
| `deep` | Opus | high | 24 | $3.00 | 600s |

## 数据与兼容 Contract

Job record 升级为 version 3；旧记录只读归一并标记 `legacy-partial`。

| 字段 | 语义 |
|---|---|
| `taskProfile` / `reviewProfile` | 最终 profile |
| `requestedModel` | profile 与 CLI/config 覆盖后的请求值 |
| `effectiveModels` | 最终 `modelUsage` 中实际出现的模型 keys |
| `effort` | 最终 effort |
| `maxTurns` / `finalizeAtTurn` / `maxBudgetUsd` / `timeoutMs` | 最终执行 envelope；budget 是 soft |
| `usage` / `modelUsage` / `totalCostUsd` / `numTurns` / durations | 成功和结构化失败都保存；缺失为 null，不伪造 0 |
| `parentJobId` / `resumeSessionId` | 可关联的显式 resume 链路 |
| `cumulativeChainCostUsd` | 链路成本可完整计算时求和，否则 null |

## 实施范围与状态

| Scope | Component | Status | Evidence |
|---|---|---|---|
| Core | 成功 job 完整 usage/cost/model 持久化 | 完成 | background public-interface test |
| Core | task quick/standard/deep profiles 与 effort | 完成 | argv/config precedence tests |
| Core | review Sonnet/Opus profile 映射 | 完成 | quick/deep review tests |
| Core | Fable task/review、前台/后台透传 | 完成 | requested/effective model assertions |
| Core | resume parent 与累计链路成本 | 完成 | status/result JSON tests |
| Core | soft budget 与 timeout 语义 | 完成 | renderer/docs + timeout regression tests |
| Supporting | lean A/B 与回退 | 完成并拒绝 | 2 次真实 Sonnet 合成调用 |
| Supporting | README、中文 README、skills | 完成 | `npm run check` 88/88 通过 |

## 代码审查记录

- Standards：无 hard violation；execution envelope 的跨层 data clump、重复 runtime 应用逻辑和相应 shotgun surgery 风险作为非阻塞重构候选保留。
- Spec：审查发现的失败 resume 链路成本、前台结构化失败 requested model、单 turn task 三个边界问题均已补测试并修复。

## 验收 Oracle

最终提交前必须满足：

1. `npm run check` 全绿。
2. 默认 task argv 为 Standard/Sonnet/medium，且不包含 Opus 或 `--fallback-model`。
3. 显式 deep task/review 请求 Opus；Fable 在四条前后台路径原样透传。
4. 成功与结构化失败 job 均保存可用 usage/cost/model；requested 与 effective models 分离。
5. status/result 均显示可计算的 resume 累计链路成本。
6. 无自动模型升级、fallback、resume、capsule 或固定 token gate。
7. 文档明确 budget 是 soft，且 Claude CLI 可能内部产生未请求的辅助模型用量。
8. 代码审查的 Standards 与 Spec 两轴均无阻塞 finding。

## 非目标

- 不实现 Haiku profile、fallback 或降本策略。
- 不发布 lean runtime 开关。
- 不构建 prompt 内容模型路由器。
- 不把 soft budget 包装成硬账单上限。
- 不自动 resume、自动 capsule 或自动切换 fresh session。
- 不建设集中式成本 dashboard。
