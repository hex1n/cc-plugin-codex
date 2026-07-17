---
name: claude-status
description: List or inspect Claude Code background jobs for the current workspace. Use when the user asks for job status, progress, IDs, PIDs, or detached-task state.
---

# Claude Status

For one job, invoke `claude_job_status` with the workspace root and explicit job ID. For workspace or explicitly requested global history, invoke `claude_jobs_list` with explicit filters, cursor, and a bounded limit; global scope must never be inferred. Report status, phase, artifact status, progress, requested/effective models, cost, session, error kind, and suggested action. When waiting, poll `claude_job_status` client-side with a deadline, bounded attempts, and capped backoff; do not ask the server to hold a long-lived wait. Never select an implicit latest job. If MCP is unavailable, report the transport failure and direct recovery diagnosis to `claude-setup`; do not change transports automatically.
