const BOOL = new Set(["json", "wait", "all", "background", "write", "continue", "fresh", "help", "enable-review-gate", "disable-review-gate"]);
const VALUE = new Set(["base", "resume", "model", "max-turns", "max-budget-usd", "prompt-file", "timeout-ms", "poll-interval-ms"]);
export function parseArgs(argv) {
  const options = { json: false, wait: false, all: false, background: false, write: false, continue: false, fresh: false, base: null, resume: null, model: null, "max-turns": null, "max-budget-usd": null, "prompt-file": null, "timeout-ms": null, "poll-interval-ms": null, help: false, "enable-review-gate": false, "disable-review-gate": false }, positional = [];
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
  node scripts/claude-companion.mjs review [--base <ref>] [--json] [--wait] [--background]
  node scripts/claude-companion.mjs task [prompt...] [--write] [--resume <session-id>|--continue|--fresh] [--model <model>] [--max-turns <n>] [--max-budget-usd <amount>] [--prompt-file <path>] [--json] [--wait] [--background]
  node scripts/claude-companion.mjs status [job-id] [--wait] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--all] [--json]
  node scripts/claude-companion.mjs result [job-id] [--json]
  node scripts/claude-companion.mjs cancel [job-id] [--json]
  node scripts/claude-companion.mjs adversarial-review [focus...] [--base <ref>] [--json] [--background]
  node scripts/claude-companion.mjs transfer <digest...> [--json]
  node scripts/claude-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]

Commands:
  review   Review the working-tree diff, or changes since a merge base
  task     Ask Claude Code to perform a task (read-only unless --write)
  status   Inspect the current session's latest job, one job, or --all history
  result   Read a completed job result
  cancel   Terminate a running job process tree
  adversarial-review  Challenge a diff using the read-only review profile
  transfer            Turn a Codex digest into a Claude summary seed
  setup               Check Claude CLI installation and authentication`; }
