# cc-plugin-codex

[简体中文](README.zh-CN.md) | English

`cc-plugin-codex` lets Codex delegate reviews and tasks to an authenticated
Claude Code CLI. It is the reverse-direction companion to
`openai/codex-plugin-cc`: Codex remains the orchestrator, while Claude Code is
invoked as a local subprocess.

The plugin has no runtime npm dependencies. It requires Node.js 18 or later,
Codex with plugin support, and a working `claude` command whose authentication
is already configured.

It exposes eight skills: setup, review, adversarial review, task, transfer,
status, result, and cancel.

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

For source development, run commands directly from this repository:

```sh
node scripts/claude-companion.mjs setup
node scripts/claude-companion.mjs review
```

## Updating

Refresh the marketplace and reinstall the plugin, then restart Codex:

```text
/plugin marketplace update personal
/plugin install cc-plugin-codex@personal
```

The build metadata suffix in `.codex-plugin/plugin.json` is intentionally
updated for local cache busting while the public release base remains aligned
with `package.json`.

Skill instructions refer to `<PLUGIN_ROOT>` as an agent-resolved placeholder
for the installed plugin directory. It is not a shell environment variable;
this keeps commands independent of both the target repository and the plugin
cache's versioned directory layout. `/claude-setup` reports the corresponding
real plugin root, skills directory, and manifest path for diagnostics.

## Configuration

The default task mode is read-only Claude plan mode. Use `/claude-task --write`
only when Claude should edit the workspace. Useful task controls include
`--model`, `--max-turns`, `--finalize-at-turn`, `--context`,
`--max-budget-usd`, `--prompt-file`, `--resume`,
`--continue`, `--fresh`, and `--background`.

For long inputs, prefer `--prompt-file` so approval and shell displays remain
compact. `--context summary|diff|full` declares how much context is being sent;
it does not silently transform the prompt. JSON results and tracked jobs expose
a compact disclosure summary. `--finalize-at-turn <n>` adds a soft instruction
to synthesize before the hard `--max-turns` limit is reached.

Environment variables:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `CLAUDE_COMPANION_MODEL` | unset | Default Claude model for tasks |
| `CLAUDE_COMPANION_MAX_TURNS` | unset | Default task turn limit |
| `CLAUDE_COMPANION_MAX_BUDGET_USD` | unset | Default task budget limit |
| `CLAUDE_COMPANION_REVIEW_BASE` | unset | Default review base ref |
| `CLAUDE_COMPANION_BACKGROUND_TIMEOUT_MS` | `3600000` | Detached-job wall-clock limit |
| `CLAUDE_COMPANION_STARTING_TIMEOUT_MS` | `60000` | Stale starting-record limit |
| `CLAUDE_COMPANION_RETENTION_DAYS` | `30` | Finished-job retention age |
| `CLAUDE_COMPANION_MAX_COMPLETED_JOBS` | `100` | Finished-job count retained per workspace |
| `CLAUDE_COMPANION_REVIEW_GATE` | unset | Override review gate state (`1`/`true`/`yes`/`on` or `0`/`false`/`no`/`off`) |

Runtime settings use this precedence: CLI flags, project configuration, user
configuration, environment variables, then built-in defaults. Project settings
live at `.codex/cc-plugin-codex.json`; user settings live at
`~/.codex/claude-companion/config.json` (or the path in
`CLAUDE_COMPANION_CONFIG_FILE`). Both files accept the following shape:

```json
{
  "task": { "model": "sonnet", "maxTurns": 8, "maxBudgetUsd": 5 },
  "review": { "base": "main" },
  "jobs": { "backgroundTimeoutMs": 3600000 }
}
```

Unknown sections and fields, malformed JSON, and non-positive numeric limits are
rejected before Claude is started. Write permission is deliberately not a
configuration field: every write-capable task still requires `--write`.

Plugin jobs and configuration live under Codex-provided `PLUGIN_DATA` when
available. Standalone script execution falls back to the user's Codex data
directory. Records are workspace-scoped and written atomically.

Completed foreground and background results expose Claude's token usage,
per-model usage, total cost, turn count, and API/runtime duration when the
installed Claude CLI provides those fields. JSON output also includes a
cross-model `total_tokens` convenience value; older CLI payloads return `null`
for unavailable metadata.

## Prompt contracts

Prompts are versioned files under `prompts/`, not hidden strings in command
handlers. Template interpolation is whitelist-only: missing or unexpected
variables fail before Claude is started. Each tracked job records the template
name, version, and SHA-256 hash so the exact prompt contract can be audited.

Review and Stop-gate prompts use JSON Schemas under `schemas/`. Human-readable
text is still retained, while machine decisions consume Claude's structured
output. User task text is wrapped as untrusted task content and is never treated
as a plugin control instruction.

## Security model

- Review, adversarial review, transfer, and default tasks use Claude plan mode
  with read-oriented tools.
- Write access requires the explicit task `--write` flag and uses Claude's
  `acceptEdits` mode.
- The optional Stop review gate is disabled by default. Enable it with
  `setup --enable-review-gate`, inspect and trust the hook in Codex, and disable
  it with `setup --disable-review-gate`.
- Claude authentication remains in Claude Code's credential store; this plugin
  neither reads nor stores credentials.
- Detached prompt request files are owner-only, consumed by the worker, and
  removed promptly. Job state stores metadata and final results.
- Cancellation terminates the bridge-owned process tree. It is best-effort on
  platforms where process-tree signaling differs.

## Background jobs

Use `--background` for tracked work. The detached worker consumes Claude's
`stream-json` events and reports phases such as investigating, editing,
verifying, retrying, and finalizing. Examples:

```sh
node scripts/claude-companion.mjs task --background --write "Implement the change"
node scripts/claude-companion.mjs status --all
node scripts/claude-companion.mjs status --global --recent 24h
node scripts/claude-companion.mjs status --global --status failed
node scripts/claude-companion.mjs status <job-id> --wait --timeout-ms 300000
node scripts/claude-companion.mjs result
node scripts/claude-companion.mjs cancel
```

`status` without an ID returns the current Codex session's latest job; `--all`
returns full workspace history. Explicit `--global` searches all persisted
workspaces; test jobs stay hidden unless `--include-test` is present. Filters
include `--recent 30m|24h|7d`, `--status`, and `--purpose`. `result` and `cancel` without an ID select the
current session's latest applicable job. Session start reconciles stale records.
Session end prunes old finished records but never terminates active work.

Terminal phases match their status (`done`, `failed`, `cancelled`, or
`timed_out`). Claude error subtypes such as `error_max_turns` are retained with
a stable error kind, recovery suggestion, and resume session when available.
Legacy records are normalized only while reading and labelled `legacy-partial`.

## Platform support

The source targets macOS, Linux, and Windows with Node.js 22 in the included
GitHub Actions matrix. Full behavioral tests currently run on macOS and Linux;
Windows validates metadata and JavaScript syntax until the fake-CLI fixtures are
replaced with native Windows executables.

| Platform | Status | Notes |
| --- | --- | --- |
| macOS | Locally verified | Full source tests and Claude CLI E2E are supported |
| Linux | CI-targeted | Requires a locally authenticated Claude Code CLI |
| Windows | Syntax CI-targeted | Metadata and syntax are checked; behavioral fixture portability remains open |

CI behavioral coverage currently validates macOS and Linux. A real Claude
invocation still depends on credentials and local Claude Code behavior and is
therefore a separate authenticated E2E check.

## Verification

Run the self-contained release check:

```sh
npm run check
```

It checks JavaScript syntax, metadata alignment, the eight-skill surface, and
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
