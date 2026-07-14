---
name: claude-result
description: Read the final output of a Claude Code background job. Use when the user supplies a job ID or asks for the result of a completed detached task or review.
---

# Claude Result

Invoke `claude_job_result` with the workspace root and explicit job ID. Report the result, artifact status when present, requested/effective models, session, token count, cost, turns, and duration. If it is running, cancelled, timed out, or failed, report that state without retrying. If MCP is unavailable, resolve `<PLUGIN_ROOT>` and use `node "<PLUGIN_ROOT>/scripts/claude-companion.mjs" result ...` as the compatibility fallback.
