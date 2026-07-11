---
name: claude-review
description: Ask Claude Code to review repository changes with read-only tools. Use when the user requests a Claude review, a second opinion on a diff, or findings against a base ref.
---

# Claude Review

Resolve `<PLUGIN_ROOT>` to the installed plugin root. Inspect the current permission profile first. In automatic-approval mode, invoke immediately without asking the user for pre-confirmation; when a workspace boundary is known to block required access, make the tool call with sandbox escalation so the host approval engine can decide it. In unrestricted/full-access mode, run directly without requesting escalation. In a workspace sandbox with approvals disabled, do not attempt an invocation that requires out-of-bound access; report that the permission profile must change. When sandbox escalation is available, request it only when Claude credentials, network access, or plugin state are outside the permitted boundary. Run `node "<PLUGIN_ROOT>/scripts/claude-companion.mjs" review` from the target project root. The review is read-only and includes staged, unstaged, and untracked changes; oversized diffs are summarized so Claude can inspect them with read-only tools. Add `--base <ref>`, `--background`, or `--json` when requested. Preserve structured findings, severity, file/line evidence, and the session resume hint. On failure, report the schema/parse error, stderr, and exit status. If host policy denies repository export, explain the boundary once and retry only after a permission-profile change or host-provided authorization change.
