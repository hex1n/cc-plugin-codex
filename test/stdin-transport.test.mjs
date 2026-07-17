import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { callMcp } from "./helpers/mcp-client.js";

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
  const result = await callMcp(fx.env, "claude_task_readonly", { workspace_root: fx.cwd, task: marker, model: "sonnet", effort: "high" });
  assert.equal(result.result, "stdin-ok");
  const invocation = JSON.parse(await readFile(fx.capture, "utf8"));
  assert.match(invocation.prompt, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert(!invocation.args.includes("--"));
  assert(invocation.args.every(value => !value.includes(marker)));
  assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], "sonnet");
  assert.equal(invocation.args[invocation.args.indexOf("--effort") + 1], "high");
});

test("background stream-json Claude receives the rendered prompt only through stdin", async () => {
  const fx = await fixture("background"), marker = "background stdin marker";
  const launched = await callMcp(fx.env, "claude_task_readonly", { workspace_root: fx.cwd, task: marker, background: true });
  const id = launched.id;
  await poll(() => callMcp(fx.env, "claude_job_status", { workspace_root: fx.cwd, job_id: id }), value => value.status === "completed");
  const invocation = JSON.parse(await readFile(fx.capture, "utf8"));
  assert.match(invocation.prompt, new RegExp(marker));
  assert(invocation.args.includes("stream-json"));
  assert(!invocation.args.includes("--"));
  assert(invocation.args.every(value => !value.includes(marker)));
  const result = await callMcp(fx.env, "claude_job_result", { workspace_root: fx.cwd, job_id: id });
  assert.equal(result.result, "stdin-ok");
});
