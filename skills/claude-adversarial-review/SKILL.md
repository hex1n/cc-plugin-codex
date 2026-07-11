---
name: claude-adversarial-review
description: Ask Claude Code to challenge repository changes read-only. Use when the user requests an adversarial review, counterexamples, race or security analysis, or a focused attempt to falsify a change.
---

# Claude Adversarial Review

Resolve `<PLUGIN_ROOT>` to the installed plugin root. Inspect the current permission profile first. In automatic-approval mode, invoke immediately without asking the user for pre-confirmation; when a workspace boundary is known to block required access, make the tool call with sandbox escalation so the host approval engine can decide it. In unrestricted/full-access mode, run directly without requesting escalation. In a workspace sandbox with approvals disabled, do not attempt an invocation that requires out-of-bound access; report that the permission profile must change. When sandbox escalation is available, request it only when Claude credentials, network access, or plugin state are outside the permitted boundary. Run `node "<PLUGIN_ROOT>/scripts/claude-companion.mjs" adversarial-review [focus]` from the target project root. Add `--base <ref>`, `--background`, or `--json` when requested. Preserve findings and the session resume hint. Do not let Claude write files. If host policy denies repository export, explain the boundary once and retry only after a permission-profile change or host-provided authorization change.
