export function renderResult(result, options = {}) {
  const { json = false } = options;
  const hint = result.sessionId ? `claude --resume ${result.sessionId}` : null, totalTokens = totalTokenCount(result);
  if (json) return JSON.stringify({ ok: true, usage_summary: usageSummary(result, totalTokens), total_tokens: totalTokens, total_cost_usd: result.totalCostUsd ?? null, cumulative_chain_cost_usd: options["cumulative-chain-cost-usd"] ?? null, parent_job_id: options["parent-job-id"] ?? null, num_turns: result.numTurns ?? null, duration_ms: result.durationMs ?? null, duration_api_ms: result.durationApiMs ?? null, task_profile: options["task-profile"] ?? null, review_profile: options["review-profile"] ?? null, requested_model: options.model ?? null, effective_models: result.effectiveModels ?? null, effort: options.effort ?? null, budget: profileBudget(options), result: result.text, structured_output: result.structuredOutput ?? null, session_id: result.sessionId, resume_hint: hint, disclosure: options.disclosure ?? null, usage: result.usage ?? null, model_usage: result.modelUsage ?? null }, null, 2);
  return [result.text, usageSummary(result, totalTokens), hint ? `\nResume: ${hint}` : null].filter(Boolean).join("\n");
}
export function renderError(error, { json = false } = {}) {
  const details = errorDetails(error);
  return json ? JSON.stringify({ ok: false, error: error.message, ...details }, null, 2) : [`Error: ${error.message}`, errorUsageSummary(details)].filter(Boolean).join("\n");
}
export function renderJob(job, { json = false } = {}) {
  const value = jobValue(job);
  return json ? JSON.stringify({ ok: true, job: value }, null, 2) : `${value.id}\t${value.status}\t${value.phase ?? "-"}\t${value.profile}\t${value.duration_ms}ms\tpid=${value.pid ?? "-"}`;
}
export function renderJobs(jobs, options = {}) {
  return options.json ? JSON.stringify({ ok: true, jobs: jobs.map(jobValue) }, null, 2) : (jobs.length ? jobs.map(job => renderJob(job)).join("\n") : "No jobs for this workspace.");
}
function jobValue(job) { const start = Date.parse(job.startedAt ?? job.createdAt), end = Date.parse(job.finishedAt ?? new Date().toISOString()); return { id: job.id, record_version: job.recordVersion ?? 1, metadata_completeness: job.metadataCompleteness ?? "legacy-partial", purpose: job.purpose ?? "user", namespace: job.namespace ?? null, workspace: job.cwd ?? null, disclosure: job.disclosure ?? null, status: job.status, phase: job.phase ?? null, progress: job.progressMessage ?? null, duration_ms: job.durationMs ?? (Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null), duration_api_ms: job.durationApiMs ?? null, pid: job.pid, profile: job.profile, task_profile: job.taskProfile ?? null, review_profile: job.reviewProfile ?? null, budget: job.taskProfile || job.reviewProfile ? { max_turns: job.maxTurns ?? null, finalize_at_turn: job.finalizeAtTurn ?? null, soft_budget_usd: job.maxBudgetUsd ?? null, max_budget_usd: job.maxBudgetUsd ?? null, timeout_ms: job.timeoutMs ?? null } : null, write: Boolean(job.write), model: job.model ?? null, requested_model: job.requestedModel ?? job.model ?? null, effective_models: job.effectiveModels ?? null, effort: job.effort ?? null, created_at: job.createdAt, finished_at: job.finishedAt ?? null, session_id: job.sessionId ?? null, resume_hint: job.sessionId ? `claude --resume ${job.sessionId}` : null, parent_job_id: job.parentJobId ?? null, cumulative_chain_cost_usd: job.cumulativeChainCostUsd ?? null, exit_code: job.exitCode ?? null, signal: job.signal ?? null, error_kind: job.errorKind ?? null, upstream_error_subtype: job.upstreamErrorSubtype ?? null, suggested_action: job.suggestedAction ?? null, error: job.error ?? null, total_cost_usd: job.totalCostUsd ?? null, num_turns: job.numTurns ?? null, usage: job.usage ?? null, model_usage: job.modelUsage ?? null, cancellation: job.cancellationMode ?? null, prompt_name: job.promptName ?? null, prompt_version: job.promptVersion ?? null, prompt_hash: job.promptHash ?? null }; }

function profileBudget(options) {
  if (!options["task-profile"] && !options["review-profile"]) return null;
  return { max_turns: options["max-turns"] ?? null, finalize_at_turn: options["finalize-at-turn"] ?? null, soft_budget_usd: options["max-budget-usd"] ?? null, max_budget_usd: options["max-budget-usd"] ?? null, timeout_ms: options["timeout-ms"] ?? null };
}

function totalTokenCount(result) {
  const models = result.modelUsage && typeof result.modelUsage === "object" ? Object.values(result.modelUsage) : [];
  const modelTotal = sumTokens(models, [["inputTokens", "input_tokens"], ["cacheCreationInputTokens", "cache_creation_input_tokens"], ["cacheReadInputTokens", "cache_read_input_tokens"], ["outputTokens", "output_tokens"]]);
  if (modelTotal !== null) return modelTotal;
  return sumTokens(result.usage ? [result.usage] : [], [["input_tokens"], ["cache_creation_input_tokens"], ["cache_read_input_tokens"], ["output_tokens"]]);
}
function sumTokens(records, fields) {
  let total = 0, found = false;
  for (const record of records) for (const aliases of fields) {
    const value = aliases.map(alias => record?.[alias]).find(Number.isFinite);
    if (value !== undefined) { total += value; found = true; }
  }
  return found ? total : null;
}
function usageSummary(result, totalTokens) {
  const parts = [totalTokens == null ? null : `tokens=${totalTokens}`, result.usage?.output_tokens == null ? null : `output=${result.usage.output_tokens}`, result.numTurns == null ? null : `turns=${result.numTurns}`, result.durationMs == null ? null : `duration_ms=${result.durationMs}`, result.durationApiMs == null ? null : `api_ms=${result.durationApiMs}`, result.totalCostUsd == null ? null : `cost_usd=${result.totalCostUsd}`].filter(Boolean);
  return parts.length ? `Usage: ${parts.join(" ")}` : null;
}
function errorDetails(error) {
  return {
    error_kind: error.errorKind ?? null,
    upstream_error_subtype: error.upstreamErrorSubtype ?? null,
    suggested_action: error.suggestedAction ?? null,
    exit_code: error.exitCode ?? null,
    signal: error.signal ?? null,
    session_id: error.sessionId ?? null,
    requested_model: error.requestedModel ?? null,
    parent_job_id: error.parentJobId ?? null,
    cumulative_chain_cost_usd: error.cumulativeChainCostUsd ?? null,
    total_cost_usd: error.totalCostUsd ?? null,
    num_turns: error.numTurns ?? null,
    duration_ms: error.durationMs ?? null,
    duration_api_ms: error.durationApiMs ?? null,
    usage: error.usage ?? null,
    model_usage: error.modelUsage ?? null,
    effective_models: error.effectiveModels ?? null
  };
}
function errorUsageSummary(details) {
  const parts = [details.num_turns == null ? null : `turns=${details.num_turns}`, details.duration_ms == null ? null : `duration_ms=${details.duration_ms}`, details.total_cost_usd == null ? null : `cost_usd=${details.total_cost_usd}`].filter(Boolean);
  return parts.length ? `Usage: ${parts.join(" ")}` : null;
}
