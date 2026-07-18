#!/usr/bin/env node

import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import {
  MAX_TASK_RECEIPT_ITEMS,
  MAX_TASK_RECEIPT_ITEM_TEXT,
  MAX_TASK_RECEIPT_TEXT,
  TASK_EXECUTION_SERVER_NAME,
  TASK_EXECUTION_TOOL_NAMES,
} from "./lib/task-execution-contract.mjs";

const statePath = requiredAbsolutePath("TASK_EXECUTION_STATE_PATH");
let revision = 0;
let phase = "working";
let checkpoint = null;
let completion = null;
let checkpointCalls = 0;
let completionCalls = 0;

await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
await chmod(dirname(statePath), 0o700);
await publishState();

const tools = [
  tool("task_checkpoint", "Persist bounded completed and remaining task work before a hard breaker", checkpointProperties(), ["summary", "completed_steps", "remaining_steps", "verification", "uncertainty"]),
  tool("task_complete", "Declare the delegated task complete with bounded verification evidence", {
    summary: text(), verification: list(), remaining_gaps: list({ maxItems: 0 }),
  }, ["summary", "verification", "remaining_gaps"]),
];

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  let request;
  try { request = JSON.parse(line); }
  catch { sendError(null, -32700, "Invalid JSON"); continue; }
  if (request.method === "notifications/initialized") continue;
  try {
    if (request.method === "initialize") sendResult(request.id, { protocolVersion: request.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: TASK_EXECUTION_SERVER_NAME, version: "1.0.0" }, instructions: "Publish a checkpoint before completion reserve. Publish task_complete only when all required work and verification are complete." });
    else if (request.method === "ping") sendResult(request.id, {});
    else if (request.method === "tools/list") sendResult(request.id, { tools });
    else if (request.method === "tools/call") await callTool(request);
    else sendError(request.id, -32601, `Method not found: ${request.method}`);
  } catch (error) { sendError(request.id, -32602, error.message); }
}

async function callTool(request) {
  const definition = tools.find(candidate => candidate.name === request.params?.name);
  if (!definition) return sendError(request.id, -32602, `Unknown tool: ${request.params?.name ?? ""}`);
  const argumentsValue = request.params?.arguments ?? {};
  validate(argumentsValue, definition.inputSchema);
  if (definition.name === "task_checkpoint") {
    if (phase === "completed") throw new Error("Completed task execution cannot be checkpointed");
    checkpoint = receipt(argumentsValue);
    checkpointCalls += 1;
    phase = "checkpointed";
  } else {
    completion = receipt(argumentsValue);
    completionCalls += 1;
    phase = "completed";
  }
  await publishState();
  sendResult(request.id, { content: [{ type: "text", text: JSON.stringify(publicState()) }], structuredContent: publicState() });
}

async function publishState() {
  revision += 1;
  const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ revision, serverPid: process.pid, serverPpid: process.ppid, updatedAt: new Date().toISOString(), ...publicState() })}\n`, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, statePath);
  await chmod(statePath, 0o600);
}

function publicState() { return { phase, checkpoint, completion, checkpointCalls, completionCalls }; }
function receipt(value) { return JSON.parse(JSON.stringify(value)); }
function checkpointProperties() { return { summary: text(), completed_steps: list(), remaining_steps: list({ minItems: 1 }), verification: list(), uncertainty: { type: "string", enum: ["low", "medium", "high"] } }; }
function text() { return { type: "string", minLength: 1, maxLength: MAX_TASK_RECEIPT_TEXT }; }
function list(options = {}) { return { type: "array", minItems: options.minItems ?? 0, maxItems: options.maxItems ?? MAX_TASK_RECEIPT_ITEMS, items: { type: "string", minLength: 1, maxLength: MAX_TASK_RECEIPT_ITEM_TEXT } }; }
function tool(name, description, properties, required) { return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } }; }
function validate(value, schema, path = "arguments") { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`); for (const key of schema.required ?? []) if (!(key in value)) throw new Error(`${path}.${key} is required`); for (const key of Object.keys(value)) if (!(key in schema.properties)) throw new Error(`Unknown argument: ${key}`); for (const [key, child] of Object.entries(schema.properties)) if (key in value) validateValue(value[key], child, `${path}.${key}`); }
function validateValue(value, schema, path) { if (schema.type === "string" && (typeof value !== "string" || (schema.minLength && !value.trim()) || value.length > (schema.maxLength ?? Infinity))) throw new Error(`${path} is invalid`); if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} is invalid`); if (schema.type === "array") { if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) throw new Error(`${path} is invalid`); value.forEach((item, index) => validateValue(item, schema.items, `${path}[${index}]`)); } }
function requiredAbsolutePath(name) { const value = process.env[name]; if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`); return value; }
function sendResult(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`); }
function sendError(id, code, message) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`); }
