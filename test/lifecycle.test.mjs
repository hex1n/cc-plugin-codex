import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { reconcileJob } from "../scripts/lib/job-lifecycle.mjs";

const hook = resolve("hooks/session-end.mjs"), companion = resolve("scripts/claude-companion.mjs");
function run(script, args, fx, stdin) { return new Promise((resolveRun, reject) => { const child = spawn(process.execPath, [script, ...args], { cwd: fx.cwd, env: fx.env, shell: false, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] }); let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; }); child.once("error", reject); child.once("close", code => resolveRun({ code, stdout, stderr })); if (stdin !== undefined) child.stdin.end(stdin); }); }
async function exists(path) { try { await access(path); return true; } catch { return false; } }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "claude-lifecycle-test-")), workspace = join(root, "workspace"), state = join(root, "state"); await mkdir(workspace); const cwd = await realpath(workspace), directory = join(state, createHash("sha256").update(cwd).digest("hex").slice(0, 16)); await mkdir(directory, { recursive: true });
  const oldStdout = join(directory, "old.stdout.log"), oldStderr = join(directory, "old.stderr.log"), old = { id: "old", cwd, profile: "task", status: "completed", pid: 99999999, stdoutPath: oldStdout, stderrPath: oldStderr, createdAt: "2020-01-01T00:00:00.000Z", finishedAt: "2020-01-01T00:01:00.000Z" };
  const active = { id: "active", cwd, profile: "task", status: "running", pid: process.pid, stdoutPath: join(directory, "active.stdout.log"), stderrPath: join(directory, "active.stderr.log"), createdAt: new Date().toISOString() };
  await writeFile(join(directory, "old.json"), JSON.stringify(old)); await writeFile(oldStdout, "done"); await writeFile(oldStderr, ""); await writeFile(join(directory, "active.json"), JSON.stringify(active)); await writeFile(join(directory, "broken.json"), "{not json");
  return { cwd, directory, env: { ...process.env, CLAUDE_COMPANION_STATE_ROOT: state, CLAUDE_COMPANION_RETENTION_DAYS: "1", CLAUDE_COMPANION_MAX_COMPLETED_JOBS: "100" } };
}

test("SessionEnd prunes expired terminal artifacts but preserves active and corrupt records", async () => {
  const fx = await fixture(), output = await run(hook, [], fx, JSON.stringify({ hook_event_name: "SessionEnd", cwd: fx.cwd }));
  assert.equal(output.code, 0, output.stderr); assert.deepEqual(JSON.parse(output.stdout), { continue: true, suppressOutput: true });
  assert.equal(await exists(join(fx.directory, "old.json")), false); assert.equal(await exists(join(fx.directory, "old.stdout.log")), false);
  assert.equal(await exists(join(fx.directory, "active.json")), true); assert.equal(await exists(join(fx.directory, "broken.json")), true);
});

test("workspace status isolates a corrupt job record instead of failing", async () => {
  const fx = await fixture(), output = await run(companion, ["status", "--all", "--json"], fx);
  assert.equal(output.code, 0, output.stderr); const jobs = JSON.parse(output.stdout).jobs, broken = jobs.find(job => job.id === "broken"); assert.equal(broken.status, "corrupt"); assert.match(broken.error, /JSON|parse|Unexpected/i);
  assert.match(await readFile(join(fx.directory, "broken.json"), "utf8"), /not json/);
});

test("global status discovers other workspaces and hides E2E jobs by default", async () => {
  const fx = await fixture(), other = join(fx.cwd, "other"), otherDirectory = join(fx.env.CLAUDE_COMPANION_STATE_ROOT, createHash("sha256").update(other).digest("hex").slice(0, 16));
  await mkdir(otherDirectory, { recursive: true });
  const createdAt = new Date().toISOString();
  await writeFile(join(otherDirectory, "user-job.json"), JSON.stringify({ id: "user-job", cwd: other, profile: "task", status: "completed", phase: "done", purpose: "user", createdAt, finishedAt: createdAt }));
  await writeFile(join(otherDirectory, "e2e-job.json"), JSON.stringify({ id: "e2e-job", cwd: other, profile: "task", status: "completed", phase: "done", purpose: "e2e", namespace: "cc-plugin-codex-e2e", createdAt, finishedAt: createdAt }));
  const output = await run(companion, ["status", "--global", "--recent", "24h", "--json"], fx);
  assert.equal(output.code, 0, output.stderr);
  assert.deepEqual(new Set(JSON.parse(output.stdout).jobs.map(job => job.id)), new Set(["user-job", "active"]));
  assert.equal(JSON.parse(output.stdout).jobs.some(job => job.id === "e2e-job"), false);
  const withTests = await run(companion, ["status", "--global", "--include-test", "--json"], fx);
  assert.deepEqual(new Set(JSON.parse(withTests.stdout).jobs.map(job => job.id)), new Set(["user-job", "e2e-job", "active", "old", "broken"]));
});

test("reconciliation does not mislabel a worker after cancellation is requested", async () => {
  const job = { id: "cancelling", cwd: "/unused", status: "running", pid: 99999999, cancellationRequestedAt: new Date().toISOString() };
  assert.equal(await reconcileJob(job), job);
});
