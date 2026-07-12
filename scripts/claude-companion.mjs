#!/usr/bin/env node
import { parseArgs, usage } from "./lib/args.mjs";
import { CLAUDE_CLI, REVIEW_DIFF_ADAPTER, readClaudeJobResult, runClaude, startClaudeJob } from "./lib/claude.mjs";
import { collectReviewContext, findWorkspaceRoot } from "./lib/git.mjs";
import { renderError, renderJob, renderJobs, renderResult } from "./lib/render.mjs";
import { codexSessionId, listGlobalJobs, listJobs, readJob, transitionJob } from "./lib/state.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import { reconcileJob } from "./lib/job-lifecycle.mjs";
import { inspectClaudeSetup } from "./lib/setup.mjs";
import { loadRuntimeConfig, setReviewGateEnabled } from "./lib/config.mjs";
import { renderPrompt, schemaPath } from "./lib/prompts.mjs";
import { readFile } from "node:fs/promises";
async function reviewPrompt(c, options) { return renderPrompt("review", { TARGET_LABEL: c.range, REVIEW_COLLECTION_GUIDANCE: collectionGuidance(c), REVIEW_BUDGET_GUIDANCE: reviewBudgetGuidance(options), REVIEW_INPUT: `Repository: ${c.root}\n${c.diff}` }); }
export async function adversarialReviewPrompt(c, focus = "", options = {}) { return renderPrompt("adversarial-review", { TARGET_LABEL: c.range, USER_FOCUS: focus || "none", REVIEW_COLLECTION_GUIDANCE: collectionGuidance(c), REVIEW_BUDGET_GUIDANCE: reviewBudgetGuidance(options), REVIEW_INPUT: `Repository: ${c.root}\n${c.diff}` }); }
const refresh = reconcileJob;
const ACTIVE = new Set(["starting", "running", "queued"]);
async function execute(profile, renderedPrompt, cwd, options, outputSchema = null) {
  const prompt = typeof renderedPrompt === "string" ? renderedPrompt : renderedPrompt.text, promptMeta = typeof renderedPrompt === "string" ? null : renderedPrompt;
  const runtime = { resume: options.resume, continueSession: options.continue, write: options.write, model: options.model, maxTurns: options["max-turns"], finalizeAtTurn: options["finalize-at-turn"], maxBudgetUsd: options["max-budget-usd"], reviewProfile: options["review-profile"], timeoutMs: options["timeout-ms"] == null ? undefined : positiveNumber(options["timeout-ms"], "--timeout-ms"), backgroundTimeoutMs: options.backgroundTimeoutMs };
  if (options.background) return renderJob(await startClaudeJob({ profile, prompt, cwd, ...runtime, schemaPath: outputSchema, promptMeta, purpose: options.purpose ?? "user", disclosure: options.disclosure ?? null }), options);
  return renderResult(await runClaude({ profile, prompt, cwd, ...runtime, schemaPath: outputSchema }), options);
}
async function dispatch({ command, positional, options }) {
  if (options.help || !command) return usage();
  const runtimeConfig = await loadRuntimeConfig({ cwd: process.cwd() });
  if (command === "task") {
    options.model ??= runtimeConfig.task.model;
    options["max-turns"] ??= runtimeConfig.task.maxTurns;
    options["max-budget-usd"] ??= runtimeConfig.task.maxBudgetUsd;
  }
  const reviewCommand = command === "review" || command === "adversarial-review";
  if (reviewCommand) applyReviewRuntime(options, runtimeConfig.review);
  options.backgroundTimeoutMs = runtimeConfig.jobs.backgroundTimeoutMs;
  if (options.background && options.wait) throw new Error("--background and --wait cannot be used together");
  if (options.resume && command !== "task") throw new Error("--resume is only supported by task");
  if (options.model && command !== "task" && !reviewCommand) throw new Error("--model is only supported by task, review, and adversarial-review");
  if (options["review-profile"] && !reviewCommand) throw new Error("--review-profile is only supported by review and adversarial-review");
  if ((options.write || options.continue || options.fresh || options["prompt-file"] || options.context) && command !== "task") throw new Error("These runtime options are only supported by task");
  if ((options["max-turns"] || options["max-budget-usd"] || options["finalize-at-turn"]) && command !== "task" && !reviewCommand) throw new Error("Budget options are only supported by task, review, and adversarial-review");
  if (command === "review") { if (positional.length) throw new Error(`Unexpected review arguments: ${positional.join(" ")}`); const context = await collectReviewContext({ cwd: process.cwd(), base: options.base }); return execute("review", await reviewPrompt(context, options), context.root, options, schemaPath("review-output")); }
  if (command === "adversarial-review") { const context = await collectReviewContext({ cwd: process.cwd(), base: options.base }); return execute("review", await adversarialReviewPrompt(context, positional.join(" ").trim(), options), context.root, options, schemaPath("review-output")); }
  if (command === "task") {
    const routing = [Boolean(options.resume), options.continue, options.fresh].filter(Boolean).length;
    if (routing > 1) throw new Error("Choose only one of --resume, --continue, or --fresh");
    const maxTurns = options["max-turns"] == null ? null : positiveInteger(options["max-turns"], "--max-turns");
    const finalizeAtTurn = options["finalize-at-turn"] == null ? null : positiveInteger(options["finalize-at-turn"], "--finalize-at-turn");
    if (finalizeAtTurn && !maxTurns) throw new Error("--finalize-at-turn requires --max-turns");
    if (finalizeAtTurn && finalizeAtTurn >= maxTurns) throw new Error("--finalize-at-turn must be lower than --max-turns");
    const contextMode = options.context ?? "summary";
    if (!["summary", "diff", "full"].includes(contextMode)) throw new Error("--context must be summary, diff, or full");
    const maxBudget = options["max-budget-usd"] == null ? null : positiveNumber(options["max-budget-usd"], "--max-budget-usd");
    options["max-turns"] = maxTurns; options["max-budget-usd"] = maxBudget;
    const userTask = await readTaskInput(positional, options);
    if (!userTask) throw new Error("task requires a prompt, --prompt-file, or piped stdin");
    options.disclosure = { destination: "Claude Code", context: contextMode, source: options["prompt-file"] ? "prompt-file" : positional.length ? "positional" : "stdin", bytes: Buffer.byteLength(userTask), mode: options.write ? "write-capable" : "read-only", repository_access: "enabled" };
    const budgetGuidance = finalizeAtTurn ? `\n\nTurn budget: Beginning with turn ${finalizeAtTurn}, stop expanding the investigation and use the remaining turns to synthesize evidence, state uncertainty, and produce the final answer.` : "";
    const prompt = await renderPrompt("task-wrapper", { USER_TASK: `${userTask}${budgetGuidance}`, PERMISSION_MODE: options.write ? "write-capable (acceptEdits)" : "read-only (plan)" });
    return execute("task", prompt, await findWorkspaceRoot(process.cwd()), options);
  }
  if (command === "transfer") {
    if (options.background || options.wait || options.base) throw new Error("transfer only accepts a digest and --json");
    const digest = positional.join(" ").trim();
    if (!digest) throw new Error("transfer requires a Codex conversation digest");
    const prompt = (await renderPrompt("transfer-seed", { DIGEST: digest })).text;
    const argv = [CLAUDE_CLI.executable, prompt];
    return options.json ? JSON.stringify({ ok: true, kind: "summary-seed", faithful_import: false, argv, prompt }, null, 2) : `Summary seed only (not a faithful session import).\n\n${argv.map(shellQuote).join(" ")}`;
  }
  if (command === "setup") {
    if (positional.length || options.background || options.wait || options.base) throw new Error("setup only accepts review-gate controls and --json");
    if (options["enable-review-gate"] && options["disable-review-gate"]) throw new Error("Choose only one review-gate control");
    if (options["enable-review-gate"]) await setReviewGateEnabled(true);
    if (options["disable-review-gate"]) await setReviewGateEnabled(false);
    const report = await inspectClaudeSetup();
    return options.json ? JSON.stringify({ ok: true, setup: report }, null, 2) : renderSetup(report);
  }
  const workspace = await findWorkspaceRoot(process.cwd());
  if (command === "status") {
    if (positional.length > 1) throw new Error("status accepts at most one job id");
    if (options.wait && !positional[0]) throw new Error("status --wait requires a job id");
    if (positional[0] && (options.global || options.recent || options.status || options.purpose || options["include-test"])) throw new Error("Global and filter options cannot be combined with a job id");
    if (options.global && options.all) throw new Error("Choose either --all or --global");
    if (positional[0]) {
      const job = options.wait ? await waitForJob(workspace, positional[0], options) : await refresh(await readJob(workspace, positional[0]));
      return renderJob(job, options);
    }
    const allJobs = await Promise.all((options.global ? await listGlobalJobs() : await listJobs(workspace)).map(refresh));
    if (options.global || options.all || options.recent || options.status || options.purpose || options["include-test"]) return renderJobs(filterJobs(allJobs, options), options);
    const jobs = scopedJobs(allJobs);
    if (!jobs[0]) throw new Error("No jobs found for the current Codex session");
    return renderJob(jobs[0], options);
  }
  if (command === "result") {
    if (positional.length > 1) throw new Error("result accepts at most one job id");
    const selected = positional[0] ? await readJob(workspace, positional[0]) : scopedJobs(await listJobs(workspace)).find(job => !ACTIVE.has(job.status));
    if (!selected) throw new Error("No finished job found for this workspace");
    const job = await refresh(selected);
    if (job.status === "running" || job.status === "starting") throw new Error(`Job ${job.id} is still ${job.status}`);
    if (job.status === "cancelled") throw new Error(`Job ${job.id} was cancelled`);
    if (job.status === "timed_out") throw new Error(`Job ${job.id} exceeded its ${job.timeoutMs}ms wall-clock timeout`);
    if (job.status === "failed") throw jobFailureError(job);
    return renderResult(await readClaudeJobResult(job), { ...options, "review-profile": job.reviewProfile ?? null, "max-turns": job.maxTurns ?? null, "finalize-at-turn": job.finalizeAtTurn ?? null, "max-budget-usd": job.maxBudgetUsd ?? null, "timeout-ms": job.timeoutMs ?? null });
  }
  if (command === "cancel") {
    if (positional.length > 1) throw new Error("cancel accepts at most one job id");
    const selected = positional[0] ? await readJob(workspace, positional[0]) : scopedJobs(await listJobs(workspace)).find(job => ACTIVE.has(job.status));
    if (!selected) throw new Error("No active job found for this workspace");
    const job = await refresh(selected);
    if (job.status !== "running") throw new Error(`Job ${job.id} is ${job.status}, not running`);
    const intent = await transitionJob(workspace, job.id, ["running"], current => ({ ...current, cancellationRequestedAt: new Date().toISOString() }));
    if (!intent.changed) throw new Error(`Job ${job.id} became ${intent.record.status} before cancellation started`);
    try { await terminateProcessTree(job.pid); }
    catch (error) {
      await transitionJob(workspace, job.id, ["running"], current => { const { cancellationRequestedAt, ...rest } = current; return { ...rest, cancellationError: error.message }; });
      throw error;
    }
    const transition = await transitionJob(workspace, job.id, ["running"], current => ({ ...current, status: "cancelled", phase: "cancelled", cancellationMode: "hard_process_tree", finishedAt: new Date().toISOString() }));
    if (!transition.changed) throw new Error(`Job ${job.id} became ${transition.record.status} before cancellation completed`);
    return renderJob(transition.record, options);
  }
  throw new Error(`Unknown command: ${command}`);
}
function shellQuote(value) { return `'${value.replaceAll("'", `'\\''`)}'`; }
async function readTaskInput(positional, options) {
  if (options["prompt-file"] && positional.length) throw new Error("Choose either positional task text or --prompt-file");
  if (options["prompt-file"]) return (await readFile(options["prompt-file"], "utf8")).trim();
  const direct = positional.join(" ").trim(); if (direct) return direct;
  if (process.stdin.isTTY) return "";
  return new Promise((resolve, reject) => { let value = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => { value += chunk; }); process.stdin.on("end", () => resolve(value.trim())); process.stdin.on("error", reject); });
}
function positiveInteger(value, name) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} requires a positive integer`); return parsed; }
function positiveNumber(value, name) { const parsed = Number(value); if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} requires a positive number`); return parsed; }
function applyReviewRuntime(options, reviewConfig) {
  const profileName = options["review-profile"] ?? reviewConfig.profile;
  if (!["quick", "standard", "deep"].includes(profileName)) throw new Error("--review-profile must be quick, standard, or deep");
  const profile = reviewConfig.profiles[profileName];
  options["review-profile"] = profileName;
  options.base ??= reviewConfig.base;
  options.model ??= profile.model ?? reviewConfig.model;
  const explicitFinalize = options["finalize-at-turn"] != null;
  options["max-turns"] = positiveInteger(options["max-turns"] ?? profile.maxTurns, "--max-turns");
  if (options["max-turns"] < 2) throw new Error("Review --max-turns must be at least 2 so the finalization phase has room to run");
  options["finalize-at-turn"] = positiveInteger(explicitFinalize ? options["finalize-at-turn"] : Math.min(profile.finalizeAtTurn, options["max-turns"] - 1), "--finalize-at-turn");
  if (options["finalize-at-turn"] >= options["max-turns"]) throw new Error("--finalize-at-turn must be lower than --max-turns");
  options["max-budget-usd"] = positiveNumber(options["max-budget-usd"] ?? profile.maxBudgetUsd, "--max-budget-usd");
  options["timeout-ms"] = positiveNumber(options["timeout-ms"] ?? profile.timeoutMs, "--timeout-ms");
}
function reviewBudgetGuidance(options) {
  return `Review profile: ${options["review-profile"]}. Maximum turns: ${options["max-turns"]}. Maximum budget: $${options["max-budget-usd"]}. Beginning with turn ${options["finalize-at-turn"]}, stop expanding the investigation. Use remaining turns to verify findings, enumerate examined and skipped files, state uncertainty and budget exhaustion, and recommend only a focused deeper follow-up when warranted.`;
}
function collectionGuidance(context) {
  if (context.inline) return "Inspect the supplied diff. Use repository tools only for focused caller or invariant tracing.";
  return `Use the bounded read-only adapter for patch content: node ${JSON.stringify(REVIEW_DIFF_ADAPTER)} --base ${JSON.stringify(context.adapterBase)} --file <repo-relative-path> [--file <path> ...] --max-bytes 65536. Use at most five files per call. The process already runs at the repository root. Run exactly one command per Bash tool call; do not use git -C, pipes, redirects, command separators, echo, tail, or shell composition. Use Read, Grep, or Glob for focused follow-up.`;
}
async function waitForJob(workspace, id, options) {
  const timeoutMs = options["timeout-ms"] == null ? 240_000 : positiveNumber(options["timeout-ms"], "--timeout-ms"), pollMs = options["poll-interval-ms"] == null ? 2_000 : positiveNumber(options["poll-interval-ms"], "--poll-interval-ms"), deadline = Date.now() + timeoutMs;
  while (true) { const job = await refresh(await readJob(workspace, id)); if (!ACTIVE.has(job.status)) return job; if (Date.now() >= deadline) throw new Error(`Timed out waiting for job ${id}`); await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now())))); }
}
function renderSetup(report) {
  const auth = report.authenticated ? "yes" : report.installed ? "unavailable in this execution context, or not logged in" : "not checked";
  const lines = [`Claude CLI: ${report.installed ? report.version : "not found"}`, `Authenticated: ${auth}`, `Authentication state: ${report.authenticationState}`, `Review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`, `Review gate config: ${report.reviewGateConfig}`, `Codex plugin root: ${report.pluginRoot}`, `Codex plugin manifest: ${report.pluginManifest}`, `Plugin skills: ${report.skillLocation}`];
  if (!report.installed) lines.push(`Install: ${report.installHint}`);
  else if (!report.authenticated) lines.push("Login: claude auth login");
  return lines.join("\n");
}
function scopedJobs(jobs) { const sessionId = codexSessionId(); return sessionId ? jobs.filter(job => job.ownerSessionId === sessionId) : jobs; }
function filterJobs(jobs, options) {
  let filtered = options["include-test"] ? jobs : jobs.filter(job => job.purpose !== "e2e");
  if (options.recent) { const cutoff = Date.now() - durationMs(options.recent); filtered = filtered.filter(job => Date.parse(job.createdAt) >= cutoff); }
  if (options.status) filtered = filtered.filter(job => job.status === options.status);
  if (options.purpose) filtered = filtered.filter(job => job.purpose === options.purpose);
  return filtered;
}
function durationMs(value) { const match = /^(\d+)(m|h|d)$/.exec(String(value)); if (!match) throw new Error("--recent requires a duration such as 30m, 24h, or 7d"); return Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]]; }
function jobFailureError(job) {
  const error = new Error(job.error || `Job ${job.id} failed`);
  Object.assign(error, { errorKind: job.errorKind ?? null, upstreamErrorSubtype: job.upstreamErrorSubtype ?? null, suggestedAction: job.suggestedAction ?? null, exitCode: job.exitCode ?? null, signal: job.signal ?? null, sessionId: job.sessionId ?? null, usage: job.usage ?? null, modelUsage: job.modelUsage ?? null, totalCostUsd: job.totalCostUsd ?? null, numTurns: job.numTurns ?? null, durationMs: job.durationMs ?? null, durationApiMs: job.durationApiMs ?? null });
  return error;
}
try { const parsed = parseArgs(process.argv.slice(2)); process.stdout.write(`${await dispatch(parsed)}\n`); }
catch (error) { let json = false; try { json = parseArgs(process.argv.slice(2)).options.json; } catch {} process.stderr.write(`${renderError(error, { json })}\n`); process.exitCode = 1; }
