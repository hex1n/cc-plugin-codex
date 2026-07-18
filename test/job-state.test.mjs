import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { callMcp, callMcpRaw } from "./helpers/mcp-client.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "claude-job-state-test-")), cwd = join(root, "workspace"), state = join(root, "state"), fake = join(root, "claude");
  await mkdir(cwd);
  await writeFile(fake, `#!/usr/bin/env node
let raw="";for await(const chunk of process.stdin)raw+=chunk;const wrapped=raw.match(/<task>\\s*([\\s\\S]*?)\\s*<\\/task>/)?.[1]??raw,prompt=wrapped.split("\\n\\nTurn budget:")[0];
if(prompt==="fail"){console.error("deliberate failure");process.exit(7)}
if(prompt==="max-turns"){console.log(JSON.stringify({type:"result",subtype:"error_max_turns",is_error:true,result:"turn limit",session_id:"resume-me"}));process.exit(1)}
if(prompt==="max-budget"){console.log(JSON.stringify({type:"result",subtype:"error_max_budget_usd",is_error:true,result:"budget",session_id:"budget-session",total_cost_usd:0.25,num_turns:2,duration_ms:900,usage:{input_tokens:10,output_tokens:5}}));process.exit(1)}
if(prompt==="max-budget-zero"){console.log(JSON.stringify({type:"result",subtype:"error_max_budget_usd",is_error:true,result:"budget",session_id:"budget-zero-session",total_cost_usd:0.2,num_turns:2,usage:{input_tokens:8,output_tokens:3}}));process.exit(0)}
if(prompt==="malformed"){console.log("not-json");process.exit(0)}
console.log(JSON.stringify({type:"result",is_error:false,result:"ok",structured_output:{verdict:"approve",summary:"No findings",findings:[],next_steps:[],coverage:{files_examined:["a"],files_skipped:[],areas:["diff"]},uncertainty:"low",budget_exhausted:false,recommended_followup:{profile:"none",focus:[],reason:""}},session_id:"persisted-session",total_cost_usd:0.1}));
`);
  await chmod(fake, 0o755);
  return { cwd, env: { ...process.env, CLAUDE_CODE_EXECUTABLE: fake, CLAUDE_COMPANION_STATE_ROOT: state, CLAUDE_COMPANION_BACKGROUND_TIMEOUT_MS: "10000" } };
}

async function launch(fx, prompt, options = {}) {
  return (await callMcp(fx.env, "claude_task_readonly", { workspace_root: fx.cwd, task: prompt, background: true, ...options })).id;
}

async function terminalStatus(fx, id) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const job = await callMcp(fx.env, "claude_job_status", { workspace_root: fx.cwd, job_id: id });
    if (!["starting", "running", "queued"].includes(job.status)) return job;
    await new Promise(resolveWait => setTimeout(resolveWait, 40));
  }
  throw new Error(`Timed out waiting for job ${id}`);
}

test("a successful detached job persists its Claude session", async () => {
  const fx = await fixture(), id = await launch(fx, "success"), job = await terminalStatus(fx, id);
  assert.equal(job.status, "completed");
  assert.equal(job.exit_code, 0);
  assert.equal(job.session_id, "persisted-session");
  const result = await callMcp(fx.env, "claude_job_result", { workspace_root: fx.cwd, job_id: id });
  assert.equal(result.session_id, "persisted-session");
});

test("a nonzero detached Claude exit is failed, not completed", async () => {
  const fx = await fixture(), id = await launch(fx, "fail"), job = await terminalStatus(fx, id);
  assert.equal(job.status, "failed");
  assert.equal(job.exit_code, 7);
  assert.match(job.error, /deliberate failure/);
  const result = await callMcpRaw(fx.env, "claude_job_result", { workspace_root: fx.cwd, job_id: id });
  assert.equal(result.error.code, -32603); assert.match(result.error.message, /deliberate failure/);
});

test("a max-turns result preserves the actionable Claude error", async () => {
  const fx = await fixture(), id = await launch(fx, "max-turns"), job = await terminalStatus(fx, id);
  assert.equal(job.status, "failed");
  assert.equal(job.error_kind, "max_turns");
  assert.equal(job.upstream_error_subtype, "error_max_turns");
  assert.equal(job.suggested_action, "resume_or_increase_turns");
  assert.equal(job.session_id, "resume-me");
  assert.equal(job.turn_limit_reached, true);
  assert.equal(job.cost_budget_exhausted, false);
});

test("a detached budget error preserves usage and cost", async () => {
  const fx = await fixture(), id = await launch(fx, "max-budget"), job = await terminalStatus(fx, id);
  assert.equal(job.status, "failed");
  assert.equal(job.error_kind, "max_budget");
  assert.equal(job.upstream_error_subtype, "error_max_budget_usd");
  assert.equal(job.session_id, "budget-session");
  assert.equal(job.total_cost_usd, 0.25);
  assert.equal(job.num_turns, 2);
  assert.equal(job.usage.output_tokens, 5);
  assert.equal(job.cost_budget_exhausted, true);
  assert.equal(job.turn_limit_reached, false);
  const result = await callMcpRaw(fx.env, "claude_job_result", { workspace_root: fx.cwd, job_id: id }), error = result.error.data;
  assert.equal(result.error.code, -32603); assert.equal(error.error_kind, "max_budget"); assert.equal(error.session_id, "budget-session"); assert.equal(error.requested_model, "sonnet"); assert.equal(error.total_cost_usd, 0.25); assert.equal(error.usage.output_tokens, 5);
});

test("a failed resumed job exposes its parent and cumulative chain cost in result", async () => {
  const fx = await fixture(), parentId = await launch(fx, "success");
  await terminalStatus(fx, parentId);
  const id = await launch(fx, "max-budget", { resume_session_id: "persisted-session" }), job = await terminalStatus(fx, id);
  assert.equal(job.parent_job_id, parentId);
  assert.equal(job.cumulative_chain_cost_usd, 0.35);
  const result = await callMcpRaw(fx.env, "claude_job_result", { workspace_root: fx.cwd, job_id: id }), error = result.error.data;
  assert.equal(result.error.code, -32603);
  assert.equal(error.parent_job_id, parentId);
  assert.equal(error.cumulative_chain_cost_usd, 0.35);
});

test("a structured Claude error preserves its subtype and usage even with exit zero", async () => {
  const fx = await fixture(), id = await launch(fx, "max-budget-zero"), job = await terminalStatus(fx, id);
  assert.equal(job.status, "failed");
  assert.equal(job.error_kind, "max_budget");
  assert.equal(job.session_id, "budget-zero-session");
  assert.equal(job.total_cost_usd, 0.2);
  assert.equal(job.usage.output_tokens, 3);
});

test("a zero exit without a valid Claude payload is failed", async () => {
  const fx = await fixture(), id = await launch(fx, "malformed"), job = await terminalStatus(fx, id);
  assert.equal(job.status, "failed");
  assert.equal(job.exit_code, 0);
  assert.match(job.error, /valid JSON payload/);
});

test("a stale active snapshot cannot overwrite a terminal job", async () => {
  const fx = await fixture();
  const script = `import {createJob,transitionJob} from ${JSON.stringify(new URL("../scripts/lib/state.mjs", import.meta.url).href)};
const job=await createJob({cwd:process.cwd(),profile:"task"});
const cancelled=await transitionJob(job.cwd,job.id,["starting"],current=>({...current,status:"cancelled"}));
const stale=await transitionJob(job.cwd,job.id,["starting"],current=>({...current,status:"completed"}));
console.log(JSON.stringify({cancelled:cancelled.record.status,changed:stale.changed,final:stale.record.status}));`;
  const result = await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: fx.cwd, env: fx.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; }); child.once("error", reject); child.once("close", code => resolveRun({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { cancelled: "cancelled", changed: false, final: "cancelled" });
});
