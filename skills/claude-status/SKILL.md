---
name: claude-status
description: List or inspect Claude Code background jobs for the current workspace. Use when the user asks for job status, progress, IDs, PIDs, or detached-task state.
---

# Claude Status

Invoke `claude_job_status` with the workspace root and explicit job ID. Report status, phase, artifact status, progress, requested/effective models, cost, session, error kind, and suggested action. If MCP is unavailable or the user requests list/global filters that the typed tool does not expose, resolve `<PLUGIN_ROOT>` and use `node "<PLUGIN_ROOT>/scripts/claude-companion.mjs" status ...` as the compatibility fallback.
