# ISSUE-004 — Bound Stop review gate

- Type: product defect
- Severity: critical
- Disposition: CLOSED — RV-05 completed under the gate budget and identical input reused the cached verdict without a second model call
- Affected scenarios: RV-05
- Expected: every Claude-backed review entry has non-null turn, cost, and wall-clock limits.
- Actual: Stop gate passes only `timeoutMs=840000`; `maxTurns` and `maxBudgetUsd` are absent.
- Evidence: `hooks/review-gate.mjs` lines 17–19 and `execution-report.md` RV-05.
- Suspected code area: `hooks/review-gate.mjs` and shared review runtime configuration.
- Reproduction: inspect or instrument the arguments passed from Stop gate to `runClaude`.
- Fix constraint: use a dedicated low-cost gate profile through the same centralized policy as explicit reviews. Do not rely on prompt instructions as a hard limit.
- Verification: an enabled gate invocation always carries non-null `maxTurns`, `maxBudgetUsd`, and `timeoutMs`; budget exhaustion yields a bounded, diagnosable decision.
- Post-fix E2E rerun: RV-05 plus one repeated identical Stop fingerprint scenario.
- Closure rule: Stop gate cost is bounded per invocation and repeated unchanged input cannot trigger unbounded calls.
- Cleanup/data impact: none.
