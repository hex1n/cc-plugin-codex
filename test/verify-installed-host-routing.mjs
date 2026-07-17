#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "cc-plugin-host-verifier-"));
const codexHome = join(root, "codex-home"), workspace = join(root, "workspace"), state = join(root, "state"), writes = join(root, "writes"), config = join(root, "config"), fake = join(root, "claude-fake.mjs");
await mkdir(codexHome); await mkdir(workspace);

const marketplaces = JSON.parse((await command("codex", ["plugin", "marketplace", "list", "--json"], sourceRoot)).stdout);
const personal = marketplaces.marketplaces.find(value => value.name === "personal");
assert(personal?.root, "personal marketplace is required for installed-host verification");
await command("codex", ["plugin", "marketplace", "add", personal.root, "--json"], sourceRoot, { ...process.env, CODEX_HOME: codexHome });
const installed = JSON.parse((await command("codex", ["plugin", "add", "cc-plugin-codex@personal", "--json"], sourceRoot, { ...process.env, CODEX_HOME: codexHome })).stdout);
const pluginRoot = installed.installedPath;
await assertTreeEqual("mcp", pluginRoot); await assertTreeEqual("skills", pluginRoot);
for (const path of ["package.json", ".codex-plugin/plugin.json", ".mcp.json", "scripts/claude-admin.mjs"]) assert.equal(await readFile(join(sourceRoot, path), "utf8"), await readFile(join(pluginRoot, path), "utf8"), `${path} differs in temporary install`);
await assert.rejects(() => access(join(pluginRoot, "scripts", "claude-companion.mjs"), constants.F_OK), error => error.code === "ENOENT");

const localRoot = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "plugins", "cache", "personal", "cc-plugin-codex", installed.version);
await assertTreeEqual("mcp", localRoot); await assertTreeEqual("skills", localRoot);
for (const path of ["package.json", ".codex-plugin/plugin.json", ".mcp.json", "scripts/claude-admin.mjs"]) assert.equal(await readFile(join(sourceRoot, path), "utf8"), await readFile(join(localRoot, path), "utf8"), `${path} differs in installed user cache`);
await assert.rejects(() => access(join(localRoot, "scripts", "claude-companion.mjs"), constants.F_OK), error => error.code === "ENOENT");

for (const args of [["init", "--quiet"], ["config", "user.email", "test@example.invalid"], ["config", "user.name", "Test"]]) await command("git", args, workspace);
await writeFile(join(workspace, "base.txt"), "base\n"); await mkdir(join(workspace, "docs")); await writeFile(join(workspace, "docs", "plan.md"), "# Plan\n\nVerify host routing.\n");
await command("git", ["add", "."], workspace); await command("git", ["commit", "--quiet", "-m", "base"], workspace); await writeFile(join(workspace, "base.txt"), "changed\n");
await writeFile(fake, `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
if (process.argv[2] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "fixture" })); process.exit(0); }
let prompt = ""; for await (const chunk of process.stdin) prompt += chunk;
if (prompt.includes("HOST_CANCEL_MARKER")) { process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000); }
if (process.argv.includes("acceptEdits")) await writeFile("agent-output.txt", "host-routed write\\n");
const output = { type: "result", subtype: "success", is_error: false, result: "host-ok", session_id: "host-session", usage: { input_tokens: 2, output_tokens: 1 }, modelUsage: { "fixture-model": { inputTokens: 2, outputTokens: 1 } }, total_cost_usd: 0, num_turns: 1 };
if (prompt.includes("<plan_snapshot>")) output.structured_output = { verdict: "approve", summary: "ready", findings: [], coverage: { areas_examined: ["routing"], areas_skipped: [] }, uncertainty: "low", budget_exhausted: false, recommended_followup: { profile: "none", focus: [], reason: "" } };
else if (process.argv.includes("--json-schema")) output.structured_output = { verdict: "approve", summary: "ready", findings: [], next_steps: [], coverage: { files_examined: ["base.txt"], files_skipped: [], areas: ["routing"] }, uncertainty: "low", budget_exhausted: false, recommended_followup: { profile: "none", focus: [], reason: "" } };
console.log(JSON.stringify(output));
`); await chmod(fake, 0o755);

const manifestPath = join(pluginRoot, "config", "sandbox-compatibility.json"), manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.entries = [{ ...manifest.entries[0], claudeVersion: "9.9.9", executableSha256: createHash("sha256").update(await readFile(fake)).digest("hex"), verifiedAt: "fixture-only" }];
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const mcpConfigPath = join(pluginRoot, ".mcp.json"), mcpConfig = JSON.parse(await readFile(mcpConfigPath, "utf8"));
mcpConfig.mcpServers["cc-plugin-codex"].env = { CLAUDE_CODE_EXECUTABLE: fake, CLAUDE_COMPANION_STATE_ROOT: state, CLAUDE_COMPANION_WRITE_ROOT: writes, CLAUDE_COMPANION_CONFIG_ROOT: config };
await writeFile(mcpConfigPath, `${JSON.stringify(mcpConfig, null, 2)}\n`);

const env = { ...process.env, CODEX_HOME: codexHome }, evidence = [];
await withSession(async call => { assert.equal((await call("claude_review_changes", { workspace_root: workspace })).review_kind, "code"); evidence.push("code-review"); assert.equal((await call("claude_review_plan", { workspace_root: workspace, target_file: "docs/plan.md" })).review_kind, "plan"); evidence.push("plan-review"); }, true);
await withSession(async call => { assert.equal((await call("claude_adversarial_review", { workspace_root: workspace, focus: "host routing" })).review_kind, "adversarial"); evidence.push("adversarial-review"); assert.equal((await call("claude_task_readonly", { workspace_root: workspace, task: "inspect host routing" })).result, "host-ok"); evidence.push("readonly-task"); });
await withSession(async call => { const job = await call("claude_task_readonly", { workspace_root: workspace, task: "background result", background: true }); evidence.push("background-start"); await waitFor(call, job.id, "completed"); evidence.push("background-status"); assert.equal((await call("claude_job_result", { workspace_root: workspace, job_id: job.id })).result, "host-ok"); evidence.push("background-result"); });
await withSession(async call => { const job = await call("claude_task_readonly", { workspace_root: workspace, task: "HOST_CANCEL_MARKER", background: true }); evidence.push("cancel-start"); await waitFor(call, job.id, "running"); evidence.push("cancel-status"); assert.equal((await call("claude_job_cancel", { workspace_root: workspace, job_id: job.id })).status, "cancelled"); evidence.push("cancel"); });
await withSession(async call => {
  const discarded = await call("claude_write_task_start", { workspace_root: workspace, task: "create then discard" }); evidence.push("write-discard-start"); assert.equal((await waitFor(call, discarded.id, "completed")).artifact_status, "awaiting_apply"); evidence.push("write-discard-status"); assert.equal((await call("claude_write_task_discard", { workspace_root: workspace, job_id: discarded.id })).artifact_status, "discarded"); evidence.push("write-discard");
  const applied = await call("claude_write_task_start", { workspace_root: workspace, task: "create then apply" }); evidence.push("write-apply-start"); await waitFor(call, applied.id, "completed"); evidence.push("write-apply-status"); assert.equal((await call("claude_write_task_apply", { workspace_root: workspace, job_id: applied.id })).artifact_status, "applied"); evidence.push("write-apply"); assert.equal(await readFile(join(workspace, "agent-output.txt"), "utf8"), "host-routed write\n");
});
assert(evidence.length >= 10);
process.stdout.write(`${JSON.stringify({ criterion: "installed-host-routing-complete", fresh_sessions: 5, operations: evidence.length, tools: 12, skills: 9, legacy_cli_surface: false, automatic_fallbacks: 0, evidence })}\n`);

async function withSession(operation, verifyInventory = false) {
  const client = startAppServer();
  try {
    await client.request("initialize", { clientInfo: { name: "cc-plugin-host-verifier", version: "1" }, capabilities: { experimentalApi: true } });
    if (verifyInventory) { const inventory = await client.request("mcpServerStatus/list", { detail: "full" }), server = inventory.data.find(value => value.name === "cc-plugin-codex"); assert.equal(Object.keys(server.tools).length, 12); const skills = await client.request("skills/list", { cwds: [workspace], forceReload: true }); assert.equal(skills.data[0].skills.filter(value => value.name.startsWith("cc-plugin-codex:")).length, 9); }
    const started = await client.request("thread/start", { cwd: workspace, ephemeral: true, approvalPolicy: "never", sandbox: "read-only" });
    await operation(async (tool, arguments_) => { const result = await client.request("mcpServer/tool/call", { server: "cc-plugin-codex", threadId: started.thread.id, tool, arguments: arguments_ }); if (result.isError) throw new Error(`${tool}: ${JSON.stringify(result)}`); return result.structuredContent; });
  } finally { client.close(); }
}

async function waitFor(call, id, target) { const deadline = Date.now() + 12_000; let job; while (Date.now() < deadline) { job = await call("claude_job_status", { workspace_root: workspace, job_id: id }); if (job.status === target || (target === "completed" && !["starting", "running", "queued"].includes(job.status))) return job; await new Promise(resolveWait => setTimeout(resolveWait, 40)); } throw new Error(`Timed out waiting for ${id} -> ${target}; last=${job?.status}`); }

function startAppServer() {
  const child = spawn("codex", ["app-server", "--stdio"], { cwd: workspace, env, shell: false, stdio: ["pipe", "pipe", "pipe"] }); let buffer = "", stderr = "", nextId = 1; const pending = new Map();
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => { stderr += chunk; }); child.stdout.on("data", chunk => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\n"); if (newline < 0) break; const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1); if (!line) continue; const message = JSON.parse(line); if (message.id != null && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); } } });
  return { request(method, params) { const id = nextId++; child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); return new Promise((resolveRequest, reject) => { const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}: ${stderr}`)), 15_000); pending.set(id, message => { clearTimeout(timer); message.error ? reject(new Error(`${method}: ${JSON.stringify(message.error)}`)) : resolveRequest(message.result); }); }); }, close() { child.stdin.end(); child.kill(); } };
}

async function assertTreeEqual(directory, installedRoot) { for (const path of await filesBelow(join(sourceRoot, directory))) { const relativePath = relative(sourceRoot, path); assert.equal(await readFile(path, "utf8"), await readFile(join(installedRoot, relativePath), "utf8"), `${relativePath} differs from installed cache`); } }
async function filesBelow(directory) { const output = []; for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) output.push(...await filesBelow(path)); else if (entry.isFile()) output.push(path); } return output; }
function command(executable, args, cwd, commandEnv = process.env) { return new Promise((resolveCommand, reject) => { const child = spawn(executable, args, { cwd, env: commandEnv, shell: false, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; }); child.once("error", reject); child.once("close", code => code === 0 ? resolveCommand({ stdout, stderr }) : reject(new Error(`${executable} exited ${code}: ${stderr}`))); }); }
