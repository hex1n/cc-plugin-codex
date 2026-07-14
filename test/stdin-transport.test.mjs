import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const companion = resolve("scripts/claude-companion.mjs");

function run(args, fx) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [companion, ...args], { cwd: fx.cwd, env: fx.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject); child.once("close", code => resolveRun({ code, stdout, stderr }));
  });
}

async function poll(fn, predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (predicate(value)) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 40));
  }
  throw new Error("Timed out waiting for detached stdin fixture");
}

async function fixture(name) {
  const root = await mkdtemp(join(tmpdir(), `claude-stdin-${name}-`)), cwd = join(root, "workspace"), state = join(root, "state"), capture = join(root, "capture.json"), fake = join(root, "claude.mjs");
  await mkdir(cwd);
  await new Promise((resolveInit, reject) => { const child = spawn("git", ["init", "--quiet"], { cwd, shell: false }); child.once("error", reject); child.once("close", code => code === 0 ? resolveInit() : reject(new Error(`git init exited ${code}`))); });
  await writeFile(fake, `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2);
await writeFile(process.env.CAPTURE_INVOCATION, JSON.stringify({ args, prompt }));
const result = { type: "result", subtype: "success", is_error: false, result: "stdin-ok", session_id: "stdin-session", usage: { input_tokens: 1, output_tokens: 1 } };
if (args.includes("stream-json")) process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "stdin-session" }) + "\\n");
process.stdout.write(JSON.stringify(result) + "\\n");
`);
  await chmod(fake, 0o755);
  return { cwd, capture, env: { ...process.env, CLAUDE_CODE_EXECUTABLE: fake, CAPTURE_INVOCATION: capture, CLAUDE_COMPANION_STATE_ROOT: state } };
}

test("foreground Claude receives the rendered prompt only through stdin", async () => {
  const fx = await fixture("foreground"), marker = "literal --model fable\n第二行";
  const result = await run(["task", marker, "--model", "sonnet", "--effort", "high", "--json"], fx);
  assert.equal(result.code, 0, result.stderr);
  const invocation = JSON.parse(await readFile(fx.capture, "utf8"));
  assert.match(invocation.prompt, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert(!invocation.args.includes("--"));
  assert(invocation.args.every(value => !value.includes(marker)));
  assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], "sonnet");
  assert.equal(invocation.args[invocation.args.indexOf("--effort") + 1], "high");
});

test("background stream-json Claude receives the rendered prompt only through stdin", async () => {
  const fx = await fixture("background"), marker = "background stdin marker";
  const launched = await run(["task", marker, "--background", "--json"], fx);
  assert.equal(launched.code, 0, launched.stderr);
  const id = JSON.parse(launched.stdout).job.id;
  await poll(() => run(["status", id, "--json"], fx), value => JSON.parse(value.stdout).job.status === "completed");
  const invocation = JSON.parse(await readFile(fx.capture, "utf8"));
  assert.match(invocation.prompt, new RegExp(marker));
  assert(invocation.args.includes("stream-json"));
  assert(!invocation.args.includes("--"));
  assert(invocation.args.every(value => !value.includes(marker)));
  const result = JSON.parse((await run(["result", id, "--json"], fx)).stdout);
  assert.equal(result.result, "stdin-ok");
});
