---
name: claude-plan-review
description: Ask Claude Code, Sonnet, Opus, or Fable to review an existing plan document. Use only when the user explicitly requests an external-model review of a saved plan, design, proposal, or implementation plan.
---

# Claude Plan Review

Require one existing UTF-8 plan file inside the target Git repository. Do not create a durable plan merely to trigger this Skill. Invoke `claude_review_plan` with the workspace root and `target_file`. It is strictly read-only and reviews an immutable single-file snapshot. Default to the configured standard/Sonnet profile; select Opus, Fable, `claude-fable-5`, a different effort, or a deeper profile only when the user explicitly requests it. Normalize the conversational alias `fable5` to `claude-fable-5`. Never retry, resume, fall back, add budget, or route this request through `claude_task_readonly`. Report verdict, findings, coverage, subject label/fingerprint, requested/effective models, token count, cost, turns, duration, and other usage. If MCP is unavailable, report that transport failure and direct setup diagnosis to `claude-setup`; do not change transports automatically.
