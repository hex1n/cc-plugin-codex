---
name: claude-review
description: Ask Claude Code to review repository changes with read-only tools. Use for a Claude second opinion on a diff or base ref; use claude-plan-review for an existing plan document.
---

# Claude Review

Invoke the installed `claude_review_changes` MCP tool with the target Git root. The review is read-only and includes staged, unstaged, and untracked changes. Use `review_profile=quick|standard|deep`; only an explicitly selected deep profile requests Opus. Forward explicitly requested model (including `fable` or a full ID), effort, base, turn, budget, timeout, and background controls. Never chain, retry, upgrade, or add a fallback automatically. Preserve findings, coverage, uncertainty, requested/effective models, token count, cost, turns, duration, and session metadata. For a background review, obtain final usage with `claude_job_result`. If MCP is unavailable, report that transport failure and direct setup diagnosis to `claude-setup`; do not change transports automatically. This Skill reviews changes only; route an existing plan document to `claude-plan-review`.
