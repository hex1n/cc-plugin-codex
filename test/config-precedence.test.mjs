import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { loadRuntimeConfig, readReviewGateConfig } from "../scripts/lib/config.mjs";

const companion = resolve("scripts/claude-companion.mjs");

async function writeJson(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

test("config precedence is project over user over environment over defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-config-layers-"));
  const workspace = join(root, "repo", "nested");
  const userFile = join(root, "home", ".codex", "claude-companion", "config.json");
  await mkdir(workspace, { recursive: true });
  await writeJson(userFile, { task: { model: "user-model", maxTurns: 8, maxBudgetUsd: 3 }, jobs: { backgroundTimeoutMs: 9000 } });
  await writeJson(join(root, "repo", ".codex", "cc-plugin-codex.json"), { task: { model: "project-model", maxTurns: 5 } });

  const config = await loadRuntimeConfig({
    cwd: workspace,
    home: join(root, "home"),
    env: { CLAUDE_COMPANION_MODEL: "env-model", CLAUDE_COMPANION_MAX_TURNS: "12", CLAUDE_COMPANION_MAX_BUDGET_USD: "7", CLAUDE_COMPANION_BACKGROUND_TIMEOUT_MS: "12000" }
  });

  assert.deepEqual(config.task, { model: "project-model", maxTurns: 5, maxBudgetUsd: 3 });
  assert.equal(config.jobs.backgroundTimeoutMs, 9000);
  assert.equal(config.sources.project, join(root, "repo", ".codex", "cc-plugin-codex.json"));
  assert.equal(config.sources.user, userFile);
});

test("CLI task options override project configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-config-cli-"));
  const cwd = join(root, "repo"), capture = join(root, "args.json"), fake = join(root, "claude");
  await mkdir(cwd, { recursive: true });
  await writeJson(join(cwd, ".codex", "cc-plugin-codex.json"), { task: { model: "project-model", maxTurns: 5, maxBudgetUsd: 2 } });
  await writeFile(fake, `#!/usr/bin/env node\nimport {writeFileSync} from "node:fs";writeFileSync(process.env.CAPTURE_ARGS,JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify({type:"result",is_error:false,result:"done"}));\n`);
  await chmod(fake, 0o755);
  const result = await run(["task", "inspect", "--model", "cli-model", "--max-turns", "2", "--json"], cwd, { ...process.env, HOME: join(root, "home"), CLAUDE_CODE_EXECUTABLE: fake, CAPTURE_ARGS: capture });
  assert.equal(result.code, 0, result.stderr);
  const args = JSON.parse(await readFile(capture, "utf8"));
  assert.equal(args[args.indexOf("--model") + 1], "cli-model");
  assert.equal(args[args.indexOf("--max-turns") + 1], "2");
  assert.equal(args[args.indexOf("--max-budget-usd") + 1], "2");
});

test("invalid configuration fails before Claude starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-config-invalid-"));
  const cwd = join(root, "repo");
  await mkdir(cwd, { recursive: true });
  await writeJson(join(cwd, ".codex", "cc-plugin-codex.json"), { task: { maxTurns: 0 } });
  await assert.rejects(() => loadRuntimeConfig({ cwd, home: join(root, "home"), env: {} }), /maxTurns.*positive integer/i);
});

test("review gate environment override is explicit and validated", async () => {
  const previous = process.env.CLAUDE_COMPANION_REVIEW_GATE;
  try {
    process.env.CLAUDE_COMPANION_REVIEW_GATE = "on";
    const enabled = await readReviewGateConfig();
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.source, "environment");
    process.env.CLAUDE_COMPANION_REVIEW_GATE = "off";
    assert.equal((await readReviewGateConfig()).enabled, false);
    process.env.CLAUDE_COMPANION_REVIEW_GATE = "maybe";
    await assert.rejects(() => readReviewGateConfig(), /must be one of/);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_COMPANION_REVIEW_GATE;
    else process.env.CLAUDE_COMPANION_REVIEW_GATE = previous;
  }
});

function run(args, cwd, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [companion, ...args], { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject); child.once("close", code => resolveRun({ code, stdout, stderr }));
  });
}
