---
name: claude-transfer
description: Create a Claude Code summary seed from the current Codex task. Use when the user asks to transfer, hand off, or continue this work in Claude Code; this is not a faithful session import.
---

# Claude Transfer

Summarize the goal, decisions, changed files, verification, blockers, and next action into a compact digest. Resolve `<PLUGIN_ROOT>` to the installed plugin root, then run `node "<PLUGIN_ROOT>/scripts/claude-companion.mjs" transfer "<digest>"` from the target project root. Return the generated command and state clearly that it seeds a new conversation rather than importing session history.
