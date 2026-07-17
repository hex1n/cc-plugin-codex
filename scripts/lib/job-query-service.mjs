import { createHash } from "node:crypto";
import { findWorkspaceRoot } from "./git.mjs";
import { reconcileJob } from "./job-lifecycle.mjs";
import { listGlobalJobs, listJobs } from "./state.mjs";

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;
const LEAP_SECOND_BOUNDARIES = new Set([
  "1972-07-01", "1973-01-01", "1974-01-01", "1975-01-01", "1976-01-01", "1977-01-01", "1978-01-01", "1979-01-01", "1980-01-01",
  "1981-07-01", "1982-07-01", "1983-07-01", "1985-07-01", "1988-01-01", "1990-01-01", "1991-01-01", "1992-07-01", "1993-07-01",
  "1994-07-01", "1996-01-01", "1997-07-01", "1999-01-01", "2006-01-01", "2009-01-01", "2012-07-01", "2015-07-01", "2017-01-01"
].map(date => Date.parse(`${date}T00:00:00.000Z`)));

export async function listClaudeJobs({ workspaceRoot, scope = "workspace", status = null, purpose = null, includeTest = false, updatedAfter = null, cursor = null, limit = 20 }) {
  if (!["workspace", "global"].includes(scope)) throw invalidQuery("scope must be workspace or global");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalidQuery("limit must be an integer from 1 to 100");
  const workspace = await findWorkspaceRoot(workspaceRoot);
  const updatedAfterMs = updatedAfter == null ? null : parseRfc3339(updatedAfter);
  if (updatedAfter != null && updatedAfterMs == null) throw invalidQuery("updated_after must be an RFC 3339 timestamp");
  const filters = { workspace, scope, status, purpose, includeTest: Boolean(includeTest), updatedAfter: updatedAfter ?? null };
  const fingerprint = createHash("sha256").update(JSON.stringify(filters)).digest("hex");
  let jobs = scope === "global" ? await listGlobalJobs() : await listJobs(workspace);
  jobs = await Promise.all(jobs.map(job => job.cwd ? reconcileJob(job) : job));
  if (!includeTest) jobs = jobs.filter(job => job.purpose !== "e2e");
  if (status) jobs = jobs.filter(job => job.status === status);
  if (purpose) jobs = jobs.filter(job => job.purpose === purpose);
  if (updatedAfterMs != null) jobs = jobs.filter(job => sortTime(job) >= updatedAfterMs);
  jobs.sort(compareJobs);

  let offset = 0;
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (decoded.filter !== fingerprint) throw invalidQuery("cursor does not match the current job filters");
    const index = jobs.findIndex(job => sortTime(job) === decoded.time && job.id === decoded.id);
    if (index < 0) throw invalidQuery("cursor is no longer valid for the current job set");
    offset = index + 1;
  }
  const page = jobs.slice(offset, offset + limit), hasMore = offset + page.length < jobs.length;
  return {
    kind: "jobs",
    jobs: page.map(job => projectJob(job, { includeWorkspace: scope === "global" })),
    hasMore,
    nextCursor: hasMore && page.length ? encodeCursor({ time: sortTime(page.at(-1)), id: page.at(-1).id, filter: fingerprint }) : null
  };
}

function sortTime(job) {
  const value = Date.parse(job.updatedAt ?? job.createdAt);
  return Number.isFinite(value) ? value : 0;
}

function compareJobs(left, right) { return sortTime(right) - sortTime(left) || right.id.localeCompare(left.id); }

function encodeCursor(value) { return Buffer.from(JSON.stringify({ version: 1, ...value }), "utf8").toString("base64url"); }

function decodeCursor(value) {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (decoded.version !== 1 || !Number.isFinite(decoded.time) || typeof decoded.id !== "string" || typeof decoded.filter !== "string") throw new Error("invalid shape");
    return decoded;
  } catch { throw invalidQuery("cursor must be an opaque cursor returned by claude_jobs_list"); }
}

function invalidQuery(message) { return Object.assign(new Error(message), { rpcCode: -32602 }); }

function parseRfc3339(value) {
  const match = RFC3339.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText), hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 60) return null;
  if (zone !== "Z" && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59)) return null;
  const normalized = second === 60 ? value.replace(/:60(?=(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$)/, ":59") : value;
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) return null;
  if (second !== 60) return milliseconds;
  if (zone === "-00:00") return null;
  const leapMilliseconds = milliseconds + 1000;
  return LEAP_SECOND_BOUNDARIES.has(Math.floor(leapMilliseconds / 1000) * 1000) ? leapMilliseconds : null;
}

function daysInMonth(year, month) {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return new Set([4, 6, 9, 11]).has(month) ? 30 : 31;
}

export function projectJob(job, { includeWorkspace = false } = {}) {
  return {
    id: job.id,
    ...(includeWorkspace ? { workspace: job.cwd ?? null } : {}),
    purpose: job.purpose ?? "user",
    status: job.status,
    phase: job.phase ?? null,
    operation: job.operation ?? null,
    review_kind: job.reviewKind ?? null,
    capability: job.capability ?? null,
    artifact_status: job.artifactStatus ?? null,
    recovery_required: job.recoveryRequired === true,
    profile: job.profile ?? null,
    task_profile: job.taskProfile ?? null,
    review_profile: job.reviewProfile ?? null,
    requested_model: job.requestedModel ?? job.model ?? null,
    effective_models: job.effectiveModels ?? null,
    effort: job.effort ?? null,
    total_cost_usd: job.totalCostUsd ?? null,
    num_turns: job.numTurns ?? null,
    duration_ms: job.durationMs ?? null,
    error_kind: job.errorKind ?? (job.status === "corrupt" ? "corrupt_job_record" : null),
    created_at: job.createdAt ?? null,
    finished_at: job.finishedAt ?? null
  };
}
