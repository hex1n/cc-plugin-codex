# ISSUE-003 — Tool-first command contract

- Type: product defect
- Severity: high
- Disposition: CLOSED — RV-03 used the post-fix tool-first path without a permission denial
- Affected scenarios: RV-03
- Expected: Claude's first probe is executable under the review allowlist.
- Actual: Claude emitted a compound `git -C ... | tail; echo; git -C ...` command and permission handling rejected it.
- Evidence: `execution-report.md#rv-03-large`.
- Suspected code area: `prompts/review.md`, `prompts/adversarial-review.md`, and review tool profile in `scripts/lib/claude.mjs`.
- Reproduction: run a low-budget review against a large manifest.
- Fix constraint: prefer a dedicated read-only diff adapter that enforces bounded output；prompt 中的命令形状说明只能作为辅助。Do not broaden to arbitrary Bash.
- Verification: first large-review probe executes without approval and reads a bounded sample.
- Post-fix E2E rerun: RV-03 and RV-02.
- Closure rule: large review uses the adapter successfully without relying on model compliance with shell syntax.
- Cleanup/data impact: none.
