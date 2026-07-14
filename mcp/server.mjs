#!/usr/bin/env node
import readline from "node:readline";
import { readFile } from "node:fs/promises";
import { applyWriteResult, cancelJob, discardWriteResult, getJobResult, getJobStatus, reviewChanges, reviewPlan, runReadonlyTask, startIsolatedWrite } from "../scripts/lib/service.mjs";
import { renderError, renderJob, renderResult } from "../scripts/lib/render.mjs";

const SERVER_VERSION = JSON.parse(await readFile(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8")).version;
const commonRuntime = {
  model: { type: "string", minLength: 1 }, effort: { type: "string", enum: ["low", "medium", "high"] }, background: { type: "boolean" }, max_turns: { type: "integer", minimum: 1 }, finalize_at_turn: { type: "integer", minimum: 1 }, max_budget_usd: { type: "number", exclusiveMinimum: 0 }, timeout_ms: { type: "integer", minimum: 1 }
};
const tools = [
  tool("claude_review_changes", "Review repository changes read-only with Claude Code", { workspace_root: string(), base: string(), review_profile: profile(), ...commonRuntime }, ["workspace_root"]),
  tool("claude_review_plan", "Review one repository plan file read-only with Claude Code", { workspace_root: string(), target_file: string(), review_profile: profile(), ...commonRuntime }, ["workspace_root", "target_file"]),
  tool("claude_task_readonly", "Run a read-only project task with Claude Code", { workspace_root: string(), task: string(), context: { type: "string", enum: ["summary", "diff", "full"] }, task_profile: profile(), ...commonRuntime }, ["workspace_root", "task"]),
  tool("claude_write_task_start", "Start a sandboxed write task in an isolated clone; never applies automatically", { workspace_root: string(), task: string(), context: { type: "string", enum: ["summary", "diff", "full"] }, task_profile: profile(), ...commonRuntime }, ["workspace_root", "task"]),
  tool("claude_write_task_apply", "Apply a completed isolated write artifact to its source workspace", { workspace_root: string(), job_id: string(), allow_context_drift: { type: "boolean" }, expected_patch_hash: string() }, ["workspace_root", "job_id"]),
  tool("claude_write_task_discard", "Discard an isolated write artifact and clean its workspace", { workspace_root: string(), job_id: string() }, ["workspace_root", "job_id"]),
  tool("claude_job_status", "Read a Claude job status", { workspace_root: string(), job_id: string() }, ["workspace_root", "job_id"]),
  tool("claude_job_result", "Read a completed Claude job result", { workspace_root: string(), job_id: string() }, ["workspace_root", "job_id"]),
  tool("claude_job_cancel", "Cancel a running Claude job", { workspace_root: string(), job_id: string() }, ["workspace_root", "job_id"])
];

const handlers = {
  claude_review_changes: reviewChanges,
  claude_review_plan: reviewPlan,
  claude_task_readonly: runReadonlyTask,
  claude_write_task_start: startIsolatedWrite,
  claude_write_task_apply: applyWriteResult,
  claude_write_task_discard: discardWriteResult,
  claude_job_status: getJobStatus,
  claude_job_result: getJobResult,
  claude_job_cancel: cancelJob
};

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  let request;
  try { request = JSON.parse(line); }
  catch { sendError(null, -32700, "Invalid JSON"); continue; }
  if (request.method === "notifications/initialized") continue;
  try {
    if (request.method === "initialize") sendResult(request.id, { protocolVersion: request.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cc-plugin-codex", version: SERVER_VERSION }, instructions: "Use read-only tools unless the user explicitly authorizes isolated writes." });
    else if (request.method === "ping") sendResult(request.id, {});
    else if (request.method === "tools/list") sendResult(request.id, { tools });
    else if (request.method === "tools/call") await callTool(request);
    else sendError(request.id, -32601, `Method not found: ${request.method}`);
  } catch (error) { sendError(request.id, -32603, error.message, JSON.parse(renderError(error, { json: true }))); }
}

async function callTool(request) {
  const definition = tools.find(candidate => candidate.name === request.params?.name);
  if (!definition) return sendError(request.id, -32602, `Unknown tool: ${request.params?.name ?? ""}`);
  try { validate(request.params?.arguments ?? {}, definition.inputSchema); }
  catch (error) { return sendError(request.id, -32602, error.message); }
  const outcome = await handlers[definition.name]({ ...toServiceRequest(request.params.arguments), transport: "mcp" });
  const payload = structuredPayload(outcome);
  sendResult(request.id, { content: [{ type: "text", text: summary(definition.name, payload) }], structuredContent: payload });
}

function validate(value, schema, path = "arguments") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  for (const key of schema.required ?? []) if (!(key in value)) throw new Error(`${path}.${key} is required`);
  if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!(key in schema.properties)) throw new Error(`Unknown argument: ${key}`);
  for (const [key, child] of Object.entries(schema.properties)) if (key in value) validateValue(value[key], child, `${path}.${key}`);
}
function validateValue(value, schema, path) { if (schema.type === "string" && (typeof value !== "string" || (schema.minLength && !value.trim()))) throw new Error(`${path} must be a non-empty string`); if (schema.type === "boolean" && typeof value !== "boolean") throw new Error(`${path} must be a boolean`); if (schema.type === "integer" && (!Number.isInteger(value) || value < (schema.minimum ?? -Infinity))) throw new Error(`${path} must be an integer >= ${schema.minimum}`); if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value) || value <= (schema.exclusiveMinimum ?? -Infinity))) throw new Error(`${path} must be a positive number`); if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} must be one of: ${schema.enum.join(", ")}`); }
function toServiceRequest(argumentsValue) { return Object.fromEntries(Object.entries(argumentsValue).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value])); }
function tool(name, description, properties, required) { return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } }; }
function string() { return { type: "string", minLength: 1 }; }
function profile() { return { type: "string", enum: ["quick", "standard", "deep"] }; }
function summary(name, payload) { return `${name}: ${payload.status ?? (payload.ok === false ? "failed" : "completed")}${payload.id ? ` (${payload.id})` : ""}`; }
function structuredPayload(outcome) {
  if (outcome.kind === "job") return JSON.parse(renderJob(outcome.job, { json: true })).job;
  const metadata = outcome.metadata ?? {};
  return JSON.parse(renderResult(outcome.result, { ...(outcome.options ?? {}), json: true, operation: metadata.operation, "review-kind": metadata.reviewKind, "subject-kind": metadata.subjectKind, "subject-label": metadata.subjectLabel, "subject-fingerprint": metadata.subjectFingerprint }));
}
function sendResult(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`); }
function sendError(id, code, message, data) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } })}\n`); }
