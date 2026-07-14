import { isProcessRunning, terminateProcessTree } from "./process.mjs";
import { deleteJob, listJobs, transitionJob } from "./state.mjs";
import { cleanupWriteArtifact, discardWriteArtifact } from "./patch-artifact.mjs";

const DEFAULT_STARTING_TIMEOUT_MS = 60_000;

export async function reconcileJob(job, { now = Date.now() } = {}) {
  if (job.status === "starting") {
    const staleAfter = positiveTimeout(process.env.CLAUDE_COMPANION_STARTING_TIMEOUT_MS, DEFAULT_STARTING_TIMEOUT_MS);
    if (age(job.createdAt, now) >= staleAfter) {
      return (await transitionJob(job.cwd, job.id, ["starting"], current => ({ ...current, status: "failed", phase: "failed", errorKind: "starting_timeout", error: `Job remained in starting state for at least ${staleAfter}ms`, finishedAt: new Date(now).toISOString() }))).record;
    }
    return job;
  }
  if (job.status !== "running") return job;
  if (job.cancellationRequestedAt) return job;
  if (!isProcessRunning(job.pid)) return (await transitionJob(job.cwd, job.id, ["running"], current => ({ ...current, status: "failed", phase: "failed", errorKind: "worker_lost", error: "Detached worker exited before recording a terminal result", finishedAt: new Date(now).toISOString() }))).record;
  const deadline = Date.parse(job.deadlineAt);
  if (Number.isFinite(deadline) && now >= deadline) {
    await terminateProcessTree(job.pid);
    return (await transitionJob(job.cwd, job.id, ["running"], current => ({ ...current, status: "timed_out", phase: "timed_out", errorKind: "timeout", finishedAt: new Date(now).toISOString() }))).record;
  }
  return job;
}

export async function reconcileWorkspaceJobs(cwd, options) {
  const now = options?.now ?? Date.now(), jobs = await Promise.all((await listJobs(cwd)).map(job => reconcileJob(job, { ...options, now })));
  const ttlMs = positiveTimeout(process.env.CLAUDE_COMPANION_WRITE_ARTIFACT_TTL_MS, 7 * 86_400_000);
  return Promise.all(jobs.map(async job => {
    if (job.write && job.cleanupPending && !job.recoveryRequired) return cleanupWriteArtifact(job);
    if (job.write && !job.recoveryRequired && !["applied", "discarded", "partial_apply"].includes(job.artifactStatus) && !["starting", "running", "queued"].includes(job.status) && age(job.finishedAt ?? job.createdAt, now) >= ttlMs) return discardWriteArtifact({ workspaceRoot: cwd, jobId: job.id });
    return job;
  }));
}

export async function pruneWorkspaceJobs(cwd, { now = Date.now() } = {}) {
  const retentionDays = positiveTimeout(process.env.CLAUDE_COMPANION_RETENTION_DAYS, 30), maxCompleted = positiveTimeout(process.env.CLAUDE_COMPANION_MAX_COMPLETED_JOBS, 100), cutoff = now - retentionDays * 86_400_000;
  const terminal = (await listJobs(cwd)).filter(job => !["starting", "running", "queued", "corrupt"].includes(job.status)).sort((a, b) => Date.parse(b.finishedAt ?? b.createdAt) - Date.parse(a.finishedAt ?? a.createdAt));
  const expired = terminal.filter((job, index) => !job.recoveryRequired && job.artifactStatus !== "partial_apply" && (index >= maxCompleted || Date.parse(job.finishedAt ?? job.createdAt) < cutoff));
  await Promise.all(expired.map(async job => {
    const closed = job.write && !["applied", "discarded"].includes(job.artifactStatus) ? await discardWriteArtifact({ workspaceRoot: cwd, jobId: job.id }) : job;
    if (!closed.cleanupPending) await deleteJob(closed);
  }));
  return { pruned: expired.length };
}

function age(value, now) { const timestamp = Date.parse(value); return Number.isFinite(timestamp) ? now - timestamp : Infinity; }
function positiveTimeout(value, fallback) { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback; }
