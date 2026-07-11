#!/usr/bin/env node
import { appendFileSync, chmodSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { CLAUDE_CLI, claudeArgs, parseClaudeJson } from "./lib/claude.mjs";
import { appendStreamEvent, createStreamJsonParser, errorForStreamResult, progressForStreamEvent } from "./lib/claude-stream.mjs";
import { jobArtifacts, readJob, takeJobRequest, transitionJob } from "./lib/state.mjs";

const [cwd, id] = process.argv.slice(2);
if (!cwd || !id) process.exit(2);

let job = await waitForReady(cwd, id);
try {
  const artifacts = jobArtifacts(cwd, id);
  const request = await takeJobRequest(job);
  let updateQueue = Promise.resolve();
  let malformedStream = false;
  let streamError = null;
  const outcome = await runToLogs(CLAUDE_CLI.executable, claudeArgs(request.profile, request.prompt, request), { ...job, ...artifacts }, event => {
    streamError = errorForStreamResult(event) ?? streamError;
    const progress = progressForStreamEvent(event); if (!progress) return;
    updateQueue = updateQueue.then(async () => {
      await appendStreamEvent(artifacts.eventsPath, event);
      await transitionJob(cwd, id, ["running"], latest => ({ ...latest, ...progress, updatedAt: new Date().toISOString() }));
    });
  }, () => { malformedStream = true; });
  await updateQueue;
  const latest = await readJob(cwd, id);
  if (latest.status !== "running") process.exit(0);
  if (outcome.code !== 0) {
    const stderr = (await readFile(artifacts.stderrPath, "utf8")).trim();
    await transitionJob(cwd, id, ["running"], current => ({ ...current, status: "failed", phase: "failed", exitCode: outcome.code, signal: outcome.signal, errorKind: outcome.signal ? "signal" : streamError?.errorKind ?? "nonzero_exit", upstreamErrorSubtype: streamError?.upstreamErrorSubtype ?? null, suggestedAction: streamError?.suggestedAction ?? null, sessionId: streamError?.sessionId ?? current.sessionId, error: streamError?.error ?? (stderr || `Claude exited with code ${outcome.code}`), finishedAt: new Date().toISOString() }));
    process.exit(0);
  }
  if (malformedStream) {
    await transitionJob(cwd, id, ["running"], current => ({ ...current, status: "failed", phase: "failed", exitCode: 0, signal: outcome.signal, errorKind: "invalid_stream", error: "Claude returned no valid JSON payload (malformed stream-json output)", finishedAt: new Date().toISOString() }));
    process.exit(0);
  }
  try {
    const parsed = parseClaudeJson(await readFile(artifacts.stdoutPath, "utf8"), { schemaPath: request.schemaPath ?? null });
    await transitionJob(cwd, id, ["running"], current => ({ ...current, status: "completed", phase: "done", exitCode: 0, signal: outcome.signal, sessionId: parsed.sessionId, finishedAt: new Date().toISOString() }));
  } catch (error) {
    await transitionJob(cwd, id, ["running"], current => ({ ...current, status: "failed", phase: "failed", exitCode: 0, signal: outcome.signal, errorKind: "invalid_payload", error: error.message, finishedAt: new Date().toISOString() }));
  }
} catch (error) {
  const latest = await readJob(cwd, id).catch(() => job);
  if (["starting", "running"].includes(latest.status)) await transitionJob(cwd, id, ["starting", "running"], current => ({ ...current, status: "failed", phase: "failed", errorKind: "worker_error", error: error.message, finishedAt: new Date().toISOString() }));
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

function runToLogs(command, args, record, onEvent, onMalformed) {
  return new Promise((resolve, reject) => {
    for (const path of [record.stdoutPath, record.stderrPath]) {
      appendFileSync(path, "", { encoding: "utf8", mode: 0o600 });
      chmodSync(path, 0o600);
    }
    const child = spawn(command, args, { cwd: record.cwd, env: process.env, shell: false, detached: false, stdio: ["ignore", "pipe", "pipe"] });
    const parser = createStreamJsonParser({ onEvent, onMalformed });
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { appendFileSync(record.stdoutPath, chunk, "utf8"); parser.push(chunk); });
    child.stderr.on("data", chunk => { appendFileSync(record.stderrPath, chunk, "utf8"); });
    child.once("error", reject);
    child.once("close", (code, signal) => { parser.end(); resolve({ code, signal }); });
  });
}
