---
name: claude-setup
description: Diagnose cc-plugin-codex setup without installing or logging in. Use when the user asks whether Claude Code is installed, authenticated, or ready, or wants to inspect or explicitly change the review-gate setting.
---

# Claude Setup

Inspect the current permission profile first. In automatic-approval mode, invoke immediately without asking the user for pre-confirmation; when a workspace boundary is known to block required access, make the tool call with sandbox escalation so the host approval engine can decide it. In unrestricted/full-access mode, run directly. With approvals disabled, do not attempt an out-of-bound call; report that the permission profile must change. When sandbox escalation is available, request it only for Claude credentials or plugin configuration outside the permitted boundary.

Use `claude_doctor` for normal read-only diagnosis and report Claude version, authentication state, MCP visibility, state availability, and review-gate state. Treat `unavailable-or-not-logged-in` as ambiguous; never install or log in automatically. Review-gate mutation is a break-glass admin action, not an MCP workflow: only when the user explicitly asks to enable or disable it, resolve `<PLUGIN_ROOT>` and invoke the packaged `claude-companion-admin` entry via `node "<PLUGIN_ROOT>/scripts/claude-admin.mjs" review-gate enable|disable --json`. If MCP itself is unavailable, use the same admin entry with `doctor` or `mcp probe`; diagnosis must not launch Claude work.
