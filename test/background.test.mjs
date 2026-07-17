import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { callMcp, callMcpRaw } from "./helpers/mcp-client.js";

async function poll(fn, predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (predicate(value)) return value; await new Promise(resolveWait => setTimeout(resolveWait, 40)); }
  throw new Error("Timed out waiting for background job state");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "claude-mcp-background-test-"));
  const cwd = join(root, "workspace"), state = join(root, "state"), fake = join(root, "claude-fake.mjs"), nested = join(cwd, "nested");
  await mkdir(nested, { recursive: true });
  const initialized = await new Promise((resolveInit, reject) => { const child = spawn("git", ["init", "--quiet"], { cwd, shell: false }); child.once("error", reject); child.once("close", code => resolveInit(code)); });
  assert.equal(initialized, 0);
  await writeFile(fake, `#!/usr/bin/env node\nlet raw="";for await(const chunk of process.stdin)raw+=chunk;const wrapped=raw.match(/<task>\\s*([\\s\\S]*?)\\s*<\\/task>/)?.[1]??raw,prompt=wrapped.split("\\n\\nTurn budget:")[0];\nif (prompt === "sleep") { process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000); } else { console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"done:"+prompt,session_id:"session-123",usage:{input_tokens:10,output_tokens:2},modelUsage:{"claude-sonnet-test":{inputTokens:10,outputTokens:2}},total_cost_usd:0.12,num_turns:3,duration_ms:100,duration_api_ms:80})); }\n`);
  await chmod(fake, 0o755);
  return { cwd, nested, env: { ...process.env, CLAUDE_CODE_EXECUTABLE: fake, CLAUDE_COMPANION_STATE_ROOT: state } };
}

test("detached MCP jobs expose status, safe metadata, and explicit results", async () => {
  const fx = await fixture();
  const launched = await callMcp(fx.env, "claude_task_readonly", { workspace_root: fx.nested, task: "hello", model: "fable", background: true });
  const completedJob = await poll(() => callMcp(fx.env, "claude_job_status", { workspace_root: fx.cwd, job_id: launched.id }), value => value.status === "completed");
  assert.equal(completedJob.profile, "task"); assert.equal(completedJob.task_profile, "standard"); assert.equal(completedJob.requested_model, "fable");
  assert.deepEqual(completedJob.effective_models, ["claude-sonnet-test"]); assert.equal(completedJob.total_cost_usd, 0.12); assert.equal(completedJob.usage.output_tokens, 2);
  const [workspaceState] = await readdir(fx.env.CLAUDE_COMPANION_STATE_ROOT), stateRecord = JSON.parse(await readFile(join(fx.env.CLAUDE_COMPANION_STATE_ROOT, workspaceState, `${launched.id}.json`), "utf8"));
  assert.equal("prompt" in stateRecord, false);
  for (const path of [stateRecord.stdoutPath, stateRecord.stderrPath, stateRecord.eventsPath]) assert.equal((await stat(path)).mode & 0o777, 0o600);
  const result = await callMcp(fx.env, "claude_job_result", { workspace_root: fx.cwd, job_id: launched.id });
  assert.equal(result.result, "done:hello"); assert.equal(result.session_id, "session-123");
});

test("a running detached MCP job can be cancelled by explicit id", async () => {
  const fx = await fixture(), launched = await callMcp(fx.env, "claude_task_readonly", { workspace_root: fx.cwd, task: "sleep", background: true });
  const cancelled = await callMcp(fx.env, "claude_job_cancel", { workspace_root: fx.cwd, job_id: launched.id });
  assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.phase, "cancelled");
  const status = await callMcp(fx.env, "claude_job_status", { workspace_root: fx.cwd, job_id: launched.id }); assert.equal(status.status, "cancelled");
  const result = await callMcpRaw(fx.env, "claude_job_result", { workspace_root: fx.cwd, job_id: launched.id });
  assert.equal(result.error.code, -32603); assert.match(result.error.message, /cancelled/);
});

test("explicit MCP resume links background jobs and cumulative chain cost", async () => {
  const fx = await fixture(), first = await callMcp(fx.env, "claude_task_readonly", { workspace_root: fx.cwd, task: "first", background: true });
  await poll(() => callMcp(fx.env, "claude_job_status", { workspace_root: fx.cwd, job_id: first.id }), value => value.status === "completed");
  const second = await callMcp(fx.env, "claude_task_readonly", { workspace_root: fx.cwd, task: "second", resume_session_id: "session-123", background: true });
  const job = await poll(() => callMcp(fx.env, "claude_job_status", { workspace_root: fx.cwd, job_id: second.id }), value => value.status === "completed");
  assert.equal(job.parent_job_id, first.id); assert.equal(job.cumulative_chain_cost_usd, 0.24);
  const result = await callMcp(fx.env, "claude_job_result", { workspace_root: fx.cwd, job_id: second.id });
  assert.equal(result.parent_job_id, first.id); assert.equal(result.cumulative_chain_cost_usd, 0.24);
});
