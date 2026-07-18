import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { callMcp } from "./helpers/mcp-client.js";

import { buildClaudeInvocation } from "../scripts/lib/claude.mjs";
import {
  cleanupReviewEvidenceRuntime,
  prepareReviewEvidenceRuntime,
} from "../scripts/lib/review-evidence-runtime.mjs";
import {
  REVIEW_EVIDENCE_QUALIFIED_TOOLS,
  REVIEW_EVIDENCE_SERVER_KEY,
} from "../scripts/lib/review-evidence-contract.mjs";

test("review Evidence Lease argv has one exact fail-closed capability contract", () => {
  const invocation = buildClaudeInvocation("review", "review through stdin", {
    model: "claude-fable-5",
    effort: "high",
    maxTurns: 12,
    maxBudgetUsd: 3,
    schemaPath: "schemas/review-output.schema.json",
    reviewEvidence: { mcpConfigPath: "/control/mcp.json" },
  });
  assert.equal(invocation.stdin, "review through stdin");
  assert.deepEqual(invocation.args.slice(0, 3), ["--print", "--output-format", "stream-json"]);
  assert.equal(invocation.args.filter(value => value === "--mcp-config").length, 1);
  assert.equal(invocation.args[invocation.args.indexOf("--mcp-config") + 1], "/control/mcp.json");
  assert.equal(invocation.args[invocation.args.indexOf("--allowedTools") + 1], REVIEW_EVIDENCE_QUALIFIED_TOOLS.join(","));
  assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], "claude-fable-5");
  assert.equal(invocation.args[invocation.args.indexOf("--effort") + 1], "high");
  assert.equal(invocation.args[invocation.args.indexOf("--setting-sources") + 1], "");
  assert.equal(invocation.args[invocation.args.indexOf("--tools") + 1], "");
  for (const forbidden of ["--safe-mode", "plan", "Read", "Grep", "Glob", "Bash"]) {
    assert(!invocation.args.some(value => value === forbidden || value.includes(`${forbidden}(`)), forbidden);
  }
  assert(!invocation.args.includes("--"));
});

test("a review runtime isolates Claude cwd while only MCP receives the real workspace root", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "review-runtime-"));
  const workspace = join(fixture, "workspace");
  const stateRoot = join(fixture, "state");
  await mkdir(workspace);
  const runtime = await prepareReviewEvidenceRuntime({
    workspaceRoot: workspace,
    stateRoot,
    base: "main",
    evidenceUnits: 5,
  });
  try {
    assert.deepEqual(await readdir(runtime.executionCwd), []);
    assert.notEqual(await realpath(runtime.executionCwd), await realpath(workspace));
    assert.equal((await stat(runtime.controlRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(runtime.mcpConfigPath)).mode & 0o777, 0o600);
    const config = JSON.parse(await readFile(runtime.mcpConfigPath, "utf8"));
    assert.deepEqual(Object.keys(config.mcpServers), [REVIEW_EVIDENCE_SERVER_KEY]);
    const server = config.mcpServers[REVIEW_EVIDENCE_SERVER_KEY];
    assert.equal(server.command, process.execPath);
    assert.equal(server.env.REVIEW_ROOT, await realpath(workspace));
    assert.equal(server.env.REVIEW_BASE, "main");
    assert.equal(server.env.REVIEW_LEASE_UNITS, "5");
    assert.equal(server.env.REVIEW_LEASE_STATE_PATH, runtime.leaseStatePath);
    assert(!Object.values(process.env).includes(runtime.executionCwd));
  } finally {
    await cleanupReviewEvidenceRuntime(runtime);
  }
  await assert.rejects(() => stat(runtime.controlRoot), error => error.code === "ENOENT");
});

test("feature-enabled outer MCP performs one CLI-owned evidence review and cleans the control cwd", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "review-evidence-e2e-"));
  const workspace = join(fixture, "workspace");
  const stateRoot = join(fixture, "state");
  const capture = join(fixture, "capture.json");
  const fake = join(fixture, "claude.mjs");
  await mkdir(workspace);
  await command("git", ["init", "--quiet"], workspace);
  await command("git", ["config", "user.email", "test@example.invalid"], workspace);
  await command("git", ["config", "user.name", "Test"], workspace);
  await writeFile(join(workspace, "auth.mjs"), "export const allowed = role === 'admin';\n");
  await command("git", ["add", "auth.mjs"], workspace);
  await command("git", ["commit", "--quiet", "-m", "base"], workspace);
  await writeFile(join(workspace, "auth.mjs"), "export const allowed = role = 'admin';\n");
  await writeFile(fake, `#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
let prompt = ""; for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2), configPath = args[args.indexOf("--mcp-config") + 1];
if (!configPath) process.exit(41);
const config = JSON.parse(await readFile(configPath, "utf8"));
const definition = config.mcpServers.review_evidence;
const messages = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "1" } } },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "review_diff", arguments: {} } },
];
const child = spawn(definition.command, definition.args, { cwd: process.cwd(), env: { ...process.env, ...definition.env }, shell: false, stdio: ["pipe", "pipe", "pipe"] });
let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
child.stdin.end(messages.map(JSON.stringify).join("\\n") + "\\n");
const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
if (code !== 0) throw new Error(stderr || "evidence MCP failed");
const responses = stdout.trim().split(/\\r?\\n/).map(JSON.parse), names = responses.find(value => value.id === 2).result.tools.map(tool => tool.name);
const lease = JSON.parse(await readFile(definition.env.REVIEW_LEASE_STATE_PATH, "utf8"));
await writeFile(process.env.CAPTURE_INVOCATION, JSON.stringify({ args, prompt, cwd: process.cwd(), fakePid: process.pid, lease }));
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "evidence-session", mcp_servers: [{ name: "review_evidence", status: "connected" }], tools: [...names.map(name => "mcp__review_evidence__" + name), "StructuredOutput"] }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "evidence-ok", session_id: "evidence-session", structured_output: { verdict: "approve", summary: "bounded", findings: [], next_steps: [], coverage: { files_examined: ["auth.mjs"], files_skipped: [], areas: ["authorization"] }, uncertainty: "low", budget_exhausted: false, recommended_followup: { profile: "none", focus: [], reason: "" } }, usage: { input_tokens: 2, output_tokens: 1 }, modelUsage: { "claude-fable-5": { inputTokens: 2, outputTokens: 1 } }, total_cost_usd: 0.01, num_turns: 2 }) + "\\n");
`);
  await chmod(fake, 0o755);
  const result = await callMcp({
    ...process.env,
    CLAUDE_CODE_EXECUTABLE: fake,
    CAPTURE_INVOCATION: capture,
    CLAUDE_COMPANION_STATE_ROOT: stateRoot,
    CLAUDE_COMPANION_CONFIG_ROOT: join(fixture, "config"),
    CLAUDE_COMPANION_REVIEW_EVIDENCE_LEASE: "on",
  }, "claude_review_changes", {
    workspace_root: workspace,
    review_profile: "standard",
    model: "claude-fable-5",
    effort: "high",
  });
  assert.equal(result.result, "evidence-ok");
  assert.equal(result.requested_model, "claude-fable-5");
  assert.deepEqual(result.effective_models, ["claude-fable-5"]);
  assert.equal(result.effort, "high");
  assert.equal(result.evidence_lease.used_units, 1);
  const invocation = JSON.parse(await readFile(capture, "utf8"));
  assert.equal(invocation.lease.serverPpid, invocation.fakePid);
  assert.notEqual(invocation.cwd, await realpath(workspace));
  assert.doesNotMatch(invocation.prompt, /role = 'admin'|diff --git/);
  assert.equal(invocation.args.filter(value => value === "--mcp-config").length, 1);
  await assert.rejects(() => stat(invocation.cwd), error => error.code === "ENOENT");
});

test("background worker publishes finalizing from lease state before result and persists the terminal metrics", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "review-evidence-background-"));
  const workspace = join(fixture, "workspace"), stateRoot = join(fixture, "state"), capture = join(fixture, "capture.json"), fake = join(fixture, "claude.mjs");
  await mkdir(workspace);
  await command("git", ["init", "--quiet"], workspace);
  await command("git", ["config", "user.email", "test@example.invalid"], workspace);
  await command("git", ["config", "user.name", "Test"], workspace);
  await writeFile(join(workspace, "review.mjs"), "export const value = 1;\n");
  await command("git", ["add", "review.mjs"], workspace);
  await command("git", ["commit", "--quiet", "-m", "base"], workspace);
  await writeFile(join(workspace, "review.mjs"), "export const value = 2;\n");
  await writeFile(fake, `#!/usr/bin/env node
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
let prompt = ""; for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2), config = JSON.parse(await readFile(args[args.indexOf("--mcp-config") + 1], "utf8")), statePath = config.mcpServers.review_evidence.env.REVIEW_LEASE_STATE_PATH;
async function state(revision, phase, used, remaining) { const temporary = statePath + "." + revision + ".tmp"; await writeFile(temporary, JSON.stringify({ revision, serverPid: process.pid + 1, serverPpid: process.pid, phase, updatedAt: new Date().toISOString(), limitUnits: 5, usedUnits: used, remainingUnits: remaining, exhausted: remaining === 0, allowedCalls: used === 0 ? 0 : 3, deniedCalls: 0, bytesReturned: 2048, filesExamined: ["review.mjs"], filesSkipped: [] }), { mode: 0o600 }); await rename(temporary, statePath); await chmod(statePath, 0o600); }
await state(1, "investigating", 1, 4);
await writeFile(process.env.CAPTURE_INVOCATION, JSON.stringify({ cwd: process.cwd(), args }));
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "background-evidence", mcp_servers: [{ name: "review_evidence", status: "connected" }], tools: ["mcp__review_evidence__review_diff", "mcp__review_evidence__review_file", "mcp__review_evidence__review_context", "StructuredOutput"] }) + "\\n");
await new Promise(resolve => setTimeout(resolve, 180));
await state(2, "finalizing", 5, 0);
await new Promise(resolve => setTimeout(resolve, 550));
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "background-evidence-ok", session_id: "background-evidence", structured_output: { verdict: "approve", summary: "done", findings: [], next_steps: [], coverage: { files_examined: ["review.mjs"], files_skipped: [], areas: ["change"] }, uncertainty: "low", budget_exhausted: false, recommended_followup: { profile: "none", focus: [], reason: "" } }, usage: { input_tokens: 1, output_tokens: 1 }, num_turns: 4 }) + "\\n");
`);
  await chmod(fake, 0o755);
  const env = { ...process.env, CLAUDE_CODE_EXECUTABLE: fake, CAPTURE_INVOCATION: capture, CLAUDE_COMPANION_STATE_ROOT: stateRoot, CLAUDE_COMPANION_CONFIG_ROOT: join(fixture, "config"), CLAUDE_COMPANION_REVIEW_EVIDENCE_LEASE: "on" };
  const launched = await callMcp(env, "claude_review_changes", { workspace_root: workspace, background: true });
  let finalizing;
  const phaseDeadline = Date.now() + 5_000;
  while (Date.now() < phaseDeadline) {
    const status = await callMcp(env, "claude_job_status", { workspace_root: workspace, job_id: launched.id });
    if (status.status === "running" && status.phase === "finalizing") { finalizing = status; break; }
    await new Promise(resolveWait => setTimeout(resolveWait, 40));
  }
  assert(finalizing, "expected a running/finalizing status before the result event");
  assert.equal(finalizing.evidence_lease.remaining_units, 0);
  let completed;
  const completionDeadline = Date.now() + 5_000;
  while (Date.now() < completionDeadline) {
    completed = await callMcp(env, "claude_job_status", { workspace_root: workspace, job_id: launched.id });
    if (completed.status === "completed") break;
    await new Promise(resolveWait => setTimeout(resolveWait, 40));
  }
  assert.equal(completed.status, "completed");
  assert.equal(completed.evidence_lease_exhausted, true);
  assert.equal(completed.cost_budget_exhausted, false);
  assert.equal(completed.turn_limit_reached, false);
  const result = await callMcp(env, "claude_job_result", { workspace_root: workspace, job_id: launched.id });
  assert.equal(result.result, "background-evidence-ok");
  assert.equal(result.evidence_lease.revision, 2);
  const invocation = JSON.parse(await readFile(capture, "utf8"));
  await assert.rejects(() => stat(invocation.cwd), error => error.code === "ENOENT");
});

test("cancellation terminates the worker, Claude, and CLI-owned MCP tree and removes control state", async () => {
  const fx = await longRunningEvidenceFixture("cancel");
  const launched = await callMcp(fx.env, "claude_review_changes", { workspace_root: fx.workspace, background: true });
  const capture = JSON.parse(await waitForFile(fx.capture));
  const cancelled = await callMcp(fx.env, "claude_job_cancel", { workspace_root: fx.workspace, job_id: launched.id });
  assert.equal(cancelled.status, "cancelled");
  for (const pid of [launched.pid, capture.claudePid, capture.mcpPid]) assertProcessGone(pid);
  await assert.rejects(() => stat(capture.cwd), error => error.code === "ENOENT");
});

test("timeout terminates the full review process tree and removes control state", async () => {
  const fx = await longRunningEvidenceFixture("timeout");
  const launched = await callMcp(fx.env, "claude_review_changes", { workspace_root: fx.workspace, background: true, timeout_ms: 1_000 });
  const capture = JSON.parse(await waitForFile(fx.capture));
  let status;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    status = await callMcp(fx.env, "claude_job_status", { workspace_root: fx.workspace, job_id: launched.id });
    if (status.status === "timed_out") break;
    await new Promise(resolveWait => setTimeout(resolveWait, 40));
  }
  assert.equal(status.status, "timed_out");
  for (const pid of [launched.pid, capture.claudePid, capture.mcpPid]) assertProcessGone(pid);
  await assert.rejects(() => stat(capture.cwd), error => error.code === "ENOENT");
});

test("corrupt lease ownership fails closed as mcp_startup and leaves no orphan MCP", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "review-evidence-corrupt-state-"));
  const workspace = join(fixture, "workspace"), capture = join(fixture, "capture.json"), fake = join(fixture, "claude.mjs");
  await mkdir(workspace);
  await command("git", ["init", "--quiet"], workspace);
  await command("git", ["config", "user.email", "test@example.invalid"], workspace);
  await command("git", ["config", "user.name", "Test"], workspace);
  await writeFile(join(workspace, "file.mjs"), "export const value = 1;\n");
  await command("git", ["add", "file.mjs"], workspace);
  await command("git", ["commit", "--quiet", "-m", "base"], workspace);
  await writeFile(join(workspace, "file.mjs"), "export const value = 2;\n");
  await writeFile(fake, `#!/usr/bin/env node
import { readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
let prompt = ""; for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2), config = JSON.parse(await readFile(args[args.indexOf("--mcp-config") + 1], "utf8")), statePath = config.mcpServers.review_evidence.env.REVIEW_LEASE_STATE_PATH;
const mcp = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { shell: false, stdio: "ignore" });
await writeFile(statePath + ".tmp", JSON.stringify({ revision: 1, serverPid: mcp.pid, serverPpid: process.pid + 999, phase: "investigating", updatedAt: new Date().toISOString(), limitUnits: 5, usedUnits: 0, remainingUnits: 5, exhausted: false, allowedCalls: 0, deniedCalls: 0, bytesReturned: 0, filesExamined: [], filesSkipped: [] }), { mode: 0o600 });
await rename(statePath + ".tmp", statePath);
await writeFile(process.env.CAPTURE_INVOCATION, JSON.stringify({ cwd: process.cwd(), claudePid: process.pid, mcpPid: mcp.pid }));
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "corrupt-review", mcp_servers: [{ name: "review_evidence", status: "connected" }], tools: ["mcp__review_evidence__review_diff", "mcp__review_evidence__review_file", "mcp__review_evidence__review_context", "StructuredOutput"] }) + "\\n");
setInterval(() => {}, 1000);
`);
  await chmod(fake, 0o755);
  const env = { ...process.env, CLAUDE_CODE_EXECUTABLE: fake, CAPTURE_INVOCATION: capture, CLAUDE_COMPANION_STATE_ROOT: join(fixture, "state"), CLAUDE_COMPANION_CONFIG_ROOT: join(fixture, "config"), CLAUDE_COMPANION_REVIEW_EVIDENCE_LEASE: "on" };
  const launched = await callMcp(env, "claude_review_changes", { workspace_root: workspace, background: true });
  const invocation = JSON.parse(await waitForFile(capture));
  let failed;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    failed = await callMcp(env, "claude_job_status", { workspace_root: workspace, job_id: launched.id });
    if (failed.status === "failed") break;
    await new Promise(resolveWait => setTimeout(resolveWait, 40));
  }
  assert.equal(failed.error_kind, "mcp_startup");
  assert.match(failed.error, /parent PID/i);
  for (const pid of [invocation.claudePid, invocation.mcpPid]) assertProcessGone(pid);
  await assert.rejects(() => stat(invocation.cwd), error => error.code === "ENOENT");
});

async function longRunningEvidenceFixture(name) {
  const fixture = await mkdtemp(join(tmpdir(), `review-evidence-${name}-`));
  const workspace = join(fixture, "workspace"), capture = join(fixture, "capture.json"), fake = join(fixture, "claude.mjs");
  await mkdir(workspace);
  await command("git", ["init", "--quiet"], workspace);
  await command("git", ["config", "user.email", "test@example.invalid"], workspace);
  await command("git", ["config", "user.name", "Test"], workspace);
  await writeFile(join(workspace, "file.mjs"), "export const value = 1;\n");
  await command("git", ["add", "file.mjs"], workspace);
  await command("git", ["commit", "--quiet", "-m", "base"], workspace);
  await writeFile(join(workspace, "file.mjs"), "export const value = 2;\n");
  await writeFile(fake, `#!/usr/bin/env node
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
let prompt = ""; for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2), config = JSON.parse(await readFile(args[args.indexOf("--mcp-config") + 1], "utf8")), statePath = config.mcpServers.review_evidence.env.REVIEW_LEASE_STATE_PATH;
const mcp = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { shell: false, stdio: "ignore" });
const temporary = statePath + ".tmp";
await writeFile(temporary, JSON.stringify({ revision: 1, serverPid: mcp.pid, serverPpid: process.pid, phase: "investigating", updatedAt: new Date().toISOString(), limitUnits: 5, usedUnits: 0, remainingUnits: 5, exhausted: false, allowedCalls: 0, deniedCalls: 0, bytesReturned: 0, filesExamined: [], filesSkipped: [] }), { mode: 0o600 });
await rename(temporary, statePath); await chmod(statePath, 0o600);
await writeFile(process.env.CAPTURE_INVOCATION, JSON.stringify({ cwd: process.cwd(), claudePid: process.pid, mcpPid: mcp.pid }));
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "long-review", mcp_servers: [{ name: "review_evidence", status: "connected" }], tools: ["mcp__review_evidence__review_diff", "mcp__review_evidence__review_file", "mcp__review_evidence__review_context", "StructuredOutput"] }) + "\\n");
setInterval(() => {}, 1000);
`);
  await chmod(fake, 0o755);
  return { workspace, capture, env: { ...process.env, CLAUDE_CODE_EXECUTABLE: fake, CAPTURE_INVOCATION: capture, CLAUDE_COMPANION_STATE_ROOT: join(fixture, "state"), CLAUDE_COMPANION_CONFIG_ROOT: join(fixture, "config"), CLAUDE_COMPANION_REVIEW_EVIDENCE_LEASE: "on" } };
}

async function waitForFile(path) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { return await readFile(path, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function assertProcessGone(pid) {
  assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH");
}

function command(executable, args, cwd) {
  return new Promise((resolveCommand, reject) => {
    import("node:child_process").then(({ spawn }) => {
      const child = spawn(executable, args, { cwd, shell: false, stdio: "ignore" });
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolveCommand() : reject(new Error(`${executable} exited ${code}`)));
    }, reject);
  });
}
