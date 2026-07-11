---
name: claude-setup
description: Diagnose cc-plugin-codex setup without installing or logging in. Use when the user asks whether Claude Code is installed, authenticated, or ready, or wants to inspect or explicitly change the review-gate setting.
---

# Claude Setup

Resolve `<PLUGIN_ROOT>` to the installed plugin root. Inspect the current permission profile first. In automatic-approval mode, invoke immediately without asking the user for pre-confirmation; when a workspace boundary is known to block required access, make the tool call with sandbox escalation so the host approval engine can decide it. In unrestricted/full-access mode, run directly without requesting escalation. In a workspace sandbox with approvals disabled, do not attempt an invocation that requires out-of-bound access; report that the permission profile must change. When sandbox escalation is available, request it only if the Claude credential store or plugin configuration is outside the permitted boundary. Run `node "<PLUGIN_ROOT>/scripts/claude-companion.mjs" setup` from the target project root. Add `--enable-review-gate` or `--disable-review-gate` only when the user explicitly requests that change. Report the version, authentication state, and gate state. Treat `unavailable-or-not-logged-in` as ambiguous. If Claude Code is missing, show the returned install command; do not install or log in automatically.
