---
name: claude-result
description: Read the final output of a Claude Code background job. Use when the user supplies a job ID or asks for the result of a completed detached task or review.
---

# Claude Result

Invoke `claude_job_result` with the workspace root and explicit job ID. Report the result, artifact status when present, requested/effective models, session, token count, cost, turns, and duration. A `checkpointed` result is durable but incomplete: report its completed work, remaining work, verification, resume eligibility, and cumulative cost without resuming automatically. If it is running, cancelled, timed out, or failed, report that state without retrying. If MCP is unavailable, report the transport failure and direct recovery diagnosis to `claude-setup`; do not change transports automatically.
