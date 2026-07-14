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
  await command("git", ["init", "--quiet"], cwd); await command("git", ["config", "user.email", "test@example.invalid"], cwd); await command("git", ["config", "user.name", "Test"], cwd); await writeFile(join(cwd, "base.txt"), "base\n"); await command("git", ["add", "base.txt"], cwd); await command("git", ["commit", "--quiet", "-m", "base"], cwd);
  await writeFile(fake, `#!/usr/bin/env node\nimport {writeFileSync} from "node:fs";if(process.argv[2]==="--version"){console.log("2.1.208 (Claude Code)");process.exit(0)}const args=process.argv.slice(2);let prompt="";for await(const chunk of process.stdin)prompt+=chunk;writeFileSync(process.env.CAPTURE_ARGS,JSON.stringify({args,prompt}));if(prompt.includes("structured error")){console.log(JSON.stringify({type:"result",subtype:"error_max_budget_usd",is_error:true,result:"budget",session_id:"task-session",total_cost_usd:0.2}));process.exit(0)}console.log(JSON.stringify({type:"result",is_error:false,result:"done",session_id:"task-session"}));\n`); await chmod(fake, 0o755);
  return { root, cwd, capture, env: { ...process.env, CLAUDE_CODE_EXECUTABLE: fake, CAPTURE_ARGS: capture, CLAUDE_COMPANION_STATE_ROOT: join(root, "state"), CLAUDE_COMPANION_WRITE_ROOT: join(root, "write-workspaces") } };
}

async function captured(fx) { return JSON.parse(await readFile(fx.capture, "utf8")); }

test("task is read-only by default and wraps the user task", async () => {
  const fx = await fixture(), result = await run(["task", "inspect only", "--json"], fx); assert.equal(result.code, 0, result.stderr);
  const { args, prompt } = await captured(fx); assert.ok(args.includes("plan")); assert.ok(!args.includes("acceptEdits")); assert.match(prompt, /<task>\s*inspect only[\s\S]*Beginning with turn 6/);
  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
  assert.equal(args[args.indexOf("--effort") + 1], "medium");
  assert.equal(args[args.indexOf("--max-turns") + 1], "8");
  assert.equal(args[args.indexOf("--max-budget-usd") + 1], "1.5");
  assert.ok(!args.includes("--fallback-model"));
  assert.equal(JSON.parse(result.stdout).task_profile, "standard");
});

test("deep task selects Opus while an explicit Fable model overrides the profile", async () => {
  const deep = await fixture(), deepResult = await run(["task", "complex work", "--task-profile", "deep", "--json"], deep); assert.equal(deepResult.code, 0, deepResult.stderr);
  const deepArgs = (await captured(deep)).args; assert.equal(deepArgs[deepArgs.indexOf("--model") + 1], "opus"); assert.equal(deepArgs[deepArgs.indexOf("--effort") + 1], "high"); assert.equal(JSON.parse(deepResult.stdout).task_profile, "deep");
  const fable = await fixture(), fableResult = await run(["task", "complex work", "--task-profile", "deep", "--model", "fable", "--json"], fable); assert.equal(fableResult.code, 0, fableResult.stderr);
  const fableArgs = (await captured(fable)).args; assert.equal(fableArgs[fableArgs.indexOf("--model") + 1], "fable"); assert.equal(fableArgs[fableArgs.indexOf("--effort") + 1], "high");
});

test("write task rejects an unverified executable before execution", async () => {
  const fx = await fixture(), result = await run(["task", "implement it", "--write", "--model", "sonnet", "--max-turns", "4", "--max-budget-usd", "2.5", "--json"], fx);
  assert.equal(result.code, 1); const error = JSON.parse(result.stderr); assert.equal(error.error_kind, "write_capability_unavailable"); assert.match(error.error, /identity/i);
  await assert.rejects(() => readFile(fx.capture, "utf8"), value => value.code === "ENOENT");
});

function command(executable, args, cwd) { return new Promise((resolveCommand, reject) => { const child = spawn(executable, args, { cwd, shell: false, stdio: "ignore" }); child.once("error", reject); child.once("close", code => code === 0 ? resolveCommand() : reject(new Error(`${executable} exited ${code}`))); }); }

test("a foreground structured error preserves the explicitly requested model", async () => {
  const fx = await fixture(), result = await run(["task", "structured error", "--model", "fable", "--json"], fx);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).requested_model, "fable");
});

test("a one-turn task runs without impossible finalization guidance", async () => {
  const fx = await fixture(), result = await run(["task", "one turn", "--max-turns", "1", "--json"], fx);
  assert.equal(result.code, 0, result.stderr);
  const { args, prompt } = await captured(fx);
  assert.equal(args[args.indexOf("--max-turns") + 1], "1");
  assert.doesNotMatch(prompt, /Beginning with turn/);
});

test("task reads prompts from a file or stdin", async () => {
  const fileFx = await fixture(), promptFile = join(fileFx.root, "task.txt"); await writeFile(promptFile, "from prompt file");
  const fromFile = await run(["task", "--prompt-file", promptFile, "--json"], fileFx); assert.equal(fromFile.code, 0, fromFile.stderr); assert.match((await captured(fileFx)).prompt, /from prompt file/);
  const stdinFx = await fixture(), fromStdin = await run(["task", "--json"], stdinFx, "from stdin"); assert.equal(fromStdin.code, 0, fromStdin.stderr); assert.match((await captured(stdinFx)).prompt, /from stdin/);
});

test("task exposes a compact disclosure summary and finalization budget", async () => {
  const fx = await fixture(), result = await run(["task", "review this design", "--context", "full", "--max-turns", "6", "--finalize-at-turn", "4", "--json"], fx);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout), { prompt } = await captured(fx);
  assert.deepEqual(output.disclosure, { destination: "Claude Code", context: "full", source: "positional", bytes: 18, mode: "read-only", repository_access: "enabled", task_profile: "standard", requested_model: "sonnet", effort: "medium" });
  assert.match(prompt, /Beginning with turn 4/);
});

test("task rejects conflicting session routing controls", async () => {
  const fx = await fixture(), result = await run(["task", "continue", "--resume", "abc", "--fresh", "--json"], fx); assert.equal(result.code, 1); assert.match(JSON.parse(result.stderr).error, /resume.*fresh|fresh.*resume/i);
});

test("task forwards continue while fresh starts without resume flags", async () => {
  const continued = await fixture(), continueResult = await run(["task", "follow up", "--continue", "--json"], continued); assert.equal(continueResult.code, 0, continueResult.stderr); assert.ok((await captured(continued)).args.includes("--continue"));
  const fresh = await fixture(), freshResult = await run(["task", "new attempt", "--fresh", "--json"], fresh); assert.equal(freshResult.code, 0, freshResult.stderr); const freshArgs = (await captured(fresh)).args; assert.ok(!freshArgs.includes("--continue")); assert.ok(!freshArgs.includes("--resume"));
});
