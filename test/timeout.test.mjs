import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { requireSuccessfulTermination } from "../scripts/lib/process.mjs";
import { callMcp, callMcpRaw } from "./helpers/mcp-client.js";

test("nonzero platform termination results are rejected", () => {
  assert.throws(() => requireSuccessfulTermination({ code: 1, stderr: "access denied" }, "taskkill"), /access denied/);
  assert.equal(requireSuccessfulTermination({ code: 0, stderr: "" }, "taskkill").code, 0);
});
import { runCommand } from "../scripts/lib/process.mjs";

async function fixture(timeoutMs) {
  const root = await mkdtemp(join(tmpdir(), "claude-timeout-test-")), cwd = join(root, "workspace"), state = join(root, "state"), fake = join(root, "claude"), childPid = join(root, "child.pid");
  await mkdir(cwd);
  await writeFile(fake, `#!/usr/bin/env node\nimport {writeFileSync} from "node:fs";let raw="";for await(const chunk of process.stdin)raw+=chunk;const wrapped=raw.match(/<task>\\s*([\\s\\S]*?)\\s*<\\/task>/)?.[1]??raw,prompt=wrapped.split("\\n\\nTurn budget:")[0]; if(prompt==="sleep"||prompt==="ignore-term"){writeFileSync(process.env.FAKE_CHILD_PID,String(process.pid));if(prompt==="ignore-term")process.on("SIGTERM",()=>{});setInterval(()=>{},1000)} else console.log(JSON.stringify({type:"result",is_error:false,result:"quick",session_id:"quick-session"}));\n`);
  await chmod(fake, 0o755);
  return { cwd, state, childPid, env: { ...process.env, CLAUDE_CODE_EXECUTABLE: fake, CLAUDE_COMPANION_STATE_ROOT: state, CLAUDE_COMPANION_BACKGROUND_TIMEOUT_MS: String(timeoutMs), FAKE_CHILD_PID: childPid } };
}
async function jobRecord(fx, id) { const [workspace] = await readdir(fx.state); return { path: join(fx.state, workspace, `${id}.json`), value: JSON.parse(await readFile(join(fx.state, workspace, `${id}.json`), "utf8")) }; }
async function pollRecord(fx, id, expected, timeout = 12_000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const record = await jobRecord(fx, id); if (record.value.status === expected) return record.value; await new Promise(resolveWait => setTimeout(resolveWait, 40)); } throw new Error(`Timed out waiting for ${expected}`); }

test("monitor records natural completion without a status poll", async () => {
  const fx = await fixture(10_000), launched = await callMcp(fx.env, "claude_task_readonly", { workspace_root: fx.cwd, task: "quick", background: true }), id = launched.id;
  const record = await pollRecord(fx, id, "completed");
  assert.equal(record.timeoutMs, 10_000); assert.ok(record.deadlineAt); assert.equal(record.status, "completed");
  const result = await callMcp(fx.env, "claude_job_result", { workspace_root: fx.cwd, job_id: id }); assert.equal(result.result, "quick");
});

test("monitor terminates and marks an overdue process", async () => {
  const fx = await fixture(200), job = await callMcp(fx.env, "claude_task_readonly", { workspace_root: fx.cwd, task: "sleep", background: true });
  const record = await pollRecord(fx, job.id, "timed_out");
  assert.equal(record.status, "timed_out"); assert.equal(record.timeoutMs, 200);
  assert.throws(() => process.kill(job.pid, 0), error => error.code === "ESRCH");
  const result = await callMcpRaw(fx.env, "claude_job_result", { workspace_root: fx.cwd, job_id: job.id }); assert.equal(result.error.code, -32603); assert.match(result.error.message, /wall-clock timeout/);
});

test("timeout escalates when a Claude child ignores SIGTERM", async () => {
  const fx = await fixture(5_000), job = await callMcp(fx.env, "claude_task_readonly", { workspace_root: fx.cwd, task: "ignore-term", background: true });
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

test("MCP timeout_ms reaches the foreground Claude process", async () => {
  const fx = await fixture(10_000), started = Date.now(), result = await callMcpRaw(fx.env, "claude_task_readonly", { workspace_root: fx.cwd, task: "ignore-term", timeout_ms: 100 });
  assert.equal(result.error.code, -32603); assert.match(result.error.message, /timed out/i);
  assert.ok(Date.now() - started < 1_500, `CLI timeout took ${Date.now() - started}ms`);
});

async function waitForFile(path) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) { try { return await readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; } await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`Timed out waiting for ${path}`);
}
