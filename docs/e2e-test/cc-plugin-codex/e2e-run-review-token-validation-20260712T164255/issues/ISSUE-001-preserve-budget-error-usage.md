# ISSUE-001 — Preserve budget error usage

- Type: product defect
- Severity: high
- Disposition: CLOSED — RV-02/RV-03/RV-04 preserved subtype, session, usage, cost, turns, and duration on real bounded failures
- Affected scenarios: RV-01, RV-02, RV-03
- Expected: budget exhaustion preserves Claude subtype, usage, cost, turns and session id.
- Actual: foreground `runClaude` discards stdout whenever exit code is nonzero；background worker 也只持久化错误状态，`result` 对 failed job 直接拒绝，无法恢复 usage/cost/turns。
- Evidence: `execution-report.md#rv-01-small`.
- Suspected code area: `scripts/lib/claude.mjs` `runClaude`/`parseClaudeJson`, `scripts/claude-job-worker.mjs`, and failed-job handling in `scripts/claude-companion.mjs`.
- Reproduction: run review with a budget below that invocation's observed startup consumption.
- Fix constraint: define a structured Claude error object that extracts subtype, session, usage, cost and turns before raising failure；foreground and background must persist the same fields. Merely calling the current `parseClaudeJson` first is insufficient because it throws before extracting usage.
- Verification: error response contains `error_max_budget_usd`, `total_cost_usd`, usage and session id.
- Post-fix E2E rerun: RV-01, RV-02, RV-03.
- Closure rule: foreground and background budget-limited runs remain diagnosable without reading Claude private session logs.
- Cleanup/data impact: none.
