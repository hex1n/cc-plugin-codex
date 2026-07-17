import { readReviewGateConfig, setReviewGateEnabled } from "./config.mjs";
import { spawn } from "node:child_process";
import { PLUGIN_ROOT, pluginPath } from "./paths.mjs";
import { findWorkspaceRoot } from "./git.mjs";
import { reconcileJob } from "./job-lifecycle.mjs";
import { listClaudeJobs, projectJob } from "./job-query-service.mjs";
import { listJobs, readJob } from "./state.mjs";
import { cancelJob, discardWriteResult } from "./service.mjs";

export async function controlReviewGate(action) {
  if (action === "enable") await setReviewGateEnabled(true);
  else if (action === "disable") await setReviewGateEnabled(false);
  else if (action !== "status") throw new Error("review-gate action must be status, enable, or disable");
  const gate = await readReviewGateConfig();
  return { enabled: gate.enabled, config_path: gate.path, source: gate.source };
}

export async function probeMcp({ serverPath = process.env.CLAUDE_COMPANION_MCP_SERVER || pluginPath("mcp", "server.mjs"), timeoutMs = 5_000 } = {}) {
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-companion-admin", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
  ];
  const responses = await runMcpProbe(serverPath, messages, timeoutMs);
  const initialized = responses.find(value => value.id === 1), listed = responses.find(value => value.id === 2);
  if (initialized?.error) throw new Error(`MCP initialize failed: ${initialized.error.message}`);
  if (!initialized?.result?.serverInfo?.name) throw new Error("MCP initialize did not return serverInfo");
  if (listed?.error) throw new Error(`MCP tools/list failed: ${listed.error.message}`);
  if (!Array.isArray(listed?.result?.tools)) throw new Error("MCP tools/list did not return tools");
  const tools = listed.result.tools.map(tool => tool.name);
  if (new Set(tools).size !== tools.length || tools.some(name => typeof name !== "string" || !name)) throw new Error("MCP tools/list returned invalid tool names");
  return { ok: true, server_name: initialized.result.serverInfo.name, server_version: initialized.result.serverInfo.version ?? null, tool_count: tools.length, tools };
}

export async function listAdminJobs(request) { return listClaudeJobs(request); }

export async function reconcileAdminJobs({ workspaceRoot }) {
  const workspace = await findWorkspaceRoot(workspaceRoot);
  await Promise.all((await listJobs(workspace)).map(job => reconcileJob(job)));
  return listClaudeJobs({ workspaceRoot: workspace, includeTest: true, limit: 100 });
}

export async function cancelAdminJob({ workspaceRoot, jobId }) {
  const outcome = await cancelJob({ workspaceRoot, jobId });
  return projectJob(outcome.job);
}

export async function inspectAdminArtifact({ workspaceRoot, jobId }) {
  const workspace = await findWorkspaceRoot(workspaceRoot), job = await readJob(workspace, jobId);
  if (!job.write && !job.artifactStatus) throw new Error(`Job ${jobId} does not own a write artifact`);
  return projectArtifact(job);
}

export async function discardAdminArtifact({ workspaceRoot, jobId }) {
  const outcome = await discardWriteResult({ workspaceRoot, jobId });
  return projectArtifact(outcome.job);
}

function projectArtifact(job) {
  return {
    id: job.id,
    status: job.status,
    phase: job.phase ?? null,
    artifact_status: job.artifactStatus ?? null,
    patch_hash: job.patchHash ?? null,
    patch_bytes: job.patchBytes ?? null,
    changed_paths: job.changedPaths ?? [],
    recovery_required: job.recoveryRequired === true,
    cleanup_pending: job.cleanupPending === true,
    error_kind: job.errorKind ?? null
  };
}

function runMcpProbe(serverPath, messages, timeoutMs) {
  return new Promise((resolveProbe, reject) => {
    const child = spawn(process.execPath, [serverPath], { cwd: PLUGIN_ROOT, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const timer = setTimeout(() => { child.kill(); finish(new Error(`MCP probe timed out after ${timeoutMs}ms`)); }, timeoutMs);
    function finish(error, value) { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolveProbe(value); }
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", finish);
    child.once("close", code => {
      if (code !== 0) return finish(new Error(`MCP server exited ${code}: ${stderr.trim()}`));
      try { finish(null, stdout.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)); }
      catch (error) { finish(new Error(`MCP probe returned invalid JSON: ${error.message}`)); }
    });
    child.stdin.end(`${messages.map(JSON.stringify).join("\n")}\n`);
  });
}
