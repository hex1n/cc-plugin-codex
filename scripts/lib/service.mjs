import { readClaudeJobResult, REVIEW_DIFF_ADAPTER, runClaude, startClaudeJob } from "./claude.mjs";
import { loadRuntimeConfig } from "./config.mjs";
import { collectReviewContext, findWorkspaceRoot } from "./git.mjs";
import { reconcileJob } from "./job-lifecycle.mjs";
import { terminateProcessTree } from "./process.mjs";
import { readJob, STATE_ROOT, transitionJob } from "./state.mjs";
import { renderPrompt, schemaPath } from "./prompts.mjs";
import { collectPlanReviewTarget } from "./plan-review-target.mjs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { createIsolatedWriteWorkspace, removeIsolatedWriteWorkspace, WRITE_WORKSPACE_ROOT } from "./write-workspace.mjs";
import { createWriteSandboxSettings, writeSandboxPreflight } from "./sandbox-policy.mjs";
import { applyWriteArtifact, discardWriteArtifact } from "./patch-artifact.mjs";

const ACTIVE = new Set(["starting", "running", "queued"]);

export async function runReadonlyTask(request) {
  if ((request.resumeSessionId ?? request.resume) && request.continueSession) {
    throw Object.assign(new Error("Choose only one of resume_session_id or continue_session"), { rpcCode: -32602 });
  }
  const workspace = await findWorkspaceRoot(request.workspaceRoot), options = taskOptions(request), runtimeConfig = await loadRuntimeConfig({ cwd: workspace });
  applyTaskRuntime(options, runtimeConfig.task);
  const budgetGuidance = normalizeTaskBudget(options);
  const rendered = await renderPrompt("task-wrapper", { USER_TASK: `${request.task}${budgetGuidance}`, PERMISSION_MODE: "read-only (plan)" });
  options.disclosure = { destination: "Claude Code", context: request.context ?? "summary", source: request.source ?? request.transport ?? "service", bytes: Buffer.byteLength(request.task), mode: "read-only", repository_access: "enabled", task_profile: options["task-profile"], requested_model: options.model, effort: options.effort };
  const metadata = { operation: "task", reviewKind: null, subjectKind: null, subjectLabel: null, subjectFingerprint: null, transport: request.transport ?? null, capability: "read-only" };
  return executeOperation({ profile: "task", renderedPrompt: rendered, cwd: workspace, options, jobMetadata: metadata });
}

export async function reviewChanges(request) {
  const workspace = await findWorkspaceRoot(request.workspaceRoot), options = reviewOptions(request), runtimeConfig = await loadRuntimeConfig({ cwd: workspace });
  applyReviewRuntime(options, runtimeConfig.review);
  const context = await collectReviewContext({ cwd: workspace, base: options.base });
  const rendered = await renderPrompt("review", { TARGET_LABEL: context.range, REVIEW_COLLECTION_GUIDANCE: reviewCollectionGuidance(context), REVIEW_BUDGET_GUIDANCE: reviewBudgetGuidance(options), REVIEW_INPUT: `Repository: ${context.root}\n${context.diff}` });
  const metadata = { operation: "review", reviewKind: "code", subjectKind: "changes", subjectLabel: context.range, subjectFingerprint: context.fingerprint, transport: request.transport ?? null, capability: "read-only" };
  return executeOperation({ profile: "review", renderedPrompt: rendered, cwd: context.root, options, outputSchema: schemaPath("review-output"), jobMetadata: metadata });
}

export async function reviewChangesAdversarial(request) {
  const workspace = await findWorkspaceRoot(request.workspaceRoot), options = reviewOptions(request), runtimeConfig = await loadRuntimeConfig({ cwd: workspace });
  applyReviewRuntime(options, runtimeConfig.review);
  const context = await collectReviewContext({ cwd: workspace, base: options.base });
  const rendered = await renderPrompt("adversarial-review", { TARGET_LABEL: context.range, USER_FOCUS: request.focus?.trim() || "none", REVIEW_COLLECTION_GUIDANCE: reviewCollectionGuidance(context), REVIEW_BUDGET_GUIDANCE: reviewBudgetGuidance(options), REVIEW_INPUT: `Repository: ${context.root}\n${context.diff}` });
  const metadata = { operation: "review", reviewKind: "adversarial", subjectKind: "changes", subjectLabel: context.range, subjectFingerprint: context.fingerprint, transport: request.transport ?? null, capability: "read-only" };
  return executeOperation({ profile: "review", renderedPrompt: rendered, cwd: context.root, options, outputSchema: schemaPath("review-output"), jobMetadata: metadata });
}

export async function reviewPlan(request) {
  const workspace = await findWorkspaceRoot(request.workspaceRoot), options = reviewOptions(request), runtimeConfig = await loadRuntimeConfig({ cwd: workspace });
  applyReviewRuntime(options, runtimeConfig.review, { applyBase: false });
  const target = await collectPlanReviewTarget({ cwd: workspace, targetFile: request.targetFile });
  const metadata = { operation: "review", reviewKind: "plan", subjectKind: "file", subjectLabel: target.label, subjectFingerprint: target.fingerprint };
  const rendered = await renderPrompt("plan-review", { SUBJECT_LABEL: target.label, SUBJECT_FINGERPRINT: target.fingerprint, REVIEW_BUDGET_GUIDANCE: reviewBudgetGuidance(options), PLAN_CONTENT: target.content });
  const outcome = await executeOperation({ profile: "review", renderedPrompt: rendered, cwd: target.root, options, outputSchema: schemaPath("plan-review-output"), jobMetadata: metadata });
  return outcome;
}

export async function startIsolatedWrite(request) {
  const workspace = await findWorkspaceRoot(request.workspaceRoot), runtimeConfig = await loadRuntimeConfig({ cwd: workspace }), options = taskOptions({ ...request, background: true });
  applyTaskRuntime(options, runtimeConfig.task);
  const budgetGuidance = normalizeTaskBudget(options);
  options.write = true;
  options.backgroundTimeoutMs = runtimeConfig.jobs.backgroundTimeoutMs;
  const preflight = await writeSandboxPreflight(), workspaceId = randomUUID();
  let isolated, settingsPath;
  try {
    isolated = await createIsolatedWriteWorkspace({ sourceRoot: workspace, workspaceRoot: WRITE_WORKSPACE_ROOT, workspaceId });
    if (isolated.backend !== preflight.backend) throw new Error(`Authorized backend ${preflight.backend} does not match prepared backend ${isolated.backend}`);
    settingsPath = join(WRITE_WORKSPACE_ROOT, `${workspaceId}.settings.json`);
    const sandbox = await createWriteSandboxSettings({ settingsPath, sourceRoot: isolated.sourceRoot, isolatedRoot: isolated.isolatedRoot, artifactRoot: isolated.artifactRoot, stateRoot: STATE_ROOT });
    const rendered = await renderPrompt("task-wrapper", { USER_TASK: `${request.task}${budgetGuidance}`, PERMISSION_MODE: "isolated write-capable (acceptEdits); never access the source workspace" });
    options.disclosure = { destination: "Claude Code", context: request.context ?? "summary", source: request.transport ?? "service", bytes: Buffer.byteLength(request.task), mode: "isolated-write", repository_access: "isolated-clone", task_profile: options["task-profile"], requested_model: options.model, effort: options.effort };
    const metadata = { operation: "task", transport: request.transport ?? null, capability: "isolated-write", sourceRoot: isolated.sourceRoot, isolatedRoot: isolated.isolatedRoot, artifactRoot: isolated.artifactRoot, workspaceBackend: isolated.backend, sourceHead: isolated.sourceHead, sourceStatus: isolated.sourceStatus, baselineCommit: isolated.baselineCommit, baselineFingerprint: isolated.baselineFingerprint, baselineRecords: isolated.baselineRecords, settingsPath, sandboxRequired: true, sandboxVerified: false, sandboxPolicyHash: sandbox.policyHash, sandboxPolicyVersion: sandbox.policyVersion, claudeVersion: preflight.claudeVersion, claudeExecutableSha256: preflight.executableSha256, artifactStatus: "running" };
    const outcome = await executeOperation({ profile: "task", renderedPrompt: rendered, cwd: isolated.sourceRoot, options, jobMetadata: metadata, execution: { executionCwd: isolated.isolatedRoot, settingsPath, settingSources: "", claudeExecutable: preflight.claudeExecutable, finalizeWrite: true } });
    return outcome;
  } catch (error) {
    if (isolated) await removeIsolatedWriteWorkspace(isolated).catch(() => {});
    if (settingsPath) await rm(settingsPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function applyWriteResult(request) {
  if (request.allowContextDrift && !request.expectedPatchHash) throw Object.assign(new Error("allow_context_drift requires expected_patch_hash"), { errorKind: "patch_hash_required" });
  const workspace = await findWorkspaceRoot(request.workspaceRoot), job = await applyWriteArtifact({ workspaceRoot: workspace, jobId: request.jobId, allowContextDrift: Boolean(request.allowContextDrift), expectedPatchHash: request.expectedPatchHash ?? null });
  return { kind: "job", job };
}

export async function discardWriteResult(request) {
  const workspace = await findWorkspaceRoot(request.workspaceRoot), job = await discardWriteArtifact({ workspaceRoot: workspace, jobId: request.jobId });
  return { kind: "job", job };
}

export async function executeOperation({ profile, renderedPrompt, cwd, options, outputSchema = null, jobMetadata = {}, execution = {} }) {
  const prompt = typeof renderedPrompt === "string" ? renderedPrompt : renderedPrompt.text, promptMeta = typeof renderedPrompt === "string" ? null : renderedPrompt;
  const runtime = { resume: options.resume, continueSession: options.continue, write: options.write, model: options.model, effort: options.effort, maxTurns: options["max-turns"], finalizeAtTurn: options["finalize-at-turn"], maxBudgetUsd: options["max-budget-usd"], taskProfile: options["task-profile"], reviewProfile: options["review-profile"], timeoutMs: options["timeout-ms"], backgroundTimeoutMs: options.backgroundTimeoutMs };
  if (options.background) {
    const job = await startClaudeJob({ profile, prompt, cwd, ...runtime, ...execution, schemaPath: outputSchema, promptMeta, purpose: options.purpose ?? "user", disclosure: options.disclosure ?? null, metadata: jobMetadata });
    return { kind: "job", job, options, metadata: jobMetadata };
  }
  let result;
  try { result = await runClaude({ profile, prompt, cwd, ...runtime, schemaPath: outputSchema }); }
  catch (error) { Object.assign(error, { operation: jobMetadata.operation ?? null, reviewKind: jobMetadata.reviewKind ?? null, subjectKind: jobMetadata.subjectKind ?? null, subjectLabel: jobMetadata.subjectLabel ?? null, subjectFingerprint: jobMetadata.subjectFingerprint ?? null }); throw error; }
  return { kind: "result", result, options, metadata: jobMetadata };
}

export async function getJobStatus({ workspaceRoot, jobId }) {
  const workspace = await findWorkspaceRoot(workspaceRoot), job = await reconcileJob(await readJob(workspace, jobId));
  return { kind: "job", job };
}

export async function getJobResult({ workspaceRoot, jobId }) {
  const workspace = await findWorkspaceRoot(workspaceRoot), job = await reconcileJob(await readJob(workspace, jobId));
  if (ACTIVE.has(job.status)) throw new Error(`Job ${job.id} is still ${job.status}`);
  if (job.status === "cancelled") throw new Error(`Job ${job.id} was cancelled`);
  if (job.status === "timed_out") throw new Error(`Job ${job.id} exceeded its ${job.timeoutMs}ms wall-clock timeout`);
  if (job.status !== "completed") throw jobFailure(job);
  const result = await readClaudeJobResult(job), options = { json: true, "task-profile": job.taskProfile, "review-profile": job.reviewProfile, model: job.requestedModel ?? job.model, effort: job.effort, "parent-job-id": job.parentJobId, "cumulative-chain-cost-usd": job.cumulativeChainCostUsd, "max-turns": job.maxTurns, "finalize-at-turn": job.finalizeAtTurn, "max-budget-usd": job.maxBudgetUsd, "timeout-ms": job.timeoutMs };
  return { kind: "result", result, job, options, metadata: jobMetadata(job) };
}

export async function cancelJob({ workspaceRoot, jobId }) {
  const workspace = await findWorkspaceRoot(workspaceRoot), job = await reconcileJob(await readJob(workspace, jobId));
  if (job.status !== "running") throw new Error(`Job ${job.id} is ${job.status}, not running`);
  const intent = await transitionJob(workspace, job.id, ["running"], current => ({ ...current, cancellationRequestedAt: new Date().toISOString() }));
  if (!intent.changed) throw new Error(`Job ${job.id} changed state before cancellation`);
  try { await terminateProcessTree(job.pid); }
  catch (error) {
    await transitionJob(workspace, job.id, ["running"], current => { const { cancellationRequestedAt, ...rest } = current; return { ...rest, cancellationError: error.message }; });
    throw error;
  }
  const transition = await transitionJob(workspace, job.id, ["running"], current => ({ ...current, status: "cancelled", phase: "cancelled", cancellationMode: "hard_process_tree", finishedAt: new Date().toISOString() }));
  return { kind: "job", job: transition.record };
}

export function applyTaskRuntime(options, taskConfig) {
  const profileName = options["task-profile"] ?? taskConfig.profile;
  if (!["quick", "standard", "deep"].includes(profileName)) throw new Error("task_profile must be quick, standard, or deep");
  const profile = taskConfig.profiles[profileName]; options["task-profile"] = profileName;
  options.model ??= taskConfig.model ?? profile.model; options.effort ??= taskConfig.effort ?? profile.effort;
  if (!["low", "medium", "high"].includes(options.effort)) throw new Error("effort must be low, medium, or high");
  options["max-turns"] ??= taskConfig.maxTurns ?? profile.maxTurns;
  if (options["finalize-at-turn"] == null) { const maxTurns = Number(options["max-turns"]), inherited = taskConfig.finalizeAtTurn ?? profile.finalizeAtTurn; options["finalize-at-turn"] = maxTurns > 1 ? Math.min(inherited, maxTurns - 1) : null; }
  options["max-budget-usd"] ??= taskConfig.maxBudgetUsd ?? profile.maxBudgetUsd; options["timeout-ms"] ??= taskConfig.timeoutMs ?? profile.timeoutMs;
}

export function applyReviewRuntime(options, reviewConfig, { applyBase = true } = {}) {
  const profileName = options["review-profile"] ?? reviewConfig.profile;
  if (!["quick", "standard", "deep"].includes(profileName)) throw new Error("review_profile must be quick, standard, or deep");
  const profile = reviewConfig.profiles[profileName]; options["review-profile"] = profileName;
  if (applyBase) options.base ??= reviewConfig.base;
  options.model ??= reviewConfig.model ?? profile.model; options.effort ??= profile.effort;
  if (!["low", "medium", "high"].includes(options.effort)) throw new Error("effort must be low, medium, or high");
  options["max-turns"] = positiveInteger(options["max-turns"] ?? profile.maxTurns, "max_turns");
  if (options["max-turns"] < 2) throw new Error("Review max_turns must be at least 2");
  options["finalize-at-turn"] = positiveInteger(options["finalize-at-turn"] ?? Math.min(profile.finalizeAtTurn, options["max-turns"] - 1), "finalize_at_turn");
  if (options["finalize-at-turn"] >= options["max-turns"]) throw new Error("finalize_at_turn must be lower than max_turns");
  options["max-budget-usd"] = positiveNumber(options["max-budget-usd"] ?? profile.maxBudgetUsd, "max_budget_usd"); options["timeout-ms"] = positiveNumber(options["timeout-ms"] ?? profile.timeoutMs, "timeout_ms");
}

function taskOptions(request) { return { json: true, background: Boolean(request.background), write: false, resume: request.resumeSessionId ?? request.resume ?? null, continue: Boolean(request.continueSession), model: request.model ?? null, effort: request.effort ?? null, "task-profile": request.taskProfile ?? null, "max-turns": request.maxTurns ?? null, "finalize-at-turn": request.finalizeAtTurn ?? null, "max-budget-usd": request.maxBudgetUsd ?? null, "timeout-ms": request.timeoutMs ?? null, backgroundTimeoutMs: request.backgroundTimeoutMs, purpose: request.purpose ?? "user" }; }
function reviewOptions(request) { return { json: true, background: Boolean(request.background), model: request.model ?? null, effort: request.effort ?? null, base: request.base ?? null, "review-profile": request.reviewProfile ?? null, "max-turns": request.maxTurns ?? null, "finalize-at-turn": request.finalizeAtTurn ?? null, "max-budget-usd": request.maxBudgetUsd ?? null, "timeout-ms": request.timeoutMs ?? null, purpose: "user" }; }
function reviewBudgetGuidance(options) { return `Review profile: ${options["review-profile"]}. Maximum turns: ${options["max-turns"]}. Maximum budget: $${options["max-budget-usd"]}. Beginning with turn ${options["finalize-at-turn"]}, stop expanding the investigation. Use remaining turns to verify findings, enumerate examined and skipped files, state uncertainty and budget exhaustion, and recommend only a focused deeper follow-up when warranted.`; }
function reviewCollectionGuidance(context) { return context.inline ? "Inspect the supplied diff. Use repository tools only for focused caller or invariant tracing." : `Use the bounded read-only adapter for patch content: node ${JSON.stringify(REVIEW_DIFF_ADAPTER)} --base ${JSON.stringify(context.adapterBase)} --file <repo-relative-path> [--file <path> ...] --max-bytes 65536. Use at most five files per call. The process already runs at the repository root. Run exactly one command per Bash tool call; do not use git -C, pipes, redirects, command separators, echo, tail, or shell composition. Use Read, Grep, or Glob for focused follow-up.`; }
function positiveInteger(value, name) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} requires a positive integer`); return parsed; }
function positiveNumber(value, name) { const parsed = Number(value); if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} requires a positive number`); return parsed; }
function normalizeTaskBudget(options) { const maxTurns = positiveInteger(options["max-turns"], "max_turns"), finalizeAtTurn = options["finalize-at-turn"] == null ? null : positiveInteger(options["finalize-at-turn"], "finalize_at_turn"); if (finalizeAtTurn && finalizeAtTurn >= maxTurns) throw new Error("finalize_at_turn must be lower than max_turns"); options["max-turns"] = maxTurns; options["finalize-at-turn"] = finalizeAtTurn; options["max-budget-usd"] = positiveNumber(options["max-budget-usd"], "max_budget_usd"); return finalizeAtTurn ? `\n\nTurn budget: Beginning with turn ${finalizeAtTurn}, stop expanding the investigation and use the remaining turns to synthesize evidence, state uncertainty, and produce the final answer.` : ""; }
function jobFailure(job) { const error = new Error(job.error || `Job ${job.id} is ${job.status}`); Object.assign(error, { ...jobMetadata(job), errorKind: job.errorKind ?? null, upstreamErrorSubtype: job.upstreamErrorSubtype ?? null, suggestedAction: job.suggestedAction ?? null, exitCode: job.exitCode ?? null, signal: job.signal ?? null, sessionId: job.sessionId ?? null, requestedModel: job.requestedModel ?? job.model ?? null, parentJobId: job.parentJobId ?? null, cumulativeChainCostUsd: job.cumulativeChainCostUsd ?? null, usage: job.usage ?? null, modelUsage: job.modelUsage ?? null, effectiveModels: job.effectiveModels ?? null, totalCostUsd: job.totalCostUsd ?? null, numTurns: job.numTurns ?? null, durationMs: job.durationMs ?? null, durationApiMs: job.durationApiMs ?? null }); return error; }
function jobMetadata(job) { return { operation: job.operation ?? null, reviewKind: job.reviewKind ?? null, subjectKind: job.subjectKind ?? null, subjectLabel: job.subjectLabel ?? null, subjectFingerprint: job.subjectFingerprint ?? null, transport: job.transport ?? null, capability: job.capability ?? null }; }
