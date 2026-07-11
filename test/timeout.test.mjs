import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { requireSuccessfulTermination } from "../scripts/lib/process.mjs";

test("nonzero platform termination results are rejected", () => {
  assert.throws(() => requireSuccessfulTermination({ code: 1, stderr: "access denied" }, "taskkill"), /access denied/);
  assert.equal(requireSuccessfulTermination({ code: 0, stderr: "" }, "taskkill").code, 0);
});
import { runCommand } from "../scripts/lib/process.mjs";

const companion = resolve("scripts/claude-companion.mjs");
function run(args, { cwd, env }) { return new Promise((resolveRun, reject) => { const child = spawn(process.execPath, [companion, ...args], { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; }); child.once("error", reject); child.once("close", code => resolveRun({ code, stdout, stderr })); }); }
async function fixture(timeoutMs) {
  const root = await mkdtemp(join(tmpdir(), "claude-timeout-test-")), cwd = join(root, "workspace"), state = join(root, "state"), fake = join(root, "claude"), childPid = join(root, "child.pid");
  await mkdir(cwd);
  await writeFile(fake, `#!/usr/bin/env node\nimport {writeFileSync} from "node:fs";const raw=process.argv.at(-1),prompt=raw.match(/<task>\\s*([\\s\\S]*?)\\s*<\\/task>/)?.[1]??raw; if(prompt==="sleep"||prompt==="ignore-term"){writeFileSync(process.env.FAKE_CHILD_PID,String(process.pid));if(prompt==="ignore-term")process.on("SIGTERM",()=>{});setInterval(()=>{},1000)} else console.log(JSON.stringify({type:"result",is_error:false,result:"quick",session_id:"quick-session"}));\n`);
  await chmod(fake, 0o755);
  return { cwd, state, childPid, env: { ...process.env, CLAUDE_CODE_EXECUTABLE: fake, CLAUDE_COMPANION_STATE_ROOT: state, CLAUDE_COMPANION_BACKGROUND_TIMEOUT_MS: String(timeoutMs), FAKE_CHILD_PID: childPid } };
}
async function jobRecord(fx, id) { const [workspace] = await readdir(fx.state); return { path: join(fx.state, workspace, `${id}.json`), value: JSON.parse(await readFile(join(fx.state, workspace, `${id}.json`), "utf8")) }; }
async function pollRecord(fx, id, expected, timeout = 12_000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const record = await jobRecord(fx, id); if (record.value.status === expected) return record.value; await new Promise(resolveWait => setTimeout(resolveWait, 40)); } throw new Error(`Timed out waiting for ${expected}`); }

test("monitor records natural completion without a status poll", async () => {
  const fx = await fixture(10_000), launched = await run(["task", "quick", "--background", "--json"], fx), id = JSON.parse(launched.stdout).job.id;
  const record = await pollRecord(fx, id, "completed");
  assert.equal(record.timeoutMs, 10_000); assert.ok(record.deadlineAt); assert.equal(record.status, "completed");
  const result = await run(["result", id, "--json"], fx); assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).result, "quick");
});

test("monitor terminates and marks an overdue process", async () => {
  const fx = await fixture(200), launched = await run(["task", "sleep", "--background", "--json"], fx), job = JSON.parse(launched.stdout).job;
  const record = await pollRecord(fx, job.id, "timed_out");
  assert.equal(record.status, "timed_out"); assert.equal(record.timeoutMs, 200);
  assert.throws(() => process.kill(job.pid, 0), error => error.code === "ESRCH");
  const result = await run(["result", job.id, "--json"], fx); assert.equal(result.code, 1); assert.match(JSON.parse(result.stderr).error, /wall-clock timeout/);
});

test("timeout escalates when a Claude child ignores SIGTERM", async () => {
  const fx = await fixture(1_000), launched = await run(["task", "ignore-term", "--background", "--json"], fx), job = JSON.parse(launched.stdout).job;
  const childPid = Number(await waitForFile(fx.childPid));
  const record = await pollRecord(fx, job.id, "timed_out");
  assert.equal(record.errorKind, "timeout");
  assert.throws(() => process.kill(childPid, 0), error => error.code === "ESRCH");
});

test("foreground timeout also escalates past ignored SIGTERM", async () => {
  const started = Date.now();
  const result = await runCommand(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),2000)"], { timeoutMs: 100 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 1_500, `foreground timeout took ${Date.now() - started}ms`);
});

test("task --timeout-ms reaches the foreground Claude process", async () => {
  const fx = await fixture(10_000), started = Date.now(), result = await run(["task", "ignore-term", "--timeout-ms", "100", "--json"], fx);
  assert.equal(result.code, 1); assert.match(JSON.parse(result.stderr).error, /timed out/i);
  assert.ok(Date.now() - started < 1_500, `CLI timeout took ${Date.now() - started}ms`);
});

async function waitForFile(path) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) { try { return await readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; } await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`Timed out waiting for ${path}`);
}
