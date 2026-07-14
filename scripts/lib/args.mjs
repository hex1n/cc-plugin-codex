const BOOL = new Set(["json", "wait", "all", "global", "include-test", "background", "write", "continue", "fresh", "help", "enable-review-gate", "disable-review-gate", "allow-context-drift"]);
const VALUE = new Set(["base", "resume", "model", "effort", "max-turns", "max-budget-usd", "prompt-file", "timeout-ms", "poll-interval-ms", "recent", "status", "purpose", "context", "finalize-at-turn", "review-profile", "task-profile", "review-kind", "target-file", "expected-patch-hash"]);
export function parseArgs(argv) {
  const options = { json: false, wait: false, all: false, global: false, "include-test": false, background: false, write: false, continue: false, fresh: false, base: null, resume: null, model: null, effort: null, "max-turns": null, "max-budget-usd": null, "prompt-file": null, "timeout-ms": null, "poll-interval-ms": null, recent: null, status: null, purpose: null, context: null, "finalize-at-turn": null, "review-profile": null, "task-profile": null, "review-kind": null, "target-file": null, "expected-patch-hash": null, "allow-context-drift": false, help: false, "enable-review-gate": false, "disable-review-gate": false }, positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    } else if (token.startsWith("--") && VALUE.has(token.slice(2))) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`${token} requires a value`);
      options[token.slice(2)] = argv[++i];
    } else if (token.startsWith("--")) {
      const name = token.slice(2);
      if (!BOOL.has(name)) throw new Error(`Unknown flag: ${token}`);
      options[name] = true;
    } else positional.push(token);
  }
  return { command: positional.shift() ?? null, positional, options };
}
export function usage() { return `cc-plugin-codex — call Claude Code from Codex

Usage:
  node scripts/claude-companion.mjs review [--base <ref>] [--review-profile <quick|standard|deep>] [--model <sonnet|opus|fable|id>] [--effort <low|medium|high>] [--max-turns <n>] [--finalize-at-turn <n>] [--max-budget-usd <amount>] [--timeout-ms <ms>] [--json] [--wait] [--background]
  node scripts/claude-companion.mjs review --review-kind plan --target-file <repo-file> [--review-profile <quick|standard|deep>] [--model <sonnet|opus|fable|id>] [--effort <low|medium|high>] [--json] [--background]
  node scripts/claude-companion.mjs task [prompt...] [--write] [--resume <session-id>|--continue|--fresh] [--task-profile <quick|standard|deep>] [--model <sonnet|opus|fable|id>] [--effort <low|medium|high>] [--max-turns <n>] [--finalize-at-turn <n>] [--context <summary|diff|full>] [--max-budget-usd <amount>] [--prompt-file <path>] [--json] [--wait] [--background]
  node scripts/claude-companion.mjs status [job-id] [--wait] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--all|--global] [--recent <24h>] [--status <state>] [--purpose <kind>] [--include-test] [--json]
  node scripts/claude-companion.mjs result [job-id] [--json]
  node scripts/claude-companion.mjs cancel [job-id] [--json]
  node scripts/claude-companion.mjs apply <job-id> [--allow-context-drift --expected-patch-hash <sha256>] [--json]
  node scripts/claude-companion.mjs discard <job-id> [--json]
  node scripts/claude-companion.mjs adversarial-review [focus...] [--base <ref>] [--review-profile <quick|standard|deep>] [--model <model>] [--max-turns <n>] [--finalize-at-turn <n>] [--max-budget-usd <amount>] [--timeout-ms <ms>] [--json] [--background]
  node scripts/claude-companion.mjs transfer <digest...> [--json]
  node scripts/claude-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]

Commands:
  review   Review the working-tree diff, or changes since a merge base
  task     Ask Claude Code to perform a task (read-only unless --write)
  status   Inspect the current session, workspace history, or explicit global history
  result   Read a completed job result
  cancel   Terminate a running job process tree
  apply    Explicitly apply a completed isolated write artifact
  discard  Discard an isolated write artifact and clean its workspace
  adversarial-review  Challenge a diff using the read-only review profile
  transfer            Turn a Codex digest into a Claude summary seed
  setup               Check Claude CLI installation and authentication`; }
