# ISSUE-002 — Bound review manifest

- Type: product defect
- Severity: high
- Disposition: CLOSED — 100k-path regression passed and RV-03 completed without unbounded initial context
- Affected scenarios: RV-03
- Expected: initial review prompt remains bounded independently of changed-file count.
- Actual: lightweight context lists every changed path; 2000 short paths produced 44,147 bytes.
- Evidence: `execution-report.md#rv-03-large`.
- Suspected code area: `scripts/lib/git.mjs` `lightweight`.
- Reproduction: create thousands of changed files and call `collectReviewContext`.
- Fix constraint: send count, diff stat and a deterministic bounded sample; report omitted count. Do not introduce a 96 KiB diff coverage limit.
- Verification: 100k changed paths keep the rendered initial prompt below the emergency envelope.
- Post-fix E2E rerun: RV-03.
- Closure rule: prompt size no longer grows linearly with total file count after the sampling threshold.
- Cleanup/data impact: fixture only.
