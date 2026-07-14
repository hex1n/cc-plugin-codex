import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

test("write artifacts apply explicitly, block overlap, confirm context drift, and discard", async () => {
  const root = await mkdtemp(join(tmpdir(), "write-apply-test-"));
  process.env.CLAUDE_COMPANION_STATE_ROOT = join(root, "state");
  const { createJob, readJob, saveJob } = await import("../scripts/lib/state.mjs");
  const { createIsolatedWriteWorkspace } = await import("../scripts/lib/write-workspace.mjs");
  const { applyWriteArtifact, discardWriteArtifact, finalizeWriteArtifact } = await import("../scripts/lib/patch-artifact.mjs");
  const source = join(root, "source"), workspaces = join(root, "workspaces");
  await mkdir(source); await command("git", ["init", "--quiet"], source); await command("git", ["config", "user.email", "test@example.invalid"], source); await command("git", ["config", "user.name", "Test"], source);
  await writeFile(join(source, "agent.txt"), "base\n"); await writeFile(join(source, "context.txt"), "context\n"); await command("git", ["add", "-A"], source); await command("git", ["commit", "--quiet", "-m", "base"], source);

  async function artifact(id, text, beforeFinalize = async () => {}) {
    const isolated = await createIsolatedWriteWorkspace({ sourceRoot: source, workspaceRoot: workspaces, workspaceId: id });
    await writeFile(join(isolated.isolatedRoot, "agent.txt"), text);
    await writeFile(join(isolated.isolatedRoot, `${id}.txt`), `${id}\n`);
    await beforeFinalize(isolated);
    let job = await createJob({ cwd: isolated.sourceRoot, profile: "task", write: true, metadata: { sourceRoot: isolated.sourceRoot, isolatedRoot: isolated.isolatedRoot, artifactRoot: isolated.artifactRoot, baselineCommit: isolated.baselineCommit, baselineRecords: isolated.baselineRecords, artifactStatus: "running" } });
    try { return await saveJob({ ...job, status: "completed", phase: "awaiting_apply", ...(await finalizeWriteArtifact(job)) }); }
    catch (error) { await saveJob({ ...job, status: "failed", phase: "failed", error: error.message }); await discardWriteArtifact({ workspaceRoot: job.cwd, jobId: job.id }); throw error; }
  }

  const runningWorkspace = await createIsolatedWriteWorkspace({ sourceRoot: source, workspaceRoot: workspaces, workspaceId: "running" });
  const running = await createJob({ cwd: runningWorkspace.sourceRoot, profile: "task", write: true, metadata: { sourceRoot: runningWorkspace.sourceRoot, isolatedRoot: runningWorkspace.isolatedRoot, artifactRoot: runningWorkspace.artifactRoot, baselineCommit: runningWorkspace.baselineCommit, baselineRecords: runningWorkspace.baselineRecords, artifactStatus: "running" } });
  await saveJob({ ...running, status: "running", phase: "executing" });
  await assert.rejects(() => discardWriteArtifact({ workspaceRoot: running.cwd, jobId: running.id }), error => error.errorKind === "artifact_busy");
  assert.equal((await stat(runningWorkspace.isolatedRoot)).isDirectory(), true);
  await saveJob({ ...running, status: "cancelled", phase: "cancelled" });
  await discardWriteArtifact({ workspaceRoot: running.cwd, jobId: running.id });
  await assert.rejects(() => stat(runningWorkspace.isolatedRoot), error => error.code === "ENOENT");

  const clean = await artifact("clean", "agent change\n");
  assert.equal(await readFile(join(source, "agent.txt"), "utf8"), "base\n");
  const applied = await applyWriteArtifact({ workspaceRoot: clean.cwd, jobId: clean.id });
  assert.equal(applied.artifactStatus, "applied");
  assert.equal(await readFile(join(source, "agent.txt"), "utf8"), "agent change\n");
  assert.equal(await readFile(join(source, "clean.txt"), "utf8"), "clean\n");
  await assert.rejects(() => stat(clean.isolatedRoot), error => error.code === "ENOENT");

  await command("git", ["add", "-A"], source); await command("git", ["commit", "--quiet", "-m", "applied"], source);
  const conflict = await artifact("conflict", "agent second\n");
  await writeFile(join(source, "agent.txt"), "user concurrent\n");
  await assert.rejects(() => applyWriteArtifact({ workspaceRoot: conflict.cwd, jobId: conflict.id }), error => error.errorKind === "apply_blocked");
  assert.equal(await readFile(join(source, "agent.txt"), "utf8"), "user concurrent\n");
  await discardWriteArtifact({ workspaceRoot: conflict.cwd, jobId: conflict.id });

  await writeFile(join(source, "agent.txt"), "agent change\n");
  const drift = await artifact("drift", "agent third\n");
  await writeFile(join(source, "context.txt"), "user context drift\n");
  await assert.rejects(() => applyWriteArtifact({ workspaceRoot: drift.cwd, jobId: drift.id }), error => error.errorKind === "context_drift_confirmation_required" && error.patchHash === drift.patchHash);
  assert.equal(await readFile(join(source, "agent.txt"), "utf8"), "agent change\n");
  await assert.rejects(() => applyWriteArtifact({ workspaceRoot: drift.cwd, jobId: drift.id, allowContextDrift: true, expectedPatchHash: "wrong" }), error => error.errorKind === "patch_hash_mismatch");
  const confirmed = await applyWriteArtifact({ workspaceRoot: drift.cwd, jobId: drift.id, allowContextDrift: true, expectedPatchHash: drift.patchHash });
  assert.equal(confirmed.contextDriftConfirmed, true);
  assert.equal(await readFile(join(source, "agent.txt"), "utf8"), "agent third\n");
  assert.equal(await readFile(join(source, "context.txt"), "utf8"), "user context drift\n");

  const marker = join(root, "host-filter-marker"), globalConfig = join(root, "global-gitconfig");
  await writeFile(globalConfig, `[filter "evil"]\n\tclean = sh -c 'touch ${marker}'\n\trequired = true\n`);
  const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL; process.env.GIT_CONFIG_GLOBAL = globalConfig;
  try { await assert.rejects(() => artifact("hostile", "safe result\n", async isolated => {
      await writeFile(join(isolated.isolatedRoot, ".gitattributes"), "agent.txt filter=evil\n");
      await writeFile(join(isolated.isolatedRoot, ".git", "config"), `[core]\n\trepositoryformatversion = 0\n[filter "evil"]\n\tclean = sh -c 'touch ${marker}'\n\trequired = true\n`);
    }), error => error.name === "UnsupportedRepositoryShapeError"); }
  finally { if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig; }
  await assert.rejects(() => stat(marker), error => error.code === "ENOENT");

  const deletion = await artifact("deletion", "unused\n", async isolated => { await unlink(join(isolated.isolatedRoot, "agent.txt")); });
  const deleted = await applyWriteArtifact({ workspaceRoot: deletion.cwd, jobId: deletion.id });
  assert.equal(deleted.artifactStatus, "applied");
  await assert.rejects(() => stat(join(source, "agent.txt")), error => error.code === "ENOENT");

  const raceA = await artifact("race-a", "race A\n"), raceB = await artifact("race-b", "race B\n");
  const race = await Promise.allSettled([applyWriteArtifact({ workspaceRoot: raceA.cwd, jobId: raceA.id }), applyWriteArtifact({ workspaceRoot: raceB.cwd, jobId: raceB.id })]);
  assert.equal(race.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(race.filter(result => result.status === "rejected" && result.reason.errorKind === "apply_blocked").length, 1);
  const loser = race[0].status === "rejected" ? raceA : raceB; await discardWriteArtifact({ workspaceRoot: loser.cwd, jobId: loser.id });

  const recovery = await artifact("recovery", "recovery result\n"), corrupted = { ...recovery, resultRecords: recovery.resultRecords.map(record => record.path === "agent.txt" ? { ...record, hash: "0".repeat(64) } : record) };
  await saveJob(corrupted);
  await assert.rejects(() => applyWriteArtifact({ workspaceRoot: recovery.cwd, jobId: recovery.id }), error => error.errorKind === "partial_apply");
  const recoveryState = await readJob(recovery.cwd, recovery.id);
  assert.equal(recoveryState.artifactStatus, "partial_apply"); assert.equal(recoveryState.phase, "recovery_required"); assert.equal(recoveryState.recoveryRequired, true); assert.equal(recoveryState.cleanupPending, false);
  assert.equal(await readFile(join(source, "agent.txt"), "utf8"), "recovery result\n");
  await assert.rejects(() => discardWriteArtifact({ workspaceRoot: recovery.cwd, jobId: recovery.id }), error => error.errorKind === "manual_recovery_required");
  assert.equal((await stat(recovery.isolatedRoot)).isDirectory(), true);
});

function command(executable, args, cwd) { return new Promise((resolve, reject) => { const child = spawn(executable, args, { cwd, shell: false, stdio: "ignore" }); child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(new Error(`${executable} exited ${code}`))); }); }
