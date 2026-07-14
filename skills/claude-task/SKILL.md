---
name: claude-task
description: Delegate a project task to Claude Code headlessly. Use for inspect or implementation work, but not to review or approve an existing diff, plan, design, or artifact.
---

# Claude Task

Use `claude_task_readonly` for inspection and analysis. Use `claude_write_task_start` only when the user explicitly authorizes edits; it runs in a sandboxed standalone clone and returns a job whose successful terminal phase is `awaiting_apply`, so do not claim that the source workspace changed. Invoke `claude_write_task_apply` only after a separate explicit user instruction to apply that job; otherwise use `claude_write_task_discard` when asked to discard it. Never auto-apply, resume, retry, select Opus/Fable, add budget, or add a fallback model. Forward explicitly requested model (including `fable` or a full ID), effort, task profile, turns, budget, context, timeout, and background controls. Report requested/effective models, token count, cost, turn count, duration, and other usage. If MCP is unavailable, resolve `<PLUGIN_ROOT>` and use `node "<PLUGIN_ROOT>/scripts/claude-companion.mjs" task ...`, `apply`, or `discard` as the compatibility fallback. Reviews or approvals of existing changes/plans are outside this Skill.
