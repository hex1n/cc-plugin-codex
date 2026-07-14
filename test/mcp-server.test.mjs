import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, mkdtemp, mkdir, readFile, realpath, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const serverPath = resolve("mcp/server.mjs");

async function fixture({ verifiedWrite = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "mcp-server-test-")), workspace = join(root, "workspace"), state = join(root, "state"), fake = join(root, "claude"), capture = join(root, "invocation.json");
  await mkdir(workspace); await command("git", ["init", "--quiet"], workspace); await command("git", ["config", "user.email", "test@example.invalid"], workspace); await command("git", ["config", "user.name", "Test"], workspace); await writeFile(join(workspace, "base.txt"), "base\n"); await command("git", ["add", "base.txt"], workspace); await command("git", ["commit", "--quiet", "-m", "base"], workspace);
  await mkdir(join(workspace, "docs")); await writeFile(join(workspace, "docs", "plan.md"), "# Plan\n\nValidate the rollout.\n");
  await writeFile(fake, `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
if(process.argv[2]==="--version"){console.log("2.1.208 (Claude Code)");process.exit(0)}
let prompt="";for await(const chunk of process.stdin)prompt+=chunk;const args=process.argv.slice(2);if(args.includes("acceptEdits"))await writeFile("agent-output.txt","isolated write\\n");await writeFile(process.env.CAPTURE_INVOCATION,JSON.stringify({args,prompt,cwd:process.cwd()}));const base={type:"result",subtype:"success",is_error:false,result:"mcp-ok",session_id:"mcp-session",usage:{input_tokens:2,output_tokens:1},modelUsage:{"claude-sonnet-test":{inputTokens:2,outputTokens:1}},total_cost_usd:0.01,num_turns:1};if(prompt.includes("<plan_snapshot>"))base.structured_output={verdict:"approve",summary:"ready",findings:[],coverage:{areas_examined:["rollout"],areas_skipped:[]},uncertainty:"low",budget_exhausted:false,recommended_followup:{profile:"none",focus:[],reason:""}};console.log(JSON.stringify(base));
`); await chmod(fake, 0o755);
  let testServerPath = serverPath;
  if (verifiedWrite) {
    const sourceRoot = resolve("."), pluginRoot = join(root, "plugin-copy");
    await cp(sourceRoot, pluginRoot, { recursive: true, filter: source => { const name = relative(sourceRoot, source); return name !== ".git" && !name.startsWith(`.git/`) && name !== "node_modules" && !name.startsWith(`node_modules/`); } });
    const manifestPath = join(pluginRoot, "config", "sandbox-compatibility.json"), manifest = JSON.parse(await readFile(manifestPath, "utf8")), executableSha256 = createHash("sha256").update(await readFile(fake)).digest("hex");
    manifest.entries = manifest.entries.map(entry => ({ ...entry, executableSha256 })); await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    testServerPath = join(pluginRoot, "mcp", "server.mjs");
  }
  return { workspace, capture, serverPath: testServerPath, env: { ...process.env, CLAUDE_CODE_EXECUTABLE: fake, CAPTURE_INVOCATION: capture, CLAUDE_COMPANION_STATE_ROOT: state, CLAUDE_COMPANION_WRITE_ROOT: join(root, "write-workspaces") } };
}

test("typed MCP lists tools and runs a read-only task through the shared service", async () => {
  const fx = await fixture();
  const responses = await mcp(fx.env, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "claude_task_readonly", arguments: { workspace_root: fx.workspace, task: "inspect the project", model: "fable", effort: "high" } } }
  ]);
  assert.equal(responses.find(value => value.id === 1).result.serverInfo.name, "cc-plugin-codex");
  const names = responses.find(value => value.id === 2).result.tools.map(tool => tool.name);
  for (const name of ["claude_review_changes", "claude_review_plan", "claude_task_readonly", "claude_write_task_start", "claude_write_task_apply", "claude_write_task_discard", "claude_job_status", "claude_job_result", "claude_job_cancel"]) assert(names.includes(name), name);
  const called = responses.find(value => value.id === 3).result;
  assert.equal(called.structuredContent.result, "mcp-ok");
  assert.equal(called.structuredContent.requested_model, "fable");
  assert.deepEqual(called.structuredContent.effective_models, ["claude-sonnet-test"]);
  const invocation = JSON.parse(await readFile(fx.capture, "utf8"));
  assert.equal(invocation.cwd, await realpath(fx.workspace));
  assert.match(invocation.prompt, /inspect the project/);
  assert(invocation.args.includes("plan"));
  assert(!invocation.args.includes("acceptEdits"));
  assert(!invocation.args.includes("--"));
});

test("typed plan review uses the review capability and reports immutable subject metadata", async () => {
  const fx = await fixture(), responses = await mcp(fx.env, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "claude_review_plan", arguments: { workspace_root: fx.workspace, target_file: "docs/plan.md", model: "claude-fable-5", effort: "high" } } }]);
  const payload = responses[0].result.structuredContent;
  assert.equal(payload.review_kind, "plan"); assert.equal(payload.subject_kind, "file"); assert.equal(payload.subject_label, "docs/plan.md"); assert.match(payload.subject_fingerprint, /^[a-f0-9]{64}$/); assert.equal(payload.requested_model, "claude-fable-5");
  const invocation = JSON.parse(await readFile(fx.capture, "utf8"));
  assert(invocation.args.includes("plan")); assert(!invocation.args.includes("acceptEdits")); assert.match(invocation.prompt, /Validate the rollout/); assert.match(invocation.prompt, /Snapshot SHA-256/);
});

test("background plan review persists subject metadata without plan content", async () => {
  const fx = await fixture(), started = await mcp(fx.env, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "claude_review_plan", arguments: { workspace_root: fx.workspace, target_file: "docs/plan.md", background: true } } }]), id = started[0].result.structuredContent.id;
  let status; const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) { status = (await mcp(fx.env, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "claude_job_status", arguments: { workspace_root: fx.workspace, job_id: id } } }]))[0].result.structuredContent; if (status.status === "completed") break; await new Promise(resolveWait => setTimeout(resolveWait, 40)); }
  assert.equal(status.review_kind, "plan"); assert.equal(status.subject_label, "docs/plan.md");
  const result = (await mcp(fx.env, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "claude_job_result", arguments: { workspace_root: fx.workspace, job_id: id } } }]))[0].result.structuredContent;
  assert.equal(result.review_kind, "plan"); assert.equal(result.subject_label, "docs/plan.md");
  const [directory] = await readdir(fx.env.CLAUDE_COMPANION_STATE_ROOT), record = await readFile(join(fx.env.CLAUDE_COMPANION_STATE_ROOT, directory, `${id}.json`), "utf8");
  assert.doesNotMatch(record, /Validate the rollout/);
});

test("background failures preserve plan subject and usage metadata through MCP", async () => {
  const fx = await fixture(), cwd = await realpath(fx.workspace), id = "failed-plan", directory = join(fx.env.CLAUDE_COMPANION_STATE_ROOT, createHash("sha256").update(cwd).digest("hex").slice(0, 16));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${id}.json`), `${JSON.stringify({ recordVersion: 3, id, cwd, profile: "review", reviewProfile: "quick", purpose: "user", operation: "review", reviewKind: "plan", subjectKind: "file", subjectLabel: "docs/plan.md", subjectFingerprint: "a".repeat(64), transport: "mcp", capability: "read-only", status: "failed", phase: "failed", error: "budget exhausted", errorKind: "max_budget", requestedModel: "sonnet", effectiveModels: ["claude-sonnet-test"], usage: { input_tokens: 12, output_tokens: 3 }, modelUsage: { "claude-sonnet-test": { inputTokens: 12, outputTokens: 3 } }, totalCostUsd: 0.02, numTurns: 2, durationMs: 50, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() })}\n`);
  const response = (await mcp(fx.env, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "claude_job_result", arguments: { workspace_root: fx.workspace, job_id: id } } }]))[0];
  assert.equal(response.error.code, -32603);
  assert.equal(response.error.data.review_kind, "plan"); assert.equal(response.error.data.subject_label, "docs/plan.md"); assert.equal(response.error.data.requested_model, "sonnet"); assert.deepEqual(response.error.data.effective_models, ["claude-sonnet-test"]); assert.equal(response.error.data.total_cost_usd, 0.02); assert.equal(response.error.data.usage.output_tokens, 3);
});

test("MCP write rejects an unverified executable before workspace creation", async () => {
  const fx = await fixture(), responses = await mcp(fx.env, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "claude_write_task_start", arguments: { workspace_root: fx.workspace, task: "create agent-output.txt" } } }
  ]);
  const failure = responses.find(value => value.id === 2).error;
  assert.equal(failure.code, -32603); assert.equal(failure.data.error_kind, "write_capability_unavailable"); assert.match(failure.message, /identity/i);
  await assert.rejects(() => stat(join(fx.workspace, "agent-output.txt")), error => error.code === "ENOENT");
  await assert.rejects(() => stat(fx.env.CLAUDE_COMPANION_WRITE_ROOT), error => error.code === "ENOENT");
});

test("verified temporary plugin copy completes public MCP write discard and apply", { skip: process.platform !== "darwin" }, async () => {
  const fx = await fixture({ verifiedWrite: true });
  async function start(task) { return (await mcp(fx.env, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "claude_write_task_start", arguments: { workspace_root: fx.workspace, task } } }], fx.serverPath))[0].result.structuredContent; }
  async function wait(id) { let job; const deadline = Date.now() + 10_000; while (Date.now() < deadline) { job = (await mcp(fx.env, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "claude_job_status", arguments: { workspace_root: fx.workspace, job_id: id } } }], fx.serverPath))[0].result.structuredContent; if (job.status === "completed") return job; await new Promise(resolveWait => setTimeout(resolveWait, 40)); } throw new Error(`Timed out waiting for ${id}: ${job?.status}`); }
  const discardedStart = await start("create then discard"), discarded = await wait(discardedStart.id);
  assert.equal(discarded.artifact_status, "awaiting_apply"); assert.equal(discarded.sandbox_verified, true);
  const discardResult = (await mcp(fx.env, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "claude_write_task_discard", arguments: { workspace_root: fx.workspace, job_id: discarded.id } } }], fx.serverPath))[0].result.structuredContent;
  assert.equal(discardResult.artifact_status, "discarded"); await assert.rejects(() => stat(join(fx.workspace, "agent-output.txt")), error => error.code === "ENOENT");
  const appliedStart = await start("create then apply"), appliedReady = await wait(appliedStart.id);
  const applyResult = (await mcp(fx.env, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "claude_write_task_apply", arguments: { workspace_root: fx.workspace, job_id: appliedReady.id } } }], fx.serverPath))[0].result.structuredContent;
  assert.equal(applyResult.artifact_status, "applied"); assert.equal(await readFile(join(fx.workspace, "agent-output.txt"), "utf8"), "isolated write\n");
});

test("MCP rejects unknown fields before invoking Claude", async () => {
  const fx = await fixture(), responses = await mcp(fx.env, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "claude_task_readonly", arguments: { workspace_root: fx.workspace, task: "inspect", write: true } } }
  ]);
  const error = responses.find(value => value.id === 2).error;
  assert.equal(error.code, -32602);
  assert.match(error.message, /unknown|write/i);
  await assert.rejects(() => readFile(fx.capture, "utf8"), value => value.code === "ENOENT");
});

test("plugin manifest exposes the local MCP server", async () => {
  const manifest = JSON.parse(await readFile(resolve(".codex-plugin/plugin.json"), "utf8")), mcpConfig = JSON.parse(await readFile(resolve(".mcp.json"), "utf8"));
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.deepEqual(mcpConfig.mcpServers["cc-plugin-codex"], { command: "node", args: ["./mcp/server.mjs"], cwd: "." });
});

test("CLI and MCP are thin adapters over a transport-neutral service", async () => {
  const service = await readFile(resolve("scripts/lib/service.mjs"), "utf8"), cli = await readFile(resolve("scripts/claude-companion.mjs"), "utf8"), server = await readFile(serverPath, "utf8");
  assert.doesNotMatch(service, /process\.argv|readline|\.\/render\.mjs|mcp\/server/);
  assert.match(cli, /from "\.\/lib\/service\.mjs"/); assert.match(server, /from "\.\.\/scripts\/lib\/service\.mjs"/); assert.doesNotMatch(server, /claude-companion|spawn\(/);
});

function mcp(env, messages, executable = serverPath) {
  return new Promise((resolveMcp, reject) => {
    const child = spawn(process.execPath, [executable], { cwd: dirname(dirname(executable)), env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; }); child.once("error", reject); child.once("close", code => code === 0 ? resolveMcp(stdout.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)) : reject(new Error(`MCP exited ${code}: ${stderr}`))); child.stdin.end(`${messages.map(JSON.stringify).join("\n")}\n`);
  });
}

function command(executable, args, cwd) {
  return new Promise((resolveCommand, reject) => { const child = spawn(executable, args, { cwd, shell: false, stdio: "ignore" }); child.once("error", reject); child.once("close", code => code === 0 ? resolveCommand() : reject(new Error(`${executable} exited ${code}`))); });
}
