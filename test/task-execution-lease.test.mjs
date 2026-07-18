import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { callMcp, callMcpRaw } from "./helpers/mcp-client.js";
import { linkTaskResumeChild } from "../scripts/lib/task-execution-lease.mjs";

test("resume child linkage is idempotent only for the same claim and child", () => {
  const linked = { status: "resuming", resumeClaimId: "claim", resumedByJobId: "child", resumedAt: "2026-01-01T00:00:00.000Z" };
  assert.equal(linkTaskResumeChild(linked, { claimId: "claim", childId: "child" }), linked);
  assert.throws(() => linkTaskResumeChild(linked, { claimId: "claim", childId: "other" }), error => error.errorKind === "task_checkpoint_race");
  assert.throws(() => linkTaskResumeChild(linked, { claimId: "other", childId: "child" }), error => error.errorKind === "task_checkpoint_race");
});

async function fixture({ verifiedWrite = false, behavior = "normal" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "task-execution-lease-"));
  const workspace = join(root, "workspace");
  const stateRoot = join(root, "state");
  const config = join(root, "config.json");
  const fake = join(root, "claude");
  const invocations = join(root, "invocations.log");
  await mkdir(workspace);
  await command("git", ["init", "--quiet"], workspace);
  await command("git", ["config", "user.email", "test@example.invalid"], workspace);
  await command("git", ["config", "user.name", "Test"], workspace);
  await writeFile(join(workspace, "app.mjs"), "export const value = 1;\n");
  await command("git", ["add", "app.mjs"], workspace);
  await command("git", ["commit", "--quiet", "-m", "base"], workspace);
  await writeFile(config, `${JSON.stringify({ task: { executionLeaseEnabled: true } })}\n`);
  await writeFile(fake, `#!/usr/bin/env node
import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
if (process.argv[2] === "--version") { console.log("2.1.208 (Claude Code)"); process.exit(0); }
const args = process.argv.slice(2), configIndex = args.indexOf("--mcp-config"), behavior = process.env.TEST_TASK_BEHAVIOR ?? "normal";
let parentStatusAtInvocation = null;
if (args.includes("--resume")) {
  for (const name of await readdir(process.env.CLAUDE_COMPANION_STATE_ROOT, { recursive: true }).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    let record = null;
    try { record = JSON.parse(await readFile(process.env.CLAUDE_COMPANION_STATE_ROOT + "/" + name, "utf8")); } catch {}
    if (record?.status === "resuming" && record?.sessionId === "readonly-checkpoint-session") parentStatusAtInvocation = record.status;
  }
}
await appendFile(process.env.TEST_CLAUDE_INVOCATIONS, JSON.stringify({ args, cwd: process.cwd(), parentStatusAtInvocation }) + "\\n");
if (configIndex < 0) throw new Error("missing task execution MCP config");
const config = JSON.parse(await readFile(args[configIndex + 1], "utf8"));
const spec = config.mcpServers.task_execution;
const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, shell: false, stdio: ["pipe", "pipe", "inherit"] });
let stdout = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => { stdout += chunk; });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } } }) + "\\n");
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\\n");
const resumed = args.includes("--resume");
const write = args.includes("acceptEdits");
if (write) await writeFile("agent-output.txt", resumed ? "complete\\n" : "partial\\n");
if (!["no-receipt", "breaker-no-receipt"].includes(behavior)) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: resumed ? { name: "task_complete", arguments: { summary: write ? "Implementation completed" : "Auth denial verified", verification: ["Focused test passed"], remaining_gaps: [] } } : { name: "task_checkpoint", arguments: { summary: write ? "Implementation partially complete" : "Inspected the auth flow", completed_steps: [write ? "Created the initial file" : "Located the caller"], remaining_steps: [write ? "Finish and verify the file" : "Verify the denial path"], verification: ["Focused test still pending"], uncertainty: "medium" } } }) + "\\n");
  const deadline = Date.now() + 3000;
  while (!stdout.split(/\\r?\\n/).some(line => line.includes('"id":2')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
}
if (behavior === "slow") await new Promise(resolve => setTimeout(resolve, 15_000));
child.stdin.end(); await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
if (behavior === "corrupt-state") await writeFile(spec.env.TASK_EXECUTION_STATE_PATH, "{broken", "utf8");
const session = behavior === "no-session" ? {} : { session_id: "readonly-checkpoint-session" };
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", ...session, mcp_servers: [{ name: "task_execution", status: "connected" }], tools: ["Read", "Grep", "Glob", "mcp__task_execution__task_checkpoint", "mcp__task_execution__task_complete"] }) + "\\n");
const succeeds = resumed || behavior === "success-checkpoint" || behavior === "no-receipt";
const breaker = behavior === "cost-breaker" ? { subtype: "error_max_budget_usd", result: "budget limit" } : { subtype: "error_max_turns", result: "turn limit" };
process.stdout.write(JSON.stringify(succeeds ? { type: "result", subtype: "success", is_error: false, result: "finished", ...session, total_cost_usd: 0.3, num_turns: 2, usage: { input_tokens: 12, output_tokens: 6 } } : { type: "result", ...breaker, is_error: true, ...session, total_cost_usd: 0.4, num_turns: 4, usage: { input_tokens: 20, output_tokens: 8 } }) + "\\n");
process.exit(succeeds ? 0 : 1);
`);
  await chmod(fake, 0o755);
  let serverPath = resolve("mcp/server.mjs");
  if (verifiedWrite) {
    const sourceRoot = resolve("."), pluginRoot = join(root, "plugin-copy");
    await cp(sourceRoot, pluginRoot, { recursive: true, filter: source => { const name = relative(sourceRoot, source); return name !== ".git" && !name.startsWith(`.git/`) && name !== ".taskloop" && !name.startsWith(`.taskloop/`) && name !== "node_modules" && !name.startsWith(`node_modules/`); } });
    const manifestPath = join(pluginRoot, "config", "sandbox-compatibility.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const executableSha256 = createHash("sha256").update(await readFile(fake)).digest("hex");
    manifest.entries = manifest.entries.map(entry => ({ ...entry, executableSha256 }));
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    serverPath = join(pluginRoot, "mcp", "server.mjs");
  }
  return {
    workspace,
    stateRoot,
    invocations,
    serverPath,
    env: {
      ...process.env,
      CLAUDE_CODE_EXECUTABLE: fake,
      CLAUDE_COMPANION_CONFIG_FILE: config,
      CLAUDE_COMPANION_STATE_ROOT: stateRoot,
      CLAUDE_COMPANION_BACKGROUND_TIMEOUT_MS: "10000",
      CLAUDE_COMPANION_WRITE_ROOT: join(root, "write-workspaces"),
      TEST_CLAUDE_INVOCATIONS: invocations,
      TEST_TASK_BEHAVIOR: behavior,
    },
  };
}

test("readonly task checkpoints instead of failing at the turn breaker", async () => {
  const fx = await fixture();
  const started = await callMcp(fx.env, "claude_task_readonly", {
    workspace_root: fx.workspace,
    task: "Inspect the auth flow and verify the denial path",
    background: true,
    max_turns: 4,
    finalize_at_turn: 3,
  });
  const job = await terminalStatus(fx, started.id);

  assert.equal(job.status, "checkpointed");
  assert.equal(job.phase, "checkpointed");
  assert.equal(job.resume_eligible, true);
  assert.equal(job.checkpoint_reason, "turn_limit");
  assert.equal(job.session_id, "readonly-checkpoint-session");
  assert.equal(job.turn_limit_reached, true);
  assert.equal(job.cost_budget_exhausted, false);
  assert.deepEqual(job.task_checkpoint, {
    summary: "Inspected the auth flow",
    completed_steps: ["Located the caller"],
    remaining_steps: ["Verify the denial path"],
    verification: ["Focused test still pending"],
    uncertainty: "medium",
  });
  assert.equal((await readFile(fx.invocations, "utf8")).trim().split("\n").length, 1);

  const result = await callMcp(fx.env, "claude_job_result", { workspace_root: fx.workspace, job_id: started.id });
  assert.equal(result.status, "checkpointed");
  assert.deepEqual(result.task_checkpoint, job.task_checkpoint);
});

test("foreground readonly task waits for a durable checkpointed outcome", async () => {
  const fx = await fixture();
  const outcome = await callMcp(fx.env, "claude_task_readonly", {
    workspace_root: fx.workspace,
    task: "Inspect the auth flow in the foreground",
    max_turns: 4,
    finalize_at_turn: 3,
  });

  assert.equal(outcome.status, "checkpointed");
  assert.equal(outcome.resume_eligible, true);
  assert.equal(outcome.checkpoint_reason, "turn_limit");
});

test("readonly task checkpoints at the cost breaker without an automatic retry", async () => {
  const fx = await fixture({ behavior: "cost-breaker" });
  const started = await callMcp(fx.env, "claude_task_readonly", {
    workspace_root: fx.workspace,
    task: "Inspect the auth flow within the configured cost",
    background: true,
    max_turns: 4,
    finalize_at_turn: 3,
    max_budget_usd: 0.5,
  });
  const job = await terminalStatus(fx, started.id);

  assert.equal(job.status, "checkpointed");
  assert.equal(job.checkpoint_reason, "cost_budget");
  assert.equal(job.cost_budget_exhausted, true);
  assert.equal(job.turn_limit_reached, false);
  assert.equal((await readFile(fx.invocations, "utf8")).trim().split("\n").length, 1);
});

test("successful upstream exit with only a checkpoint remains resumable and incomplete", async () => {
  const fx = await fixture({ behavior: "success-checkpoint" });
  const started = await callMcp(fx.env, "claude_task_readonly", {
    workspace_root: fx.workspace,
    task: "Do not claim completion without the completion receipt",
    background: true,
    max_turns: 4,
    finalize_at_turn: 3,
  });
  const job = await terminalStatus(fx, started.id);

  assert.equal(job.status, "checkpointed");
  assert.equal(job.checkpoint_reason, "completion_missing");
  assert.equal(job.resume_eligible, true);
  assert.equal(job.task_completion, null);
});

test("successful upstream exit without any receipt fails closed", async () => {
  const fx = await fixture({ behavior: "no-receipt" });
  const started = await callMcp(fx.env, "claude_task_readonly", {
    workspace_root: fx.workspace,
    task: "Require a task completion receipt",
    background: true,
    max_turns: 4,
    finalize_at_turn: 3,
  });
  const job = await terminalStatus(fx, started.id);

  assert.equal(job.status, "failed");
  assert.equal(job.error_kind, "task_completion_missing");
  assert.equal(job.resume_eligible, false);
});

test("breaker without a checkpoint or session cannot become resumable", async () => {
  for (const behavior of ["breaker-no-receipt", "no-session"]) {
    const fx = await fixture({ behavior });
    const started = await callMcp(fx.env, "claude_task_readonly", {
      workspace_root: fx.workspace,
      task: "Fail closed when durable resume identity is missing",
      background: true,
      max_turns: 4,
      finalize_at_turn: 3,
    });
    const job = await terminalStatus(fx, started.id);
    assert.equal(job.status, "failed");
    assert.equal(job.resume_eligible, false);
  }
});

test("corrupt task controller state fails closed as MCP startup corruption", async () => {
  const fx = await fixture({ behavior: "corrupt-state" });
  const started = await callMcp(fx.env, "claude_task_readonly", {
    workspace_root: fx.workspace,
    task: "Preserve fail-closed controller ownership",
    background: true,
    max_turns: 4,
    finalize_at_turn: 3,
  });
  const job = await terminalStatus(fx, started.id);

  assert.equal(job.status, "failed");
  assert.equal(job.error_kind, "mcp_startup");
  assert.equal(job.resume_eligible, false);
});

test("a stale unlinked resume claim safely returns to checkpointed before retry", async () => {
  const fx = await fixture();
  const started = await callMcp(fx.env, "claude_task_readonly", {
    workspace_root: fx.workspace,
    task: "Recover an interrupted explicit resume transaction",
    background: true,
    max_turns: 4,
    finalize_at_turn: 3,
  });
  await terminalStatus(fx, started.id);
  const path = await rawJobPath(fx, started.id);
  const parent = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...parent, status: "resuming", phase: "resuming", resumeEligible: false, resumeClaimId: "abandoned-claim", resumeClaimedAt: new Date(0).toISOString() }));

  const resumed = await callMcp(fx.env, "claude_task_resume", { workspace_root: fx.workspace, job_id: started.id, background: true });
  const completed = await terminalStatus(fx, resumed.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.parent_job_id, started.id);
});

test("cancelling a leased task terminates its controller and removes control state", async () => {
  const fx = await fixture({ behavior: "slow" });
  const started = await callMcp(fx.env, "claude_task_readonly", {
    workspace_root: fx.workspace,
    task: "Wait until explicitly cancelled",
    background: true,
    max_turns: 4,
    finalize_at_turn: 3,
  });
  const persisted = await rawJob(fx, started.id);
  await stat(persisted.taskControlRoot);
  const cancelled = await callMcp(fx.env, "claude_job_cancel", { workspace_root: fx.workspace, job_id: started.id });

  assert.equal(cancelled.status, "cancelled");
  await assert.rejects(() => stat(persisted.taskControlRoot), error => error.code === "ENOENT");
});

test("timing out a leased task removes controller state and does not make it resumable", async () => {
  const fx = await fixture({ behavior: "slow" });
  const started = await callMcp(fx.env, "claude_task_readonly", {
    workspace_root: fx.workspace,
    task: "Respect the wall-clock breaker",
    background: true,
    max_turns: 4,
    finalize_at_turn: 3,
    timeout_ms: 250,
  });
  const persisted = await rawJob(fx, started.id);
  await stat(persisted.taskControlRoot);
  const timedOut = await terminalStatus(fx, started.id);

  assert.equal(timedOut.status, "timed_out");
  assert.equal(timedOut.resume_eligible, false);
  await assert.rejects(() => stat(persisted.taskControlRoot), error => error.code === "ENOENT");
});

test("readonly task resumes one checkpoint explicitly and completes the linked cost chain", async () => {
  const fx = await fixture();
  const started = await callMcp(fx.env, "claude_task_readonly", { workspace_root: fx.workspace, task: "Inspect and verify auth", background: true, max_turns: 4, finalize_at_turn: 3 });
  const checkpointed = await terminalStatus(fx, started.id);
  assert.equal(checkpointed.status, "checkpointed");
  assert.equal((await readFile(fx.invocations, "utf8")).trim().split("\n").length, 1);

  const resumed = await callMcp(fx.env, "claude_task_resume", { workspace_root: fx.workspace, job_id: started.id, background: true });
  const duplicate = await callMcpRaw(fx.env, "claude_task_resume", { workspace_root: fx.workspace, job_id: started.id, background: true });
  assert.equal(duplicate.error.data.error_kind, "task_checkpoint_not_resumable");
  const completed = await terminalStatus(fx, resumed.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.phase, "done");
  assert.equal(completed.parent_job_id, started.id);
  assert.equal(completed.cumulative_chain_cost_usd, 0.7);
  assert.deepEqual(completed.task_completion, { summary: "Auth denial verified", verification: ["Focused test passed"], remaining_gaps: [] });

  const invocations = (await readFile(fx.invocations, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(invocations.length, 2);
  assert.equal(invocations[1].parentStatusAtInvocation, "resuming");
  assert.deepEqual(invocations[1].args.slice(invocations[1].args.indexOf("--resume"), invocations[1].args.indexOf("--resume") + 2), ["--resume", "readonly-checkpoint-session"]);
  const parent = await callMcp(fx.env, "claude_job_status", { workspace_root: fx.workspace, job_id: started.id });
  assert.equal(parent.resume_eligible, false);
  assert.equal(parent.resumed_by_job_id, resumed.id);

  const parentPath = await rawJobPath(fx, started.id);
  const persistedParent = JSON.parse(await readFile(parentPath, "utf8"));
  await writeFile(parentPath, JSON.stringify({ ...persistedParent, resumedByJobId: null, resumeClaimId: "interrupted-link", resumeClaimedAt: new Date(0).toISOString() }));
  const relinked = await callMcp(fx.env, "claude_job_status", { workspace_root: fx.workspace, job_id: started.id });
  assert.equal(relinked.resumed_by_job_id, resumed.id);
  assert.equal(relinked.resume_eligible, false);
});

test("isolated write checkpoint cannot apply and resumes in the same sandbox", { skip: process.platform !== "darwin" }, async () => {
  const fx = await fixture({ verifiedWrite: true });
  const started = await callMcp(fx.env, "claude_write_task_start", { workspace_root: fx.workspace, task: "Create and verify agent-output.txt", max_turns: 4, finalize_at_turn: 3 }, fx.serverPath);
  const checkpointed = await terminalStatus(fx, started.id);
  assert.equal(checkpointed.status, "checkpointed");
  assert.equal(checkpointed.artifact_status, "checkpointed");
  await assert.rejects(() => stat(join(fx.workspace, "agent-output.txt")), error => error.code === "ENOENT");

  const applyBlocked = await callMcpRaw(fx.env, "claude_write_task_apply", { workspace_root: fx.workspace, job_id: started.id }, fx.serverPath);
  assert.equal(applyBlocked.error.data.error_kind, "artifact_unavailable");

  const resumed = await callMcp(fx.env, "claude_task_resume", { workspace_root: fx.workspace, job_id: started.id, background: true }, fx.serverPath);
  const completed = await terminalStatus(fx, resumed.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.artifact_status, "awaiting_apply");
  assert.equal(completed.parent_job_id, started.id);

  const invocations = (await readFile(fx.invocations, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(invocations.length, 2);
  assert.notEqual(invocations[0].cwd, resolve(fx.workspace));
  assert.equal(invocations[1].cwd, invocations[0].cwd);
  assert.equal(invocations[1].parentStatusAtInvocation, "resuming");
  const applied = await callMcp(fx.env, "claude_write_task_apply", { workspace_root: fx.workspace, job_id: resumed.id }, fx.serverPath);
  assert.equal(applied.artifact_status, "applied");
  assert.equal(await readFile(join(fx.workspace, "agent-output.txt"), "utf8"), "complete\n");
});

test("isolated write resume fails closed after source drift and can be discarded", { skip: process.platform !== "darwin" }, async () => {
  const fx = await fixture({ verifiedWrite: true });
  const started = await callMcp(fx.env, "claude_write_task_start", { workspace_root: fx.workspace, task: "Create agent-output.txt", max_turns: 4, finalize_at_turn: 3 }, fx.serverPath);
  const checkpointed = await terminalStatus(fx, started.id);
  assert.equal(checkpointed.status, "checkpointed");
  await writeFile(join(fx.workspace, "app.mjs"), "export const value = 2;\n");

  const blocked = await callMcpRaw(fx.env, "claude_task_resume", { workspace_root: fx.workspace, job_id: started.id, background: true }, fx.serverPath);
  assert.equal(blocked.error.data.error_kind, "write_resume_invalid");
  assert.equal((await readFile(fx.invocations, "utf8")).trim().split("\n").length, 1);
  const discarded = await callMcp(fx.env, "claude_write_task_discard", { workspace_root: fx.workspace, job_id: started.id }, fx.serverPath);
  assert.equal(discarded.artifact_status, "discarded");
  await assert.rejects(() => stat(join(fx.workspace, "agent-output.txt")), error => error.code === "ENOENT");
});

test("a stale unlinked write resume claim can be explicitly discarded", { skip: process.platform !== "darwin" }, async () => {
  const fx = await fixture({ verifiedWrite: true });
  const started = await callMcp(fx.env, "claude_write_task_start", { workspace_root: fx.workspace, task: "Create agent-output.txt", max_turns: 4, finalize_at_turn: 3 }, fx.serverPath);
  await terminalStatus(fx, started.id);
  const path = await rawJobPath(fx, started.id);
  const parent = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...parent, status: "resuming", phase: "resuming", resumeEligible: false, resumeClaimId: "abandoned-write-claim", resumeClaimedAt: new Date(0).toISOString() }));

  const discarded = await callMcp(fx.env, "claude_write_task_discard", { workspace_root: fx.workspace, job_id: started.id }, fx.serverPath);
  assert.equal(discarded.artifact_status, "discarded");
});

async function terminalStatus(fx, id) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const job = await callMcp(fx.env, "claude_job_status", { workspace_root: fx.workspace, job_id: id }, fx.serverPath);
    if (!["starting", "running", "queued"].includes(job.status)) return job;
    await new Promise(resolveWait => setTimeout(resolveWait, 40));
  }
  throw new Error(`Timed out waiting for ${id}`);
}

async function rawJob(fx, id) {
  return JSON.parse(await readFile(await rawJobPath(fx, id), "utf8"));
}

async function rawJobPath(fx, id) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    for (const name of await readdir(fx.stateRoot, { recursive: true }).catch(() => [])) {
      if (name.endsWith("/" + id + ".json") || name === id + ".json") return join(fx.stateRoot, name);
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  throw new Error("Persisted job " + id + " was not found");
}

function command(executable, args, cwd) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolveCommand() : reject(new Error(`${executable} exited ${code}`)));
  });
}
