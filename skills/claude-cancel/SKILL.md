---
name: claude-cancel
description: Cancel a running Claude Code background job for the current workspace. Use when the user asks to stop, terminate, abort, or cancel a detached Claude task or review by job ID.
---

# Claude Cancel

Invoke `claude_job_cancel` with the workspace root and explicit job ID. Return the resulting job state; for an isolated write job, explain that cancellation does not apply anything and its retained workspace can be explicitly discarded. If MCP is unavailable, resolve `<PLUGIN_ROOT>` and use `node "<PLUGIN_ROOT>/scripts/claude-companion.mjs" cancel ...` as the compatibility fallback. Do not send signals manually.
