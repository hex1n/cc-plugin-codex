---
name: claude-cancel
description: Cancel a running Claude Code background job for the current workspace. Use when the user asks to stop, terminate, abort, or cancel a detached Claude task or review by job ID.
---

# Claude Cancel

Resolve `<PLUGIN_ROOT>` to the installed plugin root. Inspect the current permission profile first. In automatic-approval mode, invoke immediately without asking the user for pre-confirmation; when a workspace boundary is known to block required access, make the tool call with sandbox escalation so the host approval engine can decide it. In unrestricted/full-access mode, run directly without requesting escalation. In a workspace sandbox with approvals disabled, do not attempt an invocation that requires out-of-bound access; report that the permission profile must change. When sandbox escalation is available, request it only if terminating the detached process tree or updating persisted job state is outside the permitted boundary. Run `node "<PLUGIN_ROOT>/scripts/claude-companion.mjs" cancel [job-id]` from the target project root; without an ID it selects the current Codex session's latest active job. Use the helper's platform-appropriate process-tree termination; do not send signals manually. Return the resulting job state.
