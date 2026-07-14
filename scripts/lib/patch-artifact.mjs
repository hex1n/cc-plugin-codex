import { createHash } from "node:crypto";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { jobArtifacts, readJob, transitionJob, withWorkspaceLock } from "./state.mjs";
import { runCommand } from "./process.mjs";
import { fingerprint, removeIsolatedWriteWorkspace, snapshotResultWorkspace, snapshotWorkspace, syncResultToTrustedArtifact } from "./write-workspace.mjs";

export async function finalizeWriteArtifact(job) {
  if (!job.isolatedRoot || !job.artifactRoot || !job.baselineCommit) throw new Error("Write job is missing isolated workspace metadata");
  await syncResultToTrustedArtifact({ isolatedRoot: job.isolatedRoot, artifactRoot: job.artifactRoot, baselineRecords: job.baselineRecords });
  await git(["add", "-A"], job.artifactRoot);
  const patch = (await git(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", job.baselineCommit], job.artifactRoot)).stdout;
  const changedPaths = nulList((await git(["diff", "--cached", "--name-only", "-z", job.baselineCommit], job.artifactRoot)).stdout).sort();
  const resultRecords = await snapshotResultWorkspace(job.isolatedRoot, job.baselineRecords), patchHash = createHash("sha256").update(patch).digest("hex"), { patchPath } = jobArtifacts(job.cwd, job.id);
  await writeFile(patchPath, patch, { encoding: "utf8", mode: 0o600 });
  await chmod(patchPath, 0o600);
  return { artifactStatus: "awaiting_apply", patchHash, patchBytes: Buffer.byteLength(patch), changedPaths, resultFingerprint: fingerprint(resultRecords), resultRecords };
}

export async function applyWriteArtifact({ workspaceRoot, jobId, allowContextDrift = false, expectedPatchHash = null }) {
  return withWorkspaceLock(workspaceRoot, async () => {
    const job = await readJob(workspaceRoot, jobId);
    let transition;
    try { transition = await transitionJob(workspaceRoot, job.id, ["completed"], async current => {
      if (current.artifactStatus === "applied") return current;
      if (current.artifactStatus !== "awaiting_apply") throw operationError(`Write artifact is ${current.artifactStatus ?? "unavailable"}`, "artifact_unavailable");
      if (expectedPatchHash && expectedPatchHash !== current.patchHash) throw operationError("expected_patch_hash does not match the frozen artifact", "patch_hash_mismatch");
      const currentRecords = await snapshotWorkspace(current.sourceRoot), baseline = recordMap(current.baselineRecords), now = recordMap(currentRecords), changed = new Set(current.changedPaths);
      const overlapping = current.changedPaths.filter(path => !sameRecord(baseline.get(path), now.get(path)));
      if (overlapping.length) throw operationError(`Agent-changed paths drifted: ${overlapping.join(", ")}`, "apply_blocked", { conflictPaths: overlapping });
      const driftPaths = unionKeys(baseline, now).filter(path => !changed.has(path) && !sameRecord(baseline.get(path), now.get(path)));
      if (driftPaths.length && (!allowContextDrift || expectedPatchHash !== current.patchHash)) throw operationError("Unrelated workspace context drift requires explicit confirmation with the current patch hash", "context_drift_confirmation_required", { patchHash: current.patchHash, driftPathCount: driftPaths.length });
      const patch = await readFile(jobArtifacts(current.cwd, current.id).patchPath, "utf8");
      if (createHash("sha256").update(patch).digest("hex") !== current.patchHash) throw operationError("Stored patch hash does not match job metadata", "artifact_corrupt");
      await git(["apply", "--check", "--binary", "-"], current.sourceRoot, { stdin: patch });
      try {
        await git(["apply", "--binary", "-"], current.sourceRoot, { stdin: patch });
        const appliedRecords = recordMap(await snapshotWorkspace(current.sourceRoot)), result = recordMap(current.resultRecords);
        const mismatched = current.changedPaths.filter(path => !sameRecord(result.get(path), appliedRecords.get(path)));
        if (mismatched.length) throw operationError(`Applied result verification failed: ${mismatched.join(", ")}`, "apply_verification_failed");
      } catch (error) {
        throw operationError(`Apply started but could not be verified; artifact retained for manual recovery: ${error.message}`, "partial_apply", { cause: error.message });
      }
      return { ...current, artifactStatus: "applied", phase: "applied", appliedAt: new Date().toISOString(), contextDriftDetected: driftPaths.length > 0, contextDriftPathCount: driftPaths.length, contextDriftConfirmed: driftPaths.length > 0 && allowContextDrift };
    }); } catch (error) {
      if (error.errorKind === "partial_apply") await transitionJob(workspaceRoot, job.id, ["completed"], current => ({ ...current, artifactStatus: "partial_apply", phase: "recovery_required", applyError: error.message, recoveryRequired: true, cleanupPending: false }));
      throw error;
    }
    return cleanupWriteArtifact(transition.record);
  });
}

export async function discardWriteArtifact({ workspaceRoot, jobId }) {
  return withWorkspaceLock(workspaceRoot, async () => {
    const job = await readJob(workspaceRoot, jobId);
    if (job.artifactStatus === "partial_apply" || job.recoveryRequired) throw operationError("Write artifact is retained for manual recovery and cannot be discarded", "manual_recovery_required");
    const transition = await transitionJob(workspaceRoot, job.id, ["completed", "failed", "cancelled", "timed_out"], current => {
      if (["applied", "discarded"].includes(current.artifactStatus)) return current;
      return { ...current, artifactStatus: "discarded", phase: "discarded", discardedAt: new Date().toISOString() };
    });
    if (!transition.changed) throw operationError(`Cannot discard a ${transition.record.status} write job`, "artifact_busy");
    return cleanupWriteArtifact(transition.record);
  });
}

export async function cleanupWriteArtifact(job) {
  const paths = [jobArtifacts(job.cwd, job.id).patchPath, job.settingsPath].filter(Boolean);
  try {
    if (job.isolatedRoot) await removeIsolatedWriteWorkspace({ isolatedRoot: job.isolatedRoot, artifactRoot: job.artifactRoot });
    await Promise.all(paths.map(path => rm(path, { force: true })));
    return (await transitionJob(job.cwd, job.id, [job.status], current => ({ ...current, cleanupPending: false, cleanupError: null, cleanedAt: new Date().toISOString() }))).record;
  } catch (error) {
    return (await transitionJob(job.cwd, job.id, [job.status], current => ({ ...current, cleanupPending: true, cleanupError: error.message }))).record;
  }
}

function recordMap(records = []) { return new Map(records.map(record => [record.path, record])); }
function sameRecord(left, right) { return JSON.stringify(left ?? null) === JSON.stringify(right ?? null); }
function unionKeys(left, right) { return [...new Set([...left.keys(), ...right.keys()])].sort(); }
function nulList(value) { return value.split("\0").filter(Boolean); }
function operationError(message, errorKind, details = {}) { return Object.assign(new Error(message), { errorKind, ...details }); }
async function git(args, cwd, { stdin } = {}) { const result = await runCommand("git", args, { cwd, stdin, env: trustedGitEnvironment() }); if (result.code !== 0) throw operationError(result.stderr.trim() || `git ${args[0]} failed`, "git_apply_failed"); return result; }

function trustedGitEnvironment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "GIT_CONFIG_PARAMETERS" && !/^GIT_CONFIG_(?:COUNT|KEY_|VALUE_)/.test(name)));
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: nullDevice, GIT_CONFIG_GLOBAL: nullDevice, GIT_ATTR_NOSYSTEM: "1" };
}
