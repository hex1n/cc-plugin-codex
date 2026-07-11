import { runCommand } from "./process.mjs";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createJob, jobArtifacts, saveJob, writeJobRequest } from "./state.mjs";
import { terminateProcessTree } from "./process.mjs";
import { spawnDetachedSilent } from "./process.mjs";
import { fileURLToPath } from "node:url";
// Flags/JSON verified 2026-07-11 against Claude Code 2.1.207.
export const CLAUDE_CLI = Object.freeze({ executable: process.env.CLAUDE_CODE_EXECUTABLE ?? "claude", baseArgs: ["--print", "--output-format", "json"], profiles: Object.freeze({ review: ["--safe-mode", "--permission-mode", "plan", "--allowedTools", "Read,Grep,Glob,Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(git show:*)"], task: ["--permission-mode", "plan"] }) });
export function parseClaudeJson(stdout, { schemaPath = null } = {}) {
  let payload;
  for (const line of stdout.split(/\r?\n/).filter(Boolean).reverse()) { try { payload = JSON.parse(line); break; } catch {} }
  if (!payload) throw new Error("Claude returned no valid JSON payload");
  if (payload.is_error === true) throw new Error(`Claude error (${payload.subtype ?? "unknown"}): ${payload.result ?? "No error details returned"}`);
  const structuredOutput = payload.structured_output ?? null;
  const result = payload.result ?? structuredOutput ?? payload.message?.content?.map?.(part => part.text ?? "").join("") ?? payload.content;
  if (schemaPath) {
    if (structuredOutput === null) throw new Error("Claude returned no structured output for the requested schema");
    validateSchema(structuredOutput, JSON.parse(readFileSync(schemaPath, "utf8")), "$output");
  }
  return {
    text: typeof result === "string" ? result : JSON.stringify(result ?? payload),
    structuredOutput,
    sessionId: payload.session_id ?? payload.sessionId ?? null,
    usage: payload.usage ?? null,
    modelUsage: payload.modelUsage ?? payload.model_usage ?? null,
    totalCostUsd: payload.total_cost_usd ?? payload.totalCostUsd ?? null,
    numTurns: payload.num_turns ?? payload.numTurns ?? null,
    durationMs: payload.duration_ms ?? payload.durationMs ?? null,
    durationApiMs: payload.duration_api_ms ?? payload.durationApiMs ?? null,
    raw: payload
  };
}
export function claudeArgs(profile, prompt, { resume, continueSession, write, model, maxTurns, maxBudgetUsd, schemaPath, stream = false } = {}) {
  if (!CLAUDE_CLI.profiles[profile]) throw new Error(`Unknown Claude capability profile: ${profile}`);
  const profileArgs = profile === "task" && write ? ["--permission-mode", "acceptEdits"] : CLAUDE_CLI.profiles[profile];
  const session = resume ? ["--resume", resume] : continueSession ? ["--continue"] : [];
  const runtime = [...(model ? ["--model", model] : []), ...(maxTurns ? ["--max-turns", String(maxTurns)] : []), ...(maxBudgetUsd ? ["--max-budget-usd", String(maxBudgetUsd)] : [])];
  const schema = schemaPath ? ["--json-schema", schemaForClaudeCli(schemaPath)] : [];
  const baseArgs = stream ? ["--print", "--output-format", "stream-json", "--verbose"] : CLAUDE_CLI.baseArgs;
  return [...baseArgs, ...profileArgs, ...session, ...runtime, ...schema, "--", prompt];
}
export async function runClaude({ profile, prompt, cwd, timeoutMs, resume, continueSession, write, model, maxTurns, maxBudgetUsd, schemaPath }) {
  const result = await runCommand(CLAUDE_CLI.executable, claudeArgs(profile, prompt, { resume, continueSession, write, model, maxTurns, maxBudgetUsd, schemaPath }), { cwd, timeoutMs });
  if (result.timedOut) throw new Error(`Claude timed out after ${timeoutMs}ms`);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Claude exited with code ${result.code}`);
  return { ...parseClaudeJson(result.stdout, { schemaPath }), pid: result.pid };
}
export async function startClaudeJob({ profile, prompt, cwd, resume, continueSession, write, model, maxTurns, maxBudgetUsd, schemaPath, promptMeta, backgroundTimeoutMs, purpose = "user", disclosure = null }) {
  const job = await createJob({ cwd, profile, resumeSessionId: resume ?? null, promptMeta, write, model, purpose, disclosure });
  let workerPid = null;
  try {
    const timeoutMs = positiveTimeout(backgroundTimeoutMs ?? process.env.CLAUDE_COMPANION_BACKGROUND_TIMEOUT_MS, 3_600_000);
    await writeJobRequest(job, { profile, prompt, resume: resume ?? null, continueSession: Boolean(continueSession), write: Boolean(write), model: model ?? null, maxTurns: maxTurns ?? null, maxBudgetUsd: maxBudgetUsd ?? null, schemaPath: schemaPath ?? null, stream: true });
    const worker = fileURLToPath(new URL("../claude-job-worker.mjs", import.meta.url));
    ({ pid: workerPid } = await spawnDetachedSilent(process.execPath, [worker, cwd, job.id], { cwd, env: process.env }));
    const running = await saveJob({ ...job, pid: workerPid, workerPid, status: "running", timeoutMs, deadlineAt: new Date(Date.now() + timeoutMs).toISOString(), startedAt: new Date().toISOString() });
    const monitor = fileURLToPath(new URL("../claude-job-monitor.mjs", import.meta.url));
    await spawnDetachedSilent(process.execPath, [monitor, cwd, job.id, String(timeoutMs)], { cwd, env: process.env });
    return running;
  } catch (error) {
    if (workerPid) await terminateProcessTree(workerPid);
    await saveJob({ ...job, pid: workerPid, workerPid, status: "failed", error: error.message, finishedAt: new Date().toISOString() });
    throw error;
  }
}
function positiveTimeout(value, fallback) { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback; }
export async function readClaudeJobResult(job) {
  const artifacts = jobArtifacts(job.cwd, job.id), [stdout, stderr] = await Promise.all([readFile(artifacts.stdoutPath, "utf8"), readFile(artifacts.stderrPath, "utf8")]);
  try { return parseClaudeJson(stdout); } catch (error) { throw new Error(stderr.trim() || error.message); }
}

function validateSchema(value, schema, path) {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
    for (const key of schema.required ?? []) if (!(key in value)) throw new Error(`${path}.${key} is required`);
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!schema.properties?.[key]) throw new Error(`${path}.${key} is not allowed`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (key in value) validateSchema(value[key], child, `${path}.${key}`);
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    for (let index = 0; index < value.length; index += 1) validateSchema(value[index], schema.items, `${path}[${index}]`);
    return;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") throw new Error(`${path} must be a string`);
    if (schema.minLength && value.length < schema.minLength) throw new Error(`${path} must not be empty`);
  } else if (schema.type === "integer") {
    if (!Number.isInteger(value)) throw new Error(`${path} must be an integer`);
    if (schema.minimum != null && value < schema.minimum) throw new Error(`${path} is below the minimum`);
  } else if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a number`);
    if (schema.minimum != null && value < schema.minimum) throw new Error(`${path} is below the minimum`);
    if (schema.maximum != null && value > schema.maximum) throw new Error(`${path} is above the maximum`);
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} must be one of: ${schema.enum.join(", ")}`);
}

function schemaForClaudeCli(path) {
  const schema = JSON.parse(readFileSync(path, "utf8"));
  // Claude Code 2.1.x validates with a bundled dialect that rejects the
  // Draft 2020-12 meta-schema URI even though it accepts this schema's fields.
  delete schema.$schema;
  return JSON.stringify(schema);
}
