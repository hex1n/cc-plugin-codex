import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const hook = resolve("hooks/session-start.mjs");

function runHook(fx) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [hook], { cwd: fx.cwd, env: fx.env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject); child.once("close", code => resolveRun({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", cwd: fx.cwd }));
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "session-start-test-")), workspace = join(root, "workspace"), state = join(root, "state");
  await mkdir(workspace); const cwd = await realpath(workspace);
  const directory = join(state, createHash("sha256").update(cwd).digest("hex").slice(0, 16));
  await mkdir(directory, { recursive: true });
  return { cwd, directory, env: { ...process.env, CLAUDE_COMPANION_STATE_ROOT: state, CLAUDE_COMPANION_STARTING_TIMEOUT_MS: "50", CLAUDE_COMPANION_WRITE_ARTIFACT_TTL_MS: "50" } };
}

async function put(fx, record) { await writeFile(join(fx.directory, `${record.id}.json`), `${JSON.stringify({ cwd: fx.cwd, profile: "task", createdAt: new Date(Date.now() - 5_000).toISOString(), ...record })}\n`); }
async function get(fx, id) { return JSON.parse(await readFile(join(fx.directory, `${id}.json`), "utf8")); }
async function waitForExit(pid) { const deadline = Date.now() + 2_000; while (Date.now() < deadline) { try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return; throw error; } await new Promise(resolveWait => setTimeout(resolveWait, 20)); } throw new Error(`PID ${pid} did not exit`); }

test("SessionStart reconciles dead, overdue, and abandoned workspace jobs", async () => {
  const fx = await fixture();
  const sleeper = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" }); sleeper.unref();
  await put(fx, { id: "dead", status: "running", pid: 2_147_483_647, deadlineAt: new Date(Date.now() + 60_000).toISOString() });
  await put(fx, { id: "overdue", status: "running", pid: sleeper.pid, timeoutMs: 100, deadlineAt: new Date(Date.now() - 1_000).toISOString() });
  await put(fx, { id: "abandoned", status: "starting", pid: null });
  const isolated = join(fx.directory, "expired-workspace"), settingsPath = join(fx.directory, "expired.settings.json"); await mkdir(isolated); await writeFile(settingsPath, "{}\n"); await writeFile(join(fx.directory, "expired.patch"), "patch\n");
  await put(fx, { id: "expired", status: "completed", phase: "awaiting_apply", finishedAt: new Date(Date.now() - 5_000).toISOString(), pid: null, write: true, artifactStatus: "awaiting_apply", isolatedRoot: isolated, settingsPath });
  await put(fx, { id: "retry-cleanup", status: "completed", phase: "discarded", finishedAt: new Date(Date.now() - 5_000).toISOString(), pid: null, write: true, artifactStatus: "discarded", cleanupPending: true, isolatedRoot: join(fx.directory, "already-gone") });
  const recovery = join(fx.directory, "recovery-workspace"); await mkdir(recovery);
  await put(fx, { id: "recovery", status: "completed", phase: "recovery_required", finishedAt: new Date(Date.now() - 5_000).toISOString(), pid: null, write: true, artifactStatus: "partial_apply", recoveryRequired: true, cleanupPending: false, isolatedRoot: recovery });
  const result = await runHook(fx);
  assert.equal(result.code, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { continue: true, suppressOutput: true });
  assert.equal((await get(fx, "dead")).status, "failed");
  assert.equal((await get(fx, "overdue")).status, "timed_out");
  assert.equal((await get(fx, "abandoned")).status, "failed");
  assert.equal((await get(fx, "expired")).artifactStatus, "discarded");
  assert.equal((await get(fx, "retry-cleanup")).cleanupPending, false);
  assert.equal((await get(fx, "recovery")).recoveryRequired, true);
  assert.equal((await stat(recovery)).isDirectory(), true);
  await assert.rejects(() => stat(isolated), error => error.code === "ENOENT");
  await assert.rejects(() => stat(settingsPath), error => error.code === "ENOENT");
  await waitForExit(sleeper.pid);
});
