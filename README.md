# cc-plugin-codex

[简体中文](README.zh-CN.md) | English

`cc-plugin-codex` lets Codex delegate reviews and tasks to an authenticated
Claude Code CLI through typed MCP tools. It is the reverse-direction companion to
`openai/codex-plugin-cc`: Codex remains the orchestrator, while Claude Code is
invoked as a local subprocess.

The plugin has no runtime npm dependencies. It requires Node.js 18 or later,
Codex with plugin support, and a working `claude` command whose authentication
is already configured.

It exposes nine skills: setup, code review, plan review, adversarial review,
task, transfer, status, result, and cancel.

## Typed MCP tools

The only normal Codex integration is the local stdio MCP server declared by
`.mcp.json`. Its twelve typed tools cover read-only tasks, code/plan/adversarial
review, isolated write start, explicit apply/discard, explicit-ID job lifecycle,
bounded job listing, and read-only setup diagnosis. The server imports stable
`#app/*` application contracts; it does not spawn a shell or a CLI adapter.
Prompts are sent to Claude over stdin and never appear in its argv.

Skills provide discovery, routing, client-side polling, and result presentation.
They do not fall back to another transport when MCP is unavailable. Although
the MCP protocol defines prompts and resources, the currently verified Codex
product surface does not expose server prompts; MCP prompts are therefore not a
workflow or security dependency.

Plan review accepts one UTF-8 repository file (maximum 256 KiB) and records only
its label and SHA-256 fingerprint. Use `fable` or `claude-fable-5` explicitly;
the conversational alias `fable5` is normalized by the Skill.

## Design reference

This project was inspired by
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc), which lets
Claude Code users invoke Codex for reviews and delegated tasks. This repository
explores the reverse direction: Codex remains the orchestrator and delegates to
the user's local Claude Code CLI.

## Installation

Add this repository to a personal Codex marketplace, then install its plugin:

```text
/plugin marketplace add <owner-or-path>/cc-plugin-codex
/plugin install cc-plugin-codex@personal
```

Restart Codex after installation so skills and hooks are reloaded. Run
`/claude-setup` to verify Node.js, Claude Code discovery, authentication access,
plugin storage, and the optional review-gate configuration. Setup is diagnostic
only; it never installs software or logs in on your behalf.

For source development or MCP-down recovery, use the restricted admin entry:

```sh
node scripts/claude-admin.mjs doctor
node scripts/claude-admin.mjs mcp probe
```

The legacy normal `claude-companion` CLI has been removed after the migration
gate passed. Normal operations are available only through Skills and typed MCP;
the admin entry cannot start review/task or apply artifacts.

## Updating

Refresh the marketplace and reinstall the plugin, then restart Codex:

```text
/plugin marketplace update personal
/plugin install cc-plugin-codex@personal
```

The build metadata suffix in `.codex-plugin/plugin.json` is intentionally
updated for local cache busting while the public release base remains aligned
with `package.json`.

Skill instructions use `<PLUGIN_ROOT>` only for explicit admin recovery actions.
It is an agent-resolved placeholder for the installed plugin directory, not a
shell environment variable. Normal work uses typed MCP tools.

## Configuration

The default task mode is the read-only `standard` profile: Sonnet, medium
effort, 8 maximum turns, finalization from turn 6, a $1.50 soft budget, and a
300-second timeout. Request a write only when Claude should edit the workspace.
A write task runs as a tracked job in an isolated standalone clone and stops at
`awaiting_apply`; a separate explicit apply is required. Typed request controls
include `task_profile`, `model`, `effort`, `max_turns`, `finalize_at_turn`,
`context`, `max_budget_usd`, `resume_session_id`, `continue_session`, and
`background`.

Task profiles are explicit resource envelopes:

| Profile | Model | Effort | Max turns | Finalize at | Soft budget | Timeout |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| `quick` | Sonnet | low | 4 | 3 | $0.50 | 120s |
| `standard` | Sonnet | medium | 8 | 6 | $1.50 | 300s |
| `deep` | Opus | high | 16 | 12 | $5.00 | 900s |

`deep` and Opus are never selected from prompt content. Use
`task_profile=deep` or `model=opus` explicitly. `model=fable` is passed
through unchanged and can override any task or review profile. The plugin does
not request Haiku and never passes `--fallback-model`; Claude CLI may still
report internally selected auxiliary models, which remain visible through
`effective_models` and `model_usage`.

`context=summary|diff|full` declares how much context is being sent; it does not
silently transform the prompt. Explicit read-only continuation uses exactly one
of `resume_session_id` or `continue_session`; a fresh task is the default and
isolated writes never resume. Results and tracked jobs expose a compact
disclosure summary. `finalize_at_turn` adds a soft instruction to synthesize
before the hard turn limit is reached.

Environment variables:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `CLAUDE_COMPANION_TASK_PROFILE` | `standard` | Default task profile (`quick`, `standard`, or `deep`) |
| `CLAUDE_COMPANION_MODEL` | unset | Task model override, including `sonnet`, `opus`, or `fable` |
| `CLAUDE_COMPANION_EFFORT` | unset | Task effort override (`low`, `medium`, or `high`) |
| `CLAUDE_COMPANION_MAX_TURNS` | unset | Task turn-limit override |
| `CLAUDE_COMPANION_FINALIZE_AT_TURN` | unset | Task finalization-turn override |
| `CLAUDE_COMPANION_MAX_BUDGET_USD` | unset | Task soft-budget override |
| `CLAUDE_COMPANION_TASK_TIMEOUT_MS` | unset | Task wall-clock timeout override |
| `CLAUDE_COMPANION_REVIEW_BASE` | unset | Default review base ref |
| `CLAUDE_COMPANION_REVIEW_MODEL` | unset | Default Claude model for review commands |
| `CLAUDE_COMPANION_REVIEW_PROFILE` | `standard` | Default review budget profile (`quick`, `standard`, or `deep`) |
| `CLAUDE_COMPANION_REVIEW_EVIDENCE_LEASE` | `off` | Enable the experimental single-invocation, MCP-bounded review evidence path |
| `CLAUDE_COMPANION_BACKGROUND_TIMEOUT_MS` | `3600000` | Detached-job wall-clock limit |
| `CLAUDE_COMPANION_STARTING_TIMEOUT_MS` | `60000` | Stale starting-record limit |
| `CLAUDE_COMPANION_RETENTION_DAYS` | `30` | Finished-job retention age |
| `CLAUDE_COMPANION_MAX_COMPLETED_JOBS` | `100` | Finished-job count retained per workspace |
| `CLAUDE_COMPANION_WRITE_ARTIFACT_TTL_MS` | `604800000` | Time before an unapplied terminal write artifact is discarded on SessionStart |
| `CLAUDE_COMPANION_REVIEW_GATE` | unset | Override review gate state (`1`/`true`/`yes`/`on` or `0`/`false`/`no`/`off`) |

Runtime settings use this precedence: CLI flags, project configuration, user
configuration, environment variables, then built-in defaults. Project settings
live at `.codex/cc-plugin-codex.json`; user settings live at
`~/.codex/claude-companion/config.json` (or the path in
`CLAUDE_COMPANION_CONFIG_FILE`). Both files accept the following shape:

```json
{
  "task": {
    "profile": "standard",
    "profiles": {
      "quick": { "model": "sonnet", "effort": "low", "maxTurns": 4, "finalizeAtTurn": 3, "maxBudgetUsd": 0.5, "timeoutMs": 120000 },
      "standard": { "model": "sonnet", "effort": "medium", "maxTurns": 8, "finalizeAtTurn": 6, "maxBudgetUsd": 1.5, "timeoutMs": 300000 },
      "deep": { "model": "opus", "effort": "high", "maxTurns": 16, "finalizeAtTurn": 12, "maxBudgetUsd": 5, "timeoutMs": 900000 }
    }
  },
  "review": {
    "base": "main",
    "model": "sonnet",
    "profile": "standard",
    "evidenceLeaseEnabled": false,
    "profiles": {
      "gate": { "model": "sonnet", "effort": "low", "maxTurns": 4, "finalizeAtTurn": 3, "evidenceUnits": 2, "evidenceMaxTurns": 6, "maxBudgetUsd": 0.2, "timeoutMs": 90000 },
      "quick": { "model": "sonnet", "effort": "low", "maxTurns": 6, "finalizeAtTurn": 4, "evidenceUnits": 3, "evidenceMaxTurns": 7, "maxBudgetUsd": 0.3, "timeoutMs": 120000 },
      "standard": { "model": "sonnet", "effort": "medium", "maxTurns": 12, "finalizeAtTurn": 9, "evidenceUnits": 5, "evidenceMaxTurns": 9, "maxBudgetUsd": 1, "timeoutMs": 240000 },
      "deep": { "model": "opus", "effort": "high", "maxTurns": 24, "finalizeAtTurn": 20, "evidenceUnits": 8, "evidenceMaxTurns": 12, "maxBudgetUsd": 3, "timeoutMs": 600000 }
    }
  },
  "jobs": { "backgroundTimeoutMs": 3600000 }
}
```

Unknown sections and fields, malformed JSON, non-positive numeric limits, and
review settings above the built-in safety ceilings are rejected before Claude
is started. Write permission is deliberately not a
configuration field: every write-capable task still requires `--write`.

Plugin jobs and configuration live under Codex-provided `PLUGIN_DATA` when
available. Standalone script execution falls back to the user's Codex data
directory. Records are workspace-scoped and written atomically.

Completed results and structured budget failures expose Claude's requested
model, effective models, token usage, per-model usage, total cost, turn count,
and API/runtime duration when the installed Claude CLI provides those fields.
JSON output also includes a cross-model `total_tokens` convenience value; older
CLI payloads return `null` for unavailable metadata.
The bundled task, result, review, and adversarial-review skills require these
metrics to be included in the user-facing response. Background launch output
cannot know final usage; retrieve it with `claude-result` after completion.

## Prompt contracts

Prompts are versioned files under `prompts/`, not hidden strings in command
handlers. Template interpolation is whitelist-only: missing or unexpected
variables fail before Claude is started. Each tracked job records the template
name, version, and SHA-256 hash so the exact prompt contract can be audited.

Review and Stop-gate prompts use JSON Schemas under `schemas/`. Human-readable
text is still retained, while machine decisions consume Claude's structured
output. User task text is wrapped as untrusted task content and is never treated
as a plugin control instruction.

Review profiles bound turns, soft budget, and wall-clock time without
automatically chaining or falling back across models. Gate, quick, and standard
request Sonnet; an explicitly selected deep review requests Opus. A review must report examined and skipped files,
uncertainty, budget exhaustion, and a focused follow-up profile. Use `quick` for
small scans, `standard` for normal reviews, and `deep` for security, concurrency,
migrations, or core state machines. Typed MCP budget fields override the selected
profile for one invocation.

The experimental Evidence Lease path is default-off. When enabled, one Claude
invocation receives exactly three read-only MCP tools: `review_diff`,
`review_file`, and `review_context`. Quick, standard, and deep receive 3, 5, and
8 evidence units respectively. The server moves the job to `finalizing` when
the lease reaches zero and returns structured denials without new evidence for
later calls. `evidence_lease_exhausted` is normal investigation closure;
`cost_budget_exhausted` and `turn_limit_reached` are distinct circuit breakers.
No condition automatically resumes, retries, changes model, or expands budget.
For review, `finalize_at_turn` remains only a deprecated compatibility hint
while the feature flag is off.

Claude's `--max-turns` limits agentic turns; its reported `num_turns`
uses a broader usage counter and may be numerically higher. The plugin treats
the dollar budget as a soft target that Claude CLI can slightly exceed; only the
wall-clock timeout is enforced by the plugin as a hard execution ceiling. Both
turn counters and the final cost are preserved for auditability.

With Evidence Lease disabled, large reviews retain the bounded manifest and
legacy diff-adapter behavior. With it enabled, diff and follow-up context are
returned only by the job-local evidence MCP, capped at 64 KiB per response and
confined by real paths to the workspace.

## Security model

- Evidence-enabled review and adversarial review disable all Claude built-ins,
  use an exact MCP allowlist, and run Claude from a unique empty control cwd.
  The feature-off compatibility path and default read-only tasks retain their
  existing plan-mode behavior.
- Write access requires the explicit task `--write` flag, an exact-version
  sandbox compatibility preflight bound to the canonical Claude executable
  hash, and Claude `acceptEdits` inside an isolated standalone clone. Source
  files and index are unchanged until explicit apply.
- Write success creates an owner-only binary patch artifact and stops at
  `awaiting_apply`. Apply never stages, commits, merges, or pushes. Overlapping
  source drift is blocked; unrelated drift needs a second confirmation tied to
  the same patch hash. Discard removes the artifact and isolated workspace. If
  apply starts but its result cannot be verified, the job enters
  `recovery_required`: no automatic rollback or cleanup is attempted, and the
  retained artifact must be inspected manually.
- The optional Stop review gate is disabled by default. Explicitly enable or
  disable it through `claude-companion-admin review-gate enable|disable`; this
  break-glass path remains available when MCP is down. The gate uses its own bounded profile
  (4 turns, $0.20, 90 seconds by default) and caches unchanged verdicts for 30
  minutes so repeated Stop events do not repeat the same model call.
- Claude authentication remains in Claude Code's credential store; this plugin
  neither reads nor stores credentials.
- Detached prompt request files are owner-only, consumed by the worker, and
  removed promptly. Job state stores metadata and final results.
- Cancellation terminates the bridge-owned process tree. It is best-effort on
  platforms where process-tree signaling differs.

## Background jobs

Request background execution through the relevant Skill/MCP tool. The detached worker consumes Claude's
`stream-json` events and reports phases such as investigating, editing,
verifying, retrying, and finalizing. `claude_jobs_list` returns bounded workspace
history by default; global scope and filters must be explicit. Status, result,
cancel, apply, and discard always require a job ID. Waiting is a bounded
client-side loop over `claude_job_status`; the server does not hold a long poll.
Session start reconciles stale records.
Session end prunes old finished records but never terminates active work.

When MCP cannot start, `claude-companion-admin` is limited to doctor/probe,
review-gate control, job list/reconcile/cancel, and artifact inspect/safe
discard. It cannot start reviews/tasks or apply an artifact. `partial_apply`
always requires manual recovery and cannot be auto-discarded.

Terminal phases match their status (`done`, `failed`, `cancelled`, or
`timed_out`). Claude error subtypes such as `error_max_turns` are retained with
a stable error kind, recovery suggestion, and resume session when available.
Resume is always explicit. When a detached resume can be linked to a prior job,
status and result JSON include `parent_job_id` and
`cumulative_chain_cost_usd`; the plugin never resumes or retries automatically.
Legacy records are normalized only while reading and labelled `legacy-partial`.

## Platform support

The source targets macOS, Linux, and Windows with Node.js 22 in the included
GitHub Actions matrix. Full behavioral tests currently run on macOS and Linux;
Windows validates metadata and JavaScript syntax until the fake-CLI fixtures are
replaced with native Windows executables.

| Platform | Status | Notes |
| --- | --- | --- |
| macOS | Write verified for Claude 2.1.208 | Seatbelt + compatibility manifest; other versions fail closed |
| Linux | Read/review CI-targeted; write unavailable by default | Write needs bwrap+socat and a verified manifest entry |
| Windows | Read/review syntax CI-targeted; write unsupported | No native write sandbox is claimed |

CI behavioral coverage currently validates macOS and Linux. A real Claude
invocation still depends on credentials and local Claude Code behavior and is
therefore a separate authenticated E2E check.

## Verification

Run the self-contained release check:

```sh
npm run check
```

It checks JavaScript syntax, metadata alignment, the nine-skill surface, and
the complete Node test suite. `node scripts/check.mjs --syntax-only` performs
only metadata and syntax checks.

## Troubleshooting

- **`claude` not found:** install `@anthropic-ai/claude-code`, ensure it is on
  `PATH`, and rerun `/claude-setup`.
- **Claude reports authentication failure:** run `claude` interactively and
  complete login. The plugin cannot perform login for you.
- **Codex cannot access Claude credentials:** in automatic-approval mode the
  skill immediately makes an escalation-capable tool call when the workspace
  boundary is known to block Claude, without asking for pre-confirmation. In
  unrestricted/full-access mode it runs directly without escalation. A
  workspace sandbox with approvals disabled cannot reach an external credential
  store; change the permission profile instead of retrying. Manual-approval mode
  may still prompt when escalation is required. If host policy denies repository
  export, retry only after the permission profile or host authorization actually
  changes; conversational consent alone does not change that boundary.
- **A job appears stuck:** run `/claude-status <id> --wait --timeout-ms ...`.
  Session-start reconciliation also marks dead, stale, or overdue jobs.
- **A review omitted the diff:** large change sets intentionally include the
  changed-file inventory instead of injecting an oversized diff. Claude can
  inspect files with read-only tools.
- **Skills do not reflect an update:** reinstall the plugin and restart Codex;
  marketplace caches are keyed by the manifest version.

## Uninstalling

Disable the optional gate first, uninstall the plugin, and restart Codex:

```text
/claude-setup --disable-review-gate
/plugin uninstall cc-plugin-codex@personal
```

Removing the plugin does not remove Claude Code or its authentication. Persisted
job history under the plugin data directory may be deleted separately if no
longer needed.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
