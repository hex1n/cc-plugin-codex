import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const companion = resolve("scripts/claude-companion.mjs");
function run(args, { cwd, env }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [companion, ...args], { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject); child.once("close", code => resolveRun({ code, stdout, stderr }));
  });
}
async function poll(fn, predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (predicate(value)) return value; await new Promise(resolveWait => setTimeout(resolveWait, 40)); }
  throw new Error("Timed out waiting for background job state");
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "claude-companion-test-"));
  const cwd = join(root, "workspace"), state = join(root, "state"), fake = join(root, "claude-fake.mjs");
  const nested = join(cwd, "nested");
  await mkdir(nested, { recursive: true });
  const initialized = await new Promise((resolveInit, reject) => { const child = spawn("git", ["init", "--quiet"], { cwd, shell: false }); child.once("error", reject); child.once("close", code => resolveInit(code)); });
  assert.equal(initialized, 0);
  await writeFile(fake, `#!/usr/bin/env node\nconst raw=process.argv.at(-1),prompt=raw.match(/<task>\\s*([\\s\\S]*?)\\s*<\\/task>/)?.[1]??raw;\nif (prompt === "sleep") { process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000); } else { console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"done:"+prompt,session_id:"session-123"})); }\n`);
  await chmod(fake, 0o755);
  return { cwd, nested, env: { ...process.env, CLAUDE_CODE_EXECUTABLE: fake, CLAUDE_COMPANION_STATE_ROOT: state } };
}

test("detached jobs can be listed and their result read", async () => {
  const fx = await fixture();
  const launched = await run(["task", "hello", "--background", "--json"], { ...fx, cwd: fx.nested });
  assert.equal(launched.code, 0, launched.stderr);
  const id = JSON.parse(launched.stdout).job.id;
  const completed = await poll(() => run(["status", id, "--json"], fx), value => JSON.parse(value.stdout).job.status === "completed");
  assert.equal(JSON.parse(completed.stdout).job.profile, "task");
  const [workspaceState] = await readdir(fx.env.CLAUDE_COMPANION_STATE_ROOT);
  const stateRecord = JSON.parse(await readFile(join(fx.env.CLAUDE_COMPANION_STATE_ROOT, workspaceState, `${id}.json`), "utf8"));
  assert.equal("prompt" in stateRecord, false);
  assert.equal((await stat(stateRecord.stdoutPath)).mode & 0o777, 0o600);
  assert.equal((await stat(stateRecord.stderrPath)).mode & 0o777, 0o600);
  assert.equal((await stat(stateRecord.eventsPath)).mode & 0o777, 0o600);
  const latest = await run(["status", "--json"], fx);
  assert.equal(JSON.parse(latest.stdout).job.id, id);
  const list = await run(["status", "--all", "--json"], fx);
  assert.equal(JSON.parse(list.stdout).jobs[0].id, id);
  const result = await run(["result", id, "--json"], fx);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).result, "done:hello");
  assert.equal(JSON.parse(result.stdout).session_id, "session-123");
});

test("a running detached job can be cancelled", async () => {
  const fx = await fixture();
  const launched = await run(["task", "sleep", "--background", "--json"], fx);
  const id = JSON.parse(launched.stdout).job.id;
  const cancelled = await run(["cancel", id, "--json"], fx);
  assert.equal(cancelled.code, 0, cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).job.status, "cancelled");
  const status = await run(["status", id, "--json"], fx);
  assert.equal(JSON.parse(status.stdout).job.status, "cancelled");
  const result = await run(["result", id, "--json"], fx);
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.stderr).error, /cancelled/);
});

test("implicit status and result prefer the current Codex session", async () => {
  const fx = await fixture(), sessionA = { ...fx, env: { ...fx.env, CODEX_THREAD_ID: "session-a" } }, sessionB = { ...fx, env: { ...fx.env, CODEX_THREAD_ID: "session-b" } };
  const first = JSON.parse((await run(["task", "first", "--background", "--json"], sessionA)).stdout).job.id;
  await poll(() => run(["status", first, "--json"], sessionA), value => JSON.parse(value.stdout).job.status === "completed");
  const second = JSON.parse((await run(["task", "second", "--background", "--json"], sessionB)).stdout).job.id;
  await poll(() => run(["status", second, "--json"], sessionB), value => JSON.parse(value.stdout).job.status === "completed");
  assert.equal(JSON.parse((await run(["status", "--json"], sessionA)).stdout).job.id, first);
  assert.equal(JSON.parse((await run(["result", "--json"], sessionA)).stdout).result, "done:first");
});
