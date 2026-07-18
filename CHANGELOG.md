# Changelog

All notable changes to this project are documented here.

## Unreleased

- Added a repository-wide Balsamiq-style storyboard built around the
  conversation-first Intent → Job → Decision flow, with explicit
  state-to-action and trust-boundary mapping.
- Added a default-off Task Execution Lease for read-only and isolated-write
  tasks, with durable checkpoints, one explicit typed resume operation,
  same-session/same-sandbox continuation, cumulative cost accounting, and
  fail-closed apply, drift, corruption, cancellation, and timeout behavior.
- Added a default-off, single-invocation Review Evidence Lease path with three
  bounded read-only MCP tools, strict Claude capability isolation, atomic lease
  telemetry, fail-closed startup, and full process-tree cleanup.
- Made typed MCP the sole normal Skill transport and removed automatic CLI fallback from all nine Skills.
- Added typed adversarial review, bounded job listing, read-only doctor, and explicit resume/continue fields.
- Added an MCP-independent, allowlisted admin CLI for doctor/probe, review-gate control, job recovery, and safe artifact inspection/discard.
- Completed the measured migration gate and removed the legacy normal CLI/bin; only the restricted admin CLI remains.
- Added versioned prompt templates and JSON Schema output contracts.
- Added truthful detached job state, stream progress, explicit-ID status/result/cancellation, and retention cleanup.
- Added explicit read-only and isolated-write task modes with model, effort,
  turn, budget, explicit resume/continue, and explicit apply/discard controls.
- Added review context handling for untracked, binary, and oversized changes.
- Added three-platform CI, release checks, and operational documentation.

## 0.1.0 - 2026-07-11

- Initial eight-skill Codex plugin for Claude Code delegation and review.
