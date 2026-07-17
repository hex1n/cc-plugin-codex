---
name: claude-transfer
description: Create a Claude Code summary seed from the current Codex task. Use when the user asks to transfer, hand off, or continue this work in Claude Code; this is not a faithful session import.
---

# Claude Transfer

Create the seed locally from the current conversation: summarize the goal, decisions, changed files, verification, blockers, and next action into a compact digest. Return the digest and, when useful, a copyable `claude "<digest>"` command. Do not invoke an MCP tool or start Claude automatically. State clearly that this is a summary seed rather than a faithful session import.
