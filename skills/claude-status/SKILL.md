---
name: claude-status
description: List or inspect Claude Code background jobs for the current workspace. Use when the user asks for job status, progress, IDs, PIDs, or detached-task state.
---

# Claude Status

Resolve `<PLUGIN_ROOT>` to the installed plugin root. Inspect the current permission profile first. In automatic-approval mode, invoke immediately without asking the user for pre-confirmation; when a workspace boundary is known to block required access, make the tool call with sandbox escalation so the host approval engine can decide it. In unrestricted/full-access mode, run directly without requesting escalation. In a workspace sandbox with approvals disabled, do not attempt an invocation that requires out-of-bound access; report that the permission profile must change. When sandbox escalation is available, request it only if persisted job state is outside the permitted boundary. Run `node "<PLUGIN_ROOT>/scripts/claude-companion.mjs" status [job-id]` from the target project root. Without an ID it returns the current Codex session's latest job. Add `--wait` with an explicit job ID when the user asks to wait, `--all` for full workspace history, and `--json` when structured output helps. When the user explicitly asks across workspaces or for recent global usage, use `--global` with a bounded `--recent` window; test jobs remain hidden unless the user asks for `--include-test`. Report status, phase, duration, progress, session, PID, error kind, and suggested action.
