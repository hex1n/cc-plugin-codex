# Task Execution Lease interaction notes

**Status:** text-only interaction record; visual prototype removed
**Date:** 2026-07-18
**Question:** How should Codex present a bounded task that stopped safely without implying automatic retry or hiding the remaining work and cost?

## Constraints from the implementation

- The only honest terminal outcomes are completed, checkpointed, and failed.
- A checkpoint must expose completed work, remaining work, verification state, session continuity, usage, and cumulative cost.
- Nothing resumes automatically. The user or orchestrator must explicitly invoke claude_task_resume(job_id).
- An isolated write remains non-applicable while incomplete. Apply changes is available only after a valid completion receipt produces awaiting_apply.
- The interface must not imply fallback models, automatic budget expansion, or automatic retry.

## Alternatives

### A — Timeline

Optimizes for chronological explanation. It makes the breaker and checkpoint easy to understand but pushes the next action below the history and scales poorly for write/apply state.

### B — Action card (recommended)

Puts the current state, completed work, remaining work, cost, and explicit next action in one scan. It can reuse the same structure for read-only and isolated-write tasks; write tasks reveal Apply changes only after completion.

### C — Parent/child chain

Optimizes for debugging, session linkage, and cumulative-cost audit. It should remain an expandable detail view because parent/child identifiers are too technical for the default result surface.

## Recommendation

Use **B — Action card** as the default result presentation:

1. state banner (checkpointed, completed, or failed);
2. completed and remaining work;
3. current invocation and cumulative chain metrics;
4. one primary action determined by state:
   - checkpointed → Resume task;
   - completed read-only → no mutation action;
   - completed write / awaiting_apply → Apply changes;
5. Discard remains secondary and explicit.

Borrow the compact chronology from A and expose the parent/child chain from C only as audit details. The prototype is documentation evidence; Codex owns the actual host UI, so this repository does not add a throwaway frontend route.

## State-to-action contract

| State | Primary action | Secondary action | Must not show |
|---|---|---|---|
| running | View status | Cancel | Resume, Apply |
| checkpointed | Resume task | Discard for isolated write | Apply, automatic countdown |
| resuming | View child status | Cancel child | Second Resume |
| completed read-only | None | View audit details | Apply |
| awaiting_apply write | Apply changes | Discard | Resume |
| failed | View failure and recovery guidance | Discard retained write artifact when safe | Claim completion |

## Validation status

The underlying state and safety transitions are E2E verified in
docs/e2e-test/task-execution-lease/e2e-run-task-execution-lease-20260718T095607Z/execution-report.md.
The visual hierarchy itself remains a design recommendation until exercised in a Codex host surface.
