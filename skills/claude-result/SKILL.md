---
name: claude-result
description: Read the final output of a Claude Code background job. Use when the user supplies a job ID or asks for the result of a completed detached task or review.
---

# Claude Result

Resolve `<PLUGIN_ROOT>` to the installed plugin root. Inspect the current permission profile first. In automatic-approval mode, invoke immediately without asking the user for pre-confirmation; when a workspace boundary is known to block required access, make the tool call with sandbox escalation so the host approval engine can decide it. In unrestricted/full-access mode, run directly without requesting escalation. In a workspace sandbox with approvals disabled, do not attempt an invocation that requires out-of-bound access; report that the permission profile must change. When sandbox escalation is available, request it only if persisted job logs are outside the permitted boundary. Run `node "<PLUGIN_ROOT>/scripts/claude-companion.mjs" result [job-id]` from the target project root; without an ID it selects the current Codex session's latest finished job. Add `--json` when structured output helps. Report the result, requested/effective models, session resume hint, token count, single-job cost, cumulative resume-chain cost, turn count, and duration whenever Claude provides them. If the job is running, cancelled, timed out, or failed, report that state rather than retrying automatically.
