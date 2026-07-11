import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const companion = resolve("scripts/claude-companion.mjs");

function run(args, fx, stdin) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [companion, ...args], { cwd: fx.cwd, env: fx.env, shell: false, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject); child.once("close", code => resolveRun({ code, stdout, stderr })); if (stdin !== undefined) child.stdin.end(stdin);
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "claude-task-options-test-")), cwd = join(root, "workspace"), capture = join(root, "args.json"), fake = join(root, "claude"); await mkdir(cwd);
  await writeFile(fake, `#!/usr/bin/env node\nimport {writeFileSync} from "node:fs";writeFileSync(process.env.CAPTURE_ARGS,JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify({type:"result",is_error:false,result:"done",session_id:"task-session"}));\n`); await chmod(fake, 0o755);
  return { root, cwd, capture, env: { ...process.env, CLAUDE_CODE_EXECUTABLE: fake, CAPTURE_ARGS: capture } };
}

async function captured(fx) { return JSON.parse(await readFile(fx.capture, "utf8")); }

test("task is read-only by default and wraps the user task", async () => {
  const fx = await fixture(), result = await run(["task", "inspect only", "--json"], fx); assert.equal(result.code, 0, result.stderr);
  const args = await captured(fx); assert.ok(args.includes("plan")); assert.ok(!args.includes("acceptEdits")); assert.match(args.at(-1), /<task>\s*inspect only\s*<\/task>/);
});

test("task only enables writes explicitly and forwards runtime limits", async () => {
  const fx = await fixture(), result = await run(["task", "implement it", "--write", "--model", "sonnet", "--max-turns", "4", "--max-budget-usd", "2.5", "--json"], fx); assert.equal(result.code, 0, result.stderr);
  const args = await captured(fx); assert.ok(args.includes("acceptEdits")); assert.equal(args[args.indexOf("--model") + 1], "sonnet"); assert.equal(args[args.indexOf("--max-turns") + 1], "4"); assert.equal(args[args.indexOf("--max-budget-usd") + 1], "2.5");
});

test("task reads prompts from a file or stdin", async () => {
  const fileFx = await fixture(), promptFile = join(fileFx.root, "task.txt"); await writeFile(promptFile, "from prompt file");
  const fromFile = await run(["task", "--prompt-file", promptFile, "--json"], fileFx); assert.equal(fromFile.code, 0, fromFile.stderr); assert.match((await captured(fileFx)).at(-1), /from prompt file/);
  const stdinFx = await fixture(), fromStdin = await run(["task", "--json"], stdinFx, "from stdin"); assert.equal(fromStdin.code, 0, fromStdin.stderr); assert.match((await captured(stdinFx)).at(-1), /from stdin/);
});

test("task exposes a compact disclosure summary and finalization budget", async () => {
  const fx = await fixture(), result = await run(["task", "review this design", "--context", "full", "--max-turns", "6", "--finalize-at-turn", "4", "--json"], fx);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout), args = await captured(fx);
  assert.deepEqual(output.disclosure, { destination: "Claude Code", context: "full", source: "positional", bytes: 18, mode: "read-only", repository_access: "enabled" });
  assert.match(args.at(-1), /Beginning with turn 4/);
});

test("task rejects conflicting session routing controls", async () => {
  const fx = await fixture(), result = await run(["task", "continue", "--resume", "abc", "--fresh", "--json"], fx); assert.equal(result.code, 1); assert.match(JSON.parse(result.stderr).error, /resume.*fresh|fresh.*resume/i);
});

test("task forwards continue while fresh starts without resume flags", async () => {
  const continued = await fixture(), continueResult = await run(["task", "follow up", "--continue", "--json"], continued); assert.equal(continueResult.code, 0, continueResult.stderr); assert.ok((await captured(continued)).includes("--continue"));
  const fresh = await fixture(), freshResult = await run(["task", "new attempt", "--fresh", "--json"], fresh); assert.equal(freshResult.code, 0, freshResult.stderr); const freshArgs = await captured(fresh); assert.ok(!freshArgs.includes("--continue")); assert.ok(!freshArgs.includes("--resume"));
});
