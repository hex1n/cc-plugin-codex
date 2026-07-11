export function renderResult(result, { json = false } = {}) {
  const hint = result.sessionId ? `claude --resume ${result.sessionId}` : null, totalTokens = totalTokenCount(result);
  if (json) return JSON.stringify({ ok: true, result: result.text, structured_output: result.structuredOutput ?? null, session_id: result.sessionId, resume_hint: hint, usage: result.usage ?? null, model_usage: result.modelUsage ?? null, total_tokens: totalTokens, total_cost_usd: result.totalCostUsd ?? null, num_turns: result.numTurns ?? null, duration_ms: result.durationMs ?? null, duration_api_ms: result.durationApiMs ?? null }, null, 2);
  return [result.text, usageSummary(result, totalTokens), hint ? `\nResume: ${hint}` : null].filter(Boolean).join("\n");
}
export function renderError(error, { json = false } = {}) { return json ? JSON.stringify({ ok: false, error: error.message }, null, 2) : `Error: ${error.message}`; }
export function renderJob(job, { json = false } = {}) {
  const value = jobValue(job);
  return json ? JSON.stringify({ ok: true, job: value }, null, 2) : `${value.id}\t${value.status}\t${value.phase ?? "-"}\t${value.profile}\t${value.duration_ms}ms\tpid=${value.pid ?? "-"}`;
}
export function renderJobs(jobs, options = {}) {
  return options.json ? JSON.stringify({ ok: true, jobs: jobs.map(jobValue) }, null, 2) : (jobs.length ? jobs.map(job => renderJob(job)).join("\n") : "No jobs for this workspace.");
}
function jobValue(job) { const start = Date.parse(job.startedAt ?? job.createdAt), end = Date.parse(job.finishedAt ?? new Date().toISOString()); return { id: job.id, status: job.status, phase: job.phase ?? null, progress: job.progressMessage ?? null, duration_ms: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null, pid: job.pid, profile: job.profile, write: Boolean(job.write), model: job.model ?? null, created_at: job.createdAt, session_id: job.sessionId ?? null, resume_hint: job.sessionId ? `claude --resume ${job.sessionId}` : null, exit_code: job.exitCode ?? null, signal: job.signal ?? null, error_kind: job.errorKind ?? null, error: job.error ?? null, cancellation: job.cancellationMode ?? null, prompt_name: job.promptName ?? null, prompt_version: job.promptVersion ?? null, prompt_hash: job.promptHash ?? null }; }

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
