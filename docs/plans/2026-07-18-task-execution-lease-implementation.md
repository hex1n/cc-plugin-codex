# Task Execution Lease implementation plan

**Status:** approved for implementation
**Date:** 2026-07-18
**Scope:** `claude_task_readonly`, `claude_write_task_start`, explicit typed resume

## Root problem

A hard Claude turn or cost breaker currently turns a partially completed task
into `failed`. A later invocation can resume a read-only Claude session, but the
plugin does not preserve an actionable task checkpoint, and isolated writes
cannot resume at all. Starting again can repeat exploration and spend the same
tokens twice.

An arbitrary task cannot be guaranteed to finish inside a fixed budget. The
honest outcomes are therefore:

1. `completed`: the requested outcome and verification are complete;
2. `checkpointed`: useful progress is durably preserved and explicit resume is
   safe;
3. `failed`: no trustworthy checkpoint or safe continuation exists.

## Deep module

`scripts/lib/task-execution-lease.mjs` owns one small internal interface:

- create the initial lease metadata from task limits;
- validate and normalize checkpoint/completion receipts;
- project Claude breaker results into `checkpointed` or `failed`;
- validate resume eligibility and produce child-job linkage;
- aggregate cumulative usage and cost without guessing missing values.

MCP, service, worker, rendering, and artifact code consume these decisions.
They must not independently reinterpret max-turn or max-budget errors.

The external seam remains typed MCP. One new tool is sufficient:

```text
claude_task_resume(workspace_root, job_id, runtime overrides...) -> job/result
```

It resumes either a read-only or isolated-write checkpoint according to the
persisted parent capability. Callers do not choose a resume implementation.

## Job-local controller

When `task.executionLeaseEnabled=true`, Claude receives one job-local stdio MCP
server with exactly two tools:

- `task_checkpoint`: bounded summary, completed steps, remaining steps,
  verification evidence, and uncertainty;
- `task_complete`: bounded summary, verification evidence, and remaining gaps.

The server atomically publishes a `0600` state file under a unique `0700`
control directory. The state records its parent PID and a monotonic revision.
The worker validates ownership and monotonicity. Corrupt, missing, stale, or
foreign state fails closed.

Claude keeps its existing built-in tools. Read-only tasks retain plan mode;
write tasks retain `acceptEdits` inside the verified standalone clone. The
controller records completion state; it does not become a shell transport or
weaken the sandbox.

## Completion reserve

The existing `finalizeAtTurn` becomes the working-turn boundary when the lease
is enabled. `maxTurns` remains the hard circuit breaker.

```text
working turns:       1 .. finalizeAtTurn
completion reserve:  finalizeAtTurn+1 .. maxTurns
hard breaker:        maxTurns / maxBudgetUsd / timeoutMs
```

At the reserve boundary Claude must stop expanding scope, publish a checkpoint,
verify the smallest deliverable, and publish `task_complete` only if no required
work remains. The plugin never raises a configured hard limit automatically.

## State machine

```text
starting -> running -> completed
                    -> checkpointed -> resuming -> running child
                    -> failed
                    -> cancelled
                    -> timed_out
```

Rules:

- a turn/cost breaker plus a valid checkpoint and session ID becomes
  `checkpointed`;
- a breaker without either item becomes `failed`;
- a successful lease-enabled invocation requires a valid completion receipt;
  otherwise a valid checkpoint becomes `checkpointed`, else it fails;
- only `checkpointed` leaf jobs are resume eligible;
- resume is explicit and serialized by the workspace lock; it atomically
  claims the parent as `resuming` before starting one linked child, rolls the
  claim back on synchronous launch failure, reconciles a stale unlinked claim
  to its persisted child or back to `checkpointed`, and never invokes
  automatically;
- cumulative cost is parent cumulative cost plus the child invocation cost;
- a resumed parent cannot be resumed twice or cleaned while its child is live.

## Isolated-write invariants

- A checkpointed write keeps its original isolated root, artifact root,
  baseline, settings path, sandbox policy hash, executable hash, backend, and
  Claude session ID.
- Resume re-runs sandbox preflight and requires exact identity equality.
- The settings file and isolated/artifact roots must remain canonical,
  owner-controlled, and inside the configured write root.
- Checkpointed or resuming jobs have no applicable patch artifact and cannot be
  applied.
- Only a completed child with a valid completion receipt is frozen into an
  `awaiting_apply` artifact.
- Discard remains explicit and cleans the whole checkpoint chain's shared
  workspace only when no child is active.
- The source workspace remains untouched until the existing explicit apply
  path succeeds.

## Compatibility

- Record version advances additively. Older records normalize lease fields to
  disabled/null and keep their existing completed/failed semantics.
- The feature flag defaults off during this implementation rollout.
- Existing explicit `resume_session_id` remains supported for legacy read-only
  tasks. Lease checkpoints prefer `claude_task_resume(job_id)` because it binds
  the exact checkpoint and cumulative chain.
- No fallback transport, model, retry, resume, or budget expansion is added.

## User-facing prototype

The repository-wide information hierarchy is captured in
`docs/prototypes/cc-plugin-codex-low-fidelity.md`. The recommended Balsamiq-style
storyboard keeps the product inside the Codex conversation: select an Intent,
track its Job, then expose one state-gated decision for checkpointed or
awaiting-apply work.

The prototype is not a production UI contract. Its state-to-action mapping is
normative for documentation: checkpointed exposes explicit resume, resuming
does not expose a second resume, and write apply appears only at
`awaiting_apply`.

## TDD slices

1. Read-only max-turn and max-budget results become checkpointed only with a
   valid receipt/session; result rendering exposes the checkpoint and no second
   Claude invocation occurs.
2. Explicit read-only resume creates one linked child with the same session and
   cumulative cost, then completes from a completion receipt.
3. Isolated-write breaker preserves the clone, rejects apply, resumes in the
   exact same verified clone, and only then reaches `awaiting_apply`.
4. Missing/corrupt controller state, duplicate resume, identity drift,
   cancel/timeout, and cleanup races fail closed.
5. MCP inventory, skills, prompts, config, migration, docs, installed-cache
   parity, and the full suite are verified offline with fake Claude.

## Not covered

Paid model calls, Agent SDK, automatic continuation, fallback models, automatic
budget changes, production rollout, release, commit, and push are separate
decisions.
