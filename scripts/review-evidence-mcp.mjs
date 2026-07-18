#!/usr/bin/env node

import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { collectReviewContext } from "./lib/git.mjs";
import { consumeEvidence, createEvidenceLease, denyEvidence } from "./lib/review-evidence-lease.mjs";
import {
  MAX_REVIEW_CONTEXT_RESULTS,
  MAX_REVIEW_EVIDENCE_BYTES,
  MAX_REVIEW_FILES_PER_CALL,
  REVIEW_EVIDENCE_SERVER_NAME,
  REVIEW_EVIDENCE_TOOL_NAMES,
} from "./lib/review-evidence-contract.mjs";

class EvidencePolicyError extends Error {
  constructor(code) {
    super(code);
    this.name = "EvidencePolicyError";
    this.code = code;
  }
}

const root = await requiredRealpath("REVIEW_ROOT");
const statePath = requiredAbsolutePath("REVIEW_LEASE_STATE_PATH");
const leaseUnits = positiveInteger(process.env.REVIEW_LEASE_UNITS, "REVIEW_LEASE_UNITS");
const base = process.env.REVIEW_BASE || null;
const decoder = new TextDecoder("utf-8", { fatal: true });
let lease = createEvidenceLease(leaseUnits);
let revision = 0;

await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
await chmod(dirname(statePath), 0o700);
await publishState();

const tools = [
  tool("review_diff", "Return a bounded repository diff and changed-file manifest", {
    base: { type: "string", minLength: 1, maxLength: 200 },
  }),
  tool("review_file", "Read up to five explicit regular files confined to the review workspace", {
    paths: { type: "array", minItems: 1, maxItems: MAX_REVIEW_FILES_PER_CALL, items: { type: "string", minLength: 1, maxLength: 1024 } },
  }, ["paths"]),
  tool("review_context", "Find bounded literal references, callers, and tests inside the review workspace", {
    query: { type: "string", minLength: 1, maxLength: 200 },
    paths: { type: "array", maxItems: MAX_REVIEW_FILES_PER_CALL, items: { type: "string", minLength: 1, maxLength: 1024 } },
    max_results: { type: "integer", minimum: 1, maximum: MAX_REVIEW_CONTEXT_RESULTS },
  }, ["query"]),
];

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  let request;
  try { request = JSON.parse(line); }
  catch { sendError(null, -32700, "Invalid JSON"); continue; }
  if (request.method === "notifications/initialized") continue;
  try {
    if (request.method === "initialize") {
      sendResult(request.id, {
        protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: REVIEW_EVIDENCE_SERVER_NAME, version: "1.0.0" },
        instructions: "Evidence is read-only and lease bounded. When phase becomes finalizing, synthesize the final review without requesting more evidence.",
      });
    } else if (request.method === "ping") sendResult(request.id, {});
    else if (request.method === "tools/list") sendResult(request.id, { tools });
    else if (request.method === "tools/call") await callTool(request);
    else sendError(request.id, -32601, `Method not found: ${request.method}`);
  } catch (error) {
    sendError(request.id, error instanceof EvidencePolicyError ? -32602 : -32603, error.message);
  }
}

async function callTool(request) {
  const definition = tools.find(candidate => candidate.name === request.params?.name);
  if (!definition) return sendError(request.id, -32602, `Unknown tool: ${request.params?.name ?? ""}`);
  const argumentsValue = request.params?.arguments ?? {};
  try { validate(argumentsValue, definition.inputSchema); }
  catch (error) { return sendError(request.id, -32602, error.message); }

  if (lease.exhausted) {
    lease = denyEvidence(lease).lease;
    await publishState();
    return sendEvidenceResult(request.id, denial("evidence_lease_exhausted"));
  }

  try {
    const evidence = definition.name === "review_diff"
      ? await reviewDiff(argumentsValue)
      : definition.name === "review_file"
        ? await reviewFiles(argumentsValue)
        : await reviewContext(argumentsValue);
    const transition = consumeEvidence(lease, evidence.metrics);
    lease = transition.lease;
    await publishState();
    if (!transition.allowed) return sendEvidenceResult(request.id, denial(transition.reason));
    return sendEvidenceResult(request.id, { ok: true, evidence: evidence.value, evidenceLease: publicLease() });
  } catch (error) {
    if (!(error instanceof EvidencePolicyError)) throw error;
    const transition = denyEvidence(lease);
    lease = transition.lease;
    await publishState();
    return sendEvidenceResult(request.id, denial(error.code));
  }
}

async function reviewDiff({ base: requestedBase } = {}) {
  const context = await collectReviewContext({ cwd: root, base: requestedBase ?? base });
  const diff = boundedText(context.diff, 48 * 1024);
  const files = boundedPaths(context.files, { maxCount: 200, maxBytes: 8 * 1024 });
  const value = {
    range: context.range,
    diff: diff.text,
    files: files.values,
    filesOmitted: context.files.length - files.values.length,
    truncated: diff.truncated || files.truncated,
    fingerprint: context.fingerprint,
  };
  return {
    value,
    metrics: {
      kind: "diff",
      returnedBytes: Buffer.byteLength(JSON.stringify(value)),
      filesExamined: files.values,
      filesSkipped: boundedPaths(context.files.slice(files.values.length), { maxCount: 200, maxBytes: 8 * 1024 }).values,
    },
  };
}

async function reviewFiles({ paths }) {
  const values = [];
  let remaining = 56 * 1024;
  for (const requested of paths) {
    const confined = await confinedRegularFile(requested);
    const bytes = await readConfinedRegularFile(confined);
    if (bytes.includes(0)) throw new EvidencePolicyError("binary_file_rejected");
    let content;
    try { content = decoder.decode(bytes); }
    catch { throw new EvidencePolicyError("invalid_utf8_rejected"); }
    const bounded = boundedText(content, remaining);
    values.push({ path: confined.relative, content: bounded.text, truncated: bounded.truncated });
    remaining -= Buffer.byteLength(bounded.text);
    if (remaining <= 0) break;
  }
  const value = { files: values, truncated: values.length < paths.length || values.some(value => value.truncated) };
  return {
    value,
    metrics: { kind: "file", returnedBytes: Buffer.byteLength(JSON.stringify(value)), filesExamined: values.map(value => value.path), filesSkipped: paths.slice(values.length) },
  };
}

async function reviewContext({ query, paths = [], max_results: requestedMaxResults }) {
  const maxResults = requestedMaxResults ?? MAX_REVIEW_CONTEXT_RESULTS;
  const candidates = paths.length
    ? await Promise.all(paths.map(path => confinedRegularFile(path)))
    : await repositoryFiles(root);
  const matches = [];
  const examined = [];
  const skipped = [];
  let returnedBytes = 0;
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    if (matches.length >= maxResults || returnedBytes >= MAX_REVIEW_EVIDENCE_BYTES) {
      for (const candidate of candidates.slice(candidateIndex)) {
        if (skipped.length >= 200) break;
        skipped.push(candidate.relative);
      }
      break;
    }
    const candidate = candidates[candidateIndex];
    let bytes;
    try { bytes = await readConfinedRegularFile(candidate); }
    catch { if (skipped.length < 200) skipped.push(candidate.relative); continue; }
    if (bytes.length > 512 * 1024 || bytes.includes(0)) { if (skipped.length < 200) skipped.push(candidate.relative); continue; }
    let content;
    try { content = decoder.decode(bytes); }
    catch { if (skipped.length < 200) skipped.push(candidate.relative); continue; }
    if (examined.length < 200) examined.push(candidate.relative);
    const linesValue = content.split(/\r?\n/);
    for (let index = 0; index < linesValue.length && matches.length < maxResults; index += 1) {
      if (!linesValue[index].includes(query)) continue;
      const text = linesValue[index].slice(0, 400);
      const size = Buffer.byteLength(text);
      if (returnedBytes + size > MAX_REVIEW_EVIDENCE_BYTES) break;
      matches.push({ path: candidate.relative, line: index + 1, text });
      returnedBytes += size;
    }
  }
  const value = { query, matches, truncated: matches.length === maxResults || returnedBytes >= MAX_REVIEW_EVIDENCE_BYTES };
  return { value, metrics: { kind: "context", returnedBytes: Buffer.byteLength(JSON.stringify(value)), filesExamined: examined, filesSkipped: skipped } };
}

async function confinedRegularFile(requested) {
  if (typeof requested !== "string" || !requested.trim() || isAbsolute(requested) || requested.includes("\0")) {
    throw new EvidencePolicyError("invalid_review_path");
  }
  const candidate = resolve(root, requested);
  let linkMetadata;
  try { linkMetadata = await lstat(candidate); }
  catch { throw new EvidencePolicyError("review_path_not_found"); }
  if (linkMetadata.isSymbolicLink()) throw new EvidencePolicyError("review_symlink_rejected");
  let actual;
  try { actual = await realpath(candidate); }
  catch { throw new EvidencePolicyError("review_path_not_found"); }
  if (!isContained(root, actual)) throw new EvidencePolicyError("review_path_outside_workspace");
  const metadata = await stat(actual);
  if (!metadata.isFile()) throw new EvidencePolicyError("review_path_not_regular_file");
  return { absolute: actual, relative: relative(root, actual).split(sep).join("/") };
}

async function readConfinedRegularFile(confined) {
  let handle;
  try {
    handle = await open(confined.absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile()) throw new EvidencePolicyError("review_path_not_regular_file");
    const currentPath = await realpath(confined.absolute);
    if (!isContained(root, currentPath)) throw new EvidencePolicyError("review_path_outside_workspace");
    const current = await stat(currentPath);
    if (opened.dev !== current.dev || opened.ino !== current.ino) throw new EvidencePolicyError("review_path_changed_during_read");
    return await handle.readFile();
  } catch (error) {
    if (error instanceof EvidencePolicyError) throw error;
    if (["ELOOP", "ENOENT", "ENOTDIR"].includes(error.code)) throw new EvidencePolicyError("review_path_changed_during_read");
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function repositoryFiles(start) {
  const results = [];
  const pending = [start];
  while (pending.length && results.length < 2_000) {
    const directory = pending.pop();
    for await (const entry of await opendir(directory)) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".taskloop") continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) results.push({ absolute, relative: relative(root, absolute).split(sep).join("/") });
      if (results.length >= 2_000) break;
    }
  }
  return results.sort((left, right) => left.relative.localeCompare(right.relative));
}

async function publishState() {
  revision += 1;
  const state = {
    revision,
    serverPid: process.pid,
    serverPpid: process.ppid,
    phase: lease.phase,
    updatedAt: new Date().toISOString(),
    limitUnits: lease.limitUnits,
    usedUnits: lease.usedUnits,
    remainingUnits: lease.remainingUnits,
    exhausted: lease.exhausted,
    allowedCalls: lease.allowedCalls,
    deniedCalls: lease.deniedCalls,
    bytesReturned: lease.bytesReturned,
    filesExamined: lease.filesExamined,
    filesSkipped: lease.filesSkipped,
  };
  const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, statePath);
  await chmod(statePath, 0o600);
}

function publicLease() {
  return {
    limitUnits: lease.limitUnits,
    usedUnits: lease.usedUnits,
    remainingUnits: lease.remainingUnits,
    exhausted: lease.exhausted,
    phase: lease.phase,
    instruction: lease.instruction,
    allowedCalls: lease.allowedCalls,
    deniedCalls: lease.deniedCalls,
  };
}

function denial(reason) {
  return { ok: false, denied: true, reason, evidence: null, evidenceLease: publicLease() };
}

function sendEvidenceResult(id, payload) {
  sendResult(id, { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload });
}

function boundedText(value, maximumBytes) {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximumBytes) return { text: value, truncated: false };
  let text = bytes.subarray(0, maximumBytes).toString("utf8");
  if (text.endsWith("�")) text = text.slice(0, -1);
  while (Buffer.byteLength(text) > maximumBytes) text = text.slice(0, -1);
  return { text, truncated: true };
}

function boundedPaths(paths, { maxCount, maxBytes }) {
  const values = [];
  let bytes = 0;
  for (const path of paths) {
    const size = Buffer.byteLength(path);
    if (values.length >= maxCount || bytes + size > maxBytes) break;
    values.push(path);
    bytes += size;
  }
  return { values, truncated: values.length < paths.length };
}

function isContained(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function validate(value, schema, path = "arguments") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  for (const key of schema.required ?? []) if (!(key in value)) throw new Error(`${path}.${key} is required`);
  for (const key of Object.keys(value)) if (!(key in schema.properties)) throw new Error(`Unknown argument: ${key}`);
  for (const [key, child] of Object.entries(schema.properties)) if (key in value) validateValue(value[key], child, `${path}.${key}`);
}

function validateValue(value, schema, path) {
  if (schema.type === "string" && (typeof value !== "string" || (schema.minLength && !value.trim()) || value.length > (schema.maxLength ?? Infinity))) throw new Error(`${path} is invalid`);
  if (schema.type === "integer" && (!Number.isInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) throw new Error(`${path} is invalid`);
  if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) throw new Error(`${path} is invalid`);
    value.forEach((item, index) => validateValue(item, schema.items, `${path}[${index}]`));
  }
}

function tool(name, description, properties, required = []) {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}

async function requiredRealpath(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return realpath(value);
}

function requiredAbsolutePath(name) {
  const value = process.env[name];
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function sendResult(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`); }
function sendError(id, code, message) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`); }
