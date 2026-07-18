#!/usr/bin/env node
import { appendFileSync, chmodSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { buildClaudeInvocation, parseClaudeJson } from "./lib/claude.mjs";
import { appendStreamEvent, createReviewInitValidator, createStreamJsonParser, errorForStreamResult, progressForStreamEvent } from "./lib/claude-stream.mjs";
import { jobArtifacts, readJob, takeJobRequest, transitionJob } from "./lib/state.mjs";
import { finalizeWriteArtifact } from "./lib/patch-artifact.mjs";
import { cleanupReviewEvidenceRuntime, readReviewEvidenceState } from "./lib/review-evidence-runtime.mjs";
import { terminateDescendantTree } from "./lib/process.mjs";

await runWorker();

async function runWorker() {
const [cwd, id] = process.argv.slice(2);
if (!cwd || !id) { process.exitCode = 2; return; }

let job = await waitForReady(cwd, id);
try {
  const artifacts = jobArtifacts(cwd, id);
  const request = await takeJobRequest(job);
  let updateQueue = Promise.resolve();
  let malformedStream = false;
  let streamError = null;
  let finalEvidenceState = null;
  const initValidator = request.reviewEvidence ? createReviewInitValidator() : null;
  const invocation = buildClaudeInvocation(request.profile, request.prompt, request);
  const outcome = await runToLogs(invocation, { ...job, ...artifacts, executionCwd: request.executionCwd ?? job.cwd }, event => {
    const initialized = initValidator?.observe(event) ?? false;
    streamError = errorForStreamResult(event) ?? streamError;
    const progress = progressForStreamEvent(event); if (!progress) return;
    updateQueue = updateQueue.then(async () => {
      await appendStreamEvent(artifacts.eventsPath, event);
      await transitionJob(cwd, id, ["running"], latest => ({ ...latest, ...progress, updatedAt: new Date().toISOString() }));
    });
    return initialized;
  }, () => { malformedStream = true; }, {
    onSpawn: claudePid => {
      updateQueue = updateQueue.then(() => transitionJob(cwd, id, ["running"], latest => ({ ...latest, claudePid, updatedAt: new Date().toISOString() })));
      return updateQueue;
    },
    leaseStatePath: request.leaseStatePath,
    onLeaseState: state => {
      finalEvidenceState = state;
      updateQueue = updateQueue.then(() => transitionJob(cwd, id, ["running"], latest => ({
        ...latest,
        phase: state.phase,
        progressMessage: state.deniedCalls >= 2 ? "Repeated evidence requests were denied; Claude must finalize without more evidence" : state.phase === "finalizing" ? "Evidence lease exhausted; Claude is finalizing" : "Claude is gathering bounded review evidence",
        evidenceLease: evidenceLeaseFromState(state),
        evidenceLeaseExhausted: state.exhausted,
        updatedAt: new Date().toISOString(),
      })));
      return updateQueue;
    },
  });
  await updateQueue;
  const latest = await readJob(cwd, id);
  if (latest.status !== "running") return;
  if (request.reviewEvidence) {
    try {
      if (outcome.inspectionError) throw outcome.inspectionError;
      initValidator.assertReady();
      finalEvidenceState = await readReviewEvidenceState(request.leaseStatePath, { expectedParentPid: outcome.pid });
    } catch (error) {
      await transitionJob(cwd, id, ["running"], current => ({ ...current, status: "failed", phase: "failed", exitCode: outcome.code, signal: outcome.signal, errorKind: "mcp_startup", suggestedAction: error.suggestedAction ?? "inspect_review_evidence_runtime", error: error.message, finishedAt: new Date().toISOString() }));
      return;
    }
  }
  if (outcome.code !== 0) {
    const stderr = (await readFile(artifacts.stderrPath, "utf8")).trim();
    await transitionJob(cwd, id, ["running"], current => ({ ...current, status: "failed", phase: "failed", exitCode: outcome.code, signal: outcome.signal, errorKind: outcome.signal ? "signal" : streamError?.errorKind ?? "nonzero_exit", upstreamErrorSubtype: streamError?.upstreamErrorSubtype ?? null, suggestedAction: streamError?.suggestedAction ?? null, sessionId: streamError?.sessionId ?? current.sessionId, usage: streamError?.usage ?? null, modelUsage: streamError?.modelUsage ?? null, effectiveModels: streamError?.effectiveModels ?? null, totalCostUsd: streamError?.totalCostUsd ?? null, cumulativeChainCostUsd: cumulativeChainCost(current, streamError?.totalCostUsd), numTurns: streamError?.numTurns ?? null, durationMs: streamError?.durationMs ?? null, durationApiMs: streamError?.durationApiMs ?? null, costBudgetExhausted: streamError?.errorKind === "max_budget", turnLimitReached: streamError?.errorKind === "max_turns", error: streamError?.error ?? (stderr || `Claude exited with code ${outcome.code}`), finishedAt: new Date().toISOString() }));
    return;
  }
  if (malformedStream) {
    await transitionJob(cwd, id, ["running"], current => ({ ...current, status: "failed", phase: "failed", exitCode: 0, signal: outcome.signal, errorKind: "invalid_stream", error: "Claude returned no valid JSON payload (malformed stream-json output)", finishedAt: new Date().toISOString() }));
    return;
  }
  try {
    const parsed = parseClaudeJson(await readFile(artifacts.stdoutPath, "utf8"), { schemaPath: request.schemaPath ?? null });
    const artifact = request.finalizeWrite ? await finalizeWriteArtifact(latest) : {};
    await transitionJob(cwd, id, ["running"], current => ({
      ...current,
      ...artifact,
      sandboxVerified: request.finalizeWrite ? true : current.sandboxVerified,
      status: "completed",
      phase: request.finalizeWrite ? "awaiting_apply" : "done",
      exitCode: 0,
      signal: outcome.signal,
      sessionId: parsed.sessionId,
      usage: parsed.usage,
      modelUsage: parsed.modelUsage,
      effectiveModels: parsed.effectiveModels,
      totalCostUsd: parsed.totalCostUsd,
      cumulativeChainCostUsd: cumulativeChainCost(current, parsed.totalCostUsd),
      numTurns: parsed.numTurns,
      durationMs: parsed.durationMs,
      durationApiMs: parsed.durationApiMs,
      evidenceLease: finalEvidenceState ? evidenceLeaseFromState(finalEvidenceState) : current.evidenceLease,
      evidenceLeaseExhausted: finalEvidenceState?.exhausted ?? false,
      costBudgetExhausted: false,
      turnLimitReached: false,
      finishedAt: new Date().toISOString()
    }));
  } catch (error) {
    await transitionJob(cwd, id, ["running"], current => error.name === "ClaudeInvocationError" ? {
      ...current,
      status: "failed",
      phase: "failed",
      exitCode: 0,
      signal: outcome.signal,
      errorKind: error.errorKind ?? "claude_result",
      upstreamErrorSubtype: error.upstreamErrorSubtype ?? null,
      suggestedAction: error.suggestedAction ?? null,
      sessionId: error.sessionId ?? current.sessionId,
      usage: error.usage ?? null,
      modelUsage: error.modelUsage ?? null,
      effectiveModels: error.effectiveModels ?? null,
      totalCostUsd: error.totalCostUsd ?? null,
      cumulativeChainCostUsd: cumulativeChainCost(current, error.totalCostUsd),
      numTurns: error.numTurns ?? null,
      durationMs: error.durationMs ?? null,
      durationApiMs: error.durationApiMs ?? null,
      costBudgetExhausted: error.errorKind === "max_budget",
      turnLimitReached: error.errorKind === "max_turns",
      error: error.message,
      finishedAt: new Date().toISOString()
    } : { ...current, status: "failed", phase: "failed", exitCode: 0, signal: outcome.signal, errorKind: "invalid_payload", error: error.message, finishedAt: new Date().toISOString() });
  }
} catch (error) {
  const latest = await readJob(cwd, id).catch(() => job);
  if (["starting", "running"].includes(latest.status)) await transitionJob(cwd, id, ["starting", "running"], current => ({ ...current, status: "failed", phase: "failed", errorKind: "worker_error", error: error.message, finishedAt: new Date().toISOString() }));
} finally {
  if (job.reviewControlRoot) await cleanupReviewEvidenceRuntime({ controlRoot: job.reviewControlRoot }).catch(() => {});
}
}

function cumulativeChainCost(job, currentCost) {
  if (!Number.isFinite(currentCost)) return null;
  if (job.parentJobId && !Number.isFinite(job.priorChainCostUsd)) return null;
  return (job.priorChainCostUsd ?? 0) + currentCost;
}

async function waitForReady(workspace, jobId) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const record = await readJob(workspace, jobId);
    if (record.status === "running" && record.pid === process.pid) return record;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Job ${jobId} did not enter running state`);
}

function runToLogs(invocation, record, onEvent, onMalformed, { onSpawn = null, leaseStatePath = null, onLeaseState = null } = {}) {
  return new Promise((resolve, reject) => {
    for (const path of [record.stdoutPath, record.stderrPath]) {
      appendFileSync(path, "", { encoding: "utf8", mode: 0o600 });
      chmodSync(path, 0o600);
    }
    const child = spawn(invocation.command, invocation.args, { cwd: record.executionCwd, env: record.sandboxRequired ? sandboxedEnvironment() : process.env, shell: false, detached: false, stdio: ["pipe", "pipe", "pipe"] });
    let inspectionError = null, initialized = false, lastRevision = 0, pollBusy = false, pollQueue = Promise.resolve(), abortTermination = Promise.resolve();
    const abort = error => {
      if (inspectionError) return;
      inspectionError = error;
      abortTermination = terminateDescendantTree(child.pid).catch(terminationError => { inspectionError.terminationError = terminationError.message; });
    };
    if (onSpawn) Promise.resolve(onSpawn(child.pid)).catch(abort);
    const parser = createStreamJsonParser({
      onEvent: event => {
        try { initialized ||= onEvent(event) === true; }
        catch (error) { abort(error); }
      },
      onMalformed,
    });
    const poll = () => {
      if (!leaseStatePath || !onLeaseState || !initialized || pollBusy || inspectionError) return;
      pollBusy = true;
      pollQueue = pollQueue.then(async () => {
        const state = await readReviewEvidenceState(leaseStatePath, { expectedParentPid: child.pid });
        if (state.revision < lastRevision) throw Object.assign(new Error("Review evidence lease revision moved backwards"), { errorKind: "mcp_startup" });
        if (state.revision > lastRevision) { lastRevision = state.revision; await onLeaseState(state); }
      }).catch(abort).finally(() => { pollBusy = false; });
    };
    const pollTimer = leaseStatePath ? setInterval(poll, 100) : null;
    pollTimer?.unref();
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { appendFileSync(record.stdoutPath, chunk, "utf8"); parser.push(chunk); });
    child.stderr.on("data", chunk => { appendFileSync(record.stderrPath, chunk, "utf8"); });
    child.stdin.on("error", error => { if (error.code !== "EPIPE") reject(error); });
    child.stdin.end(invocation.stdin);
    child.once("error", reject);
    child.once("close", async (code, signal) => {
      if (pollTimer) clearInterval(pollTimer);
      try { parser.end(); await Promise.all([pollQueue, abortTermination]); resolve({ code, signal, pid: child.pid, inspectionError }); }
      catch (error) { reject(error); }
    });
  });
}

function evidenceLeaseFromState(state) {
  return { revision: state.revision, phase: state.phase, limitUnits: state.limitUnits, usedUnits: state.usedUnits, remainingUnits: state.remainingUnits, exhausted: state.exhausted, allowedCalls: state.allowedCalls, deniedCalls: state.deniedCalls, bytesReturned: state.bytesReturned, filesExamined: state.filesExamined, filesSkipped: state.filesSkipped };
}

function sandboxedEnvironment() { const { CLAUDE_CODE_EXECUTABLE, NODE_OPTIONS, NODE_PATH, BASH_ENV, ENV, GIT_CONFIG_PARAMETERS, ...env } = process.env; for (const name of Object.keys(env)) if (/^GIT_CONFIG_(?:COUNT|KEY_|VALUE_)/.test(name)) delete env[name]; return env; }
