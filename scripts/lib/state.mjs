import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const PLUGIN_DATA = process.env.PLUGIN_DATA ?? process.env.CLAUDE_PLUGIN_DATA;
export const STATE_ROOT = process.env.CLAUDE_COMPANION_STATE_ROOT ?? (PLUGIN_DATA ? join(PLUGIN_DATA, "jobs") : join(homedir(), ".codex", "claude-companion", "jobs"));
function key(cwd) { return createHash("sha256").update(cwd).digest("hex").slice(0, 16); }
function directoryFor(cwd) { return join(STATE_ROOT, key(cwd)); }
function pathFor(cwd, id) { return join(STATE_ROOT, key(cwd), `${safeId(id)}.json`); }
function requestPathFor(cwd, id) { return join(STATE_ROOT, key(cwd), `${safeId(id)}.request`); }
export async function createJob({ cwd, profile, resumeSessionId = null, promptMeta = null, write = false, model = null, effort = null, ownerSessionId = codexSessionId(), purpose = "user", namespace = null, disclosure = null, taskProfile = null, reviewProfile = null, maxTurns = null, finalizeAtTurn = null, maxBudgetUsd = null, metadata = {} }) {
  const id = randomUUID(), artifacts = jobArtifacts(cwd, id);
  const parent = resumeSessionId ? (await listJobs(cwd)).find(job => job.sessionId === resumeSessionId && ["completed", "failed"].includes(job.status)) : null;
  const priorChainCostUsd = parent ? (Number.isFinite(parent.cumulativeChainCostUsd) ? parent.cumulativeChainCostUsd : Number.isFinite(parent.totalCostUsd) ? parent.totalCostUsd : null) : 0;
  return saveJob({ recordVersion: 4, id, cwd, profile, purpose, namespace, disclosure, taskProfile, reviewProfile, maxTurns, finalizeAtTurn, maxBudgetUsd, write: Boolean(write), model, requestedModel: model, effectiveModels: null, effort, resumeSessionId, parentJobId: parent?.id ?? null, priorChainCostUsd, cumulativeChainCostUsd: null, ownerSessionId, operation: metadata.operation ?? null, reviewKind: metadata.reviewKind ?? null, subjectKind: metadata.subjectKind ?? null, subjectLabel: metadata.subjectLabel ?? null, subjectFingerprint: metadata.subjectFingerprint ?? null, transport: metadata.transport ?? null, capability: metadata.capability ?? null, evidenceLeaseEnabled: metadata.evidenceLeaseEnabled ?? false, evidenceLease: metadata.evidenceLease ?? null, evidenceLeaseExhausted: false, costBudgetExhausted: false, turnLimitReached: false, reviewControlRoot: metadata.reviewControlRoot ?? null, claudePid: null, sourceRoot: metadata.sourceRoot ?? null, isolatedRoot: metadata.isolatedRoot ?? null, artifactRoot: metadata.artifactRoot ?? null, workspaceBackend: metadata.workspaceBackend ?? null, sourceHead: metadata.sourceHead ?? null, sourceStatus: metadata.sourceStatus ?? null, baselineCommit: metadata.baselineCommit ?? null, baselineFingerprint: metadata.baselineFingerprint ?? null, baselineRecords: metadata.baselineRecords ?? null, settingsPath: metadata.settingsPath ?? null, sandboxRequired: metadata.sandboxRequired ?? false, sandboxVerified: metadata.sandboxVerified ?? false, sandboxPolicyHash: metadata.sandboxPolicyHash ?? null, sandboxPolicyVersion: metadata.sandboxPolicyVersion ?? null, claudeVersion: metadata.claudeVersion ?? null, claudeExecutableSha256: metadata.claudeExecutableSha256 ?? null, artifactStatus: metadata.artifactStatus ?? null, cleanupPending: false, pid: null, sessionId: null, status: "starting", promptName: promptMeta?.name ?? null, promptVersion: promptMeta?.version ?? null, promptHash: promptMeta?.hash ?? null, ...artifacts, createdAt: new Date().toISOString() });
}
export async function saveJob(record) {
  await mkdir(directoryFor(record.cwd), { recursive: true });
  const target = pathFor(record.cwd, record.id), temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
  return record;
}
export async function readJob(cwd, id) { return normalizeJob(JSON.parse(await readFile(pathFor(cwd, id), "utf8"))); }
export async function transitionJob(cwd, id, allowedStatuses, update) {
  const lock = `${pathFor(cwd, id)}.lock`;
  const lockToken = await acquireLock(lock);
  try {
    const current = await readJob(cwd, id);
    if (!allowedStatuses.includes(current.status)) return { record: current, changed: false };
    const next = await update(current);
    return { record: await saveJob(next), changed: true };
  } finally {
    await releaseLock(lock, lockToken);
  }
}
export async function withWorkspaceLock(cwd, operation) {
  const path = join(directoryFor(cwd), ".apply.lock");
  await mkdir(directoryFor(cwd), { recursive: true });
  const token = await acquireWorkspaceLock(path);
  try { return await operation(); }
  finally { await releaseWorkspaceLock(path, token); }
}
export async function writeJobRequest(job, request) { await writeFile(jobArtifacts(job.cwd, job.id).requestPath, `${JSON.stringify(request)}\n`, { encoding: "utf8", mode: 0o600 }); }
export async function takeJobRequest(job) { const path = jobArtifacts(job.cwd, job.id).requestPath, value = JSON.parse(await readFile(path, "utf8")); await unlink(path); return value; }
export async function listJobs(cwd) {
  let names;
  try { names = await readdir(directoryFor(cwd)); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const jobs = await Promise.all(names.filter(name => name.endsWith(".json")).map(async name => {
    const id = name.slice(0, -5);
    try { return await readJob(cwd, id); }
    catch (error) { return { id, cwd, profile: "unknown", status: "corrupt", pid: null, createdAt: new Date(0).toISOString(), error: `Could not parse persisted job JSON: ${error.message}` }; }
  }));
  return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function listGlobalJobs() {
  let directories;
  try { directories = await readdir(STATE_ROOT, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const groups = await Promise.all(directories.filter(entry => entry.isDirectory()).map(async entry => {
    const directory = join(STATE_ROOT, entry.name), names = await readdir(directory);
    return Promise.all(names.filter(name => name.endsWith(".json")).map(async name => {
      try { return normalizeJob(JSON.parse(await readFile(join(directory, name), "utf8"))); }
      catch (error) { return { recordVersion: 1, metadataCompleteness: "legacy-partial", id: name.slice(0, -5), cwd: null, profile: "unknown", purpose: "user", status: "corrupt", phase: null, pid: null, createdAt: new Date(0).toISOString(), error: `Could not parse persisted job JSON: ${error.message}` }; }
    }));
  }));
  return groups.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function deleteJob(record) {
  const artifacts = jobArtifacts(record.cwd, record.id), paths = [pathFor(record.cwd, record.id), artifacts.stdoutPath, artifacts.stderrPath, artifacts.eventsPath, artifacts.requestPath, artifacts.patchPath];
  await Promise.all(paths.map(path => unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; })));
}

export function codexSessionId(env = process.env) {
  for (const name of ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_TASK_ID"]) if (typeof env[name] === "string" && env[name].trim()) return env[name].trim();
  return null;
}

export function jobArtifacts(cwd, id) {
  const directory = directoryFor(cwd), safe = safeId(id);
  return { stdoutPath: join(directory, `${safe}.stdout.log`), stderrPath: join(directory, `${safe}.stderr.log`), eventsPath: join(directory, `${safe}.events.jsonl`), requestPath: requestPathFor(cwd, safe), patchPath: join(directory, `${safe}.patch`) };
}

function safeId(id) {
  if (typeof id !== "string" || !id || id === "." || id === ".." || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid job id");
  return id;
}

function normalizeJob(job) {
  const terminalPhase = { completed: "done", failed: "failed", cancelled: "cancelled", timed_out: "timed_out" }[job.status];
  const recordVersion = job.recordVersion ?? 1;
  return { recordVersion, metadataCompleteness: recordVersion >= 3 ? "complete" : "legacy-partial", purpose: job.purpose ?? (job.cwd?.includes("cc-plugin-codex-e2e") ? "e2e" : "user"), namespace: job.namespace ?? null, operation: null, reviewKind: null, subjectKind: null, subjectLabel: null, subjectFingerprint: null, transport: null, capability: null, evidenceLeaseEnabled: false, evidenceLease: null, evidenceLeaseExhausted: false, costBudgetExhausted: false, turnLimitReached: false, reviewControlRoot: null, claudePid: null, ...job, requestedModel: job.requestedModel ?? job.model ?? null, effectiveModels: job.effectiveModels ?? (job.modelUsage && typeof job.modelUsage === "object" ? Object.keys(job.modelUsage) : null), phase: job.phase ?? terminalPhase ?? null };
}

async function acquireLock(path) {
  const deadline = Date.now() + 5_000, token = randomUUID();
  while (true) {
    try { const handle = await open(path, "wx", 0o600); await handle.writeFile(token); await handle.close(); return token; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const info = await stat(path).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 30_000) await unlink(path).catch(() => {});
      if (Date.now() >= deadline) throw new Error("Timed out acquiring job state lock");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

async function releaseLock(path, token) {
  const owner = await readFile(path, "utf8").catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
  if (owner === token) await unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; });
}

async function acquireWorkspaceLock(path) {
  const deadline = Date.now() + 10_000, token = randomUUID();
  while (true) {
    try { const handle = await open(path, "wx", 0o600); await handle.writeFile(JSON.stringify({ token, pid: process.pid })); await handle.close(); return token; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = await readFile(path, "utf8").then(JSON.parse).catch(() => null);
      if (!owner?.pid || !processRunning(owner.pid)) await unlink(path).catch(() => {});
      else if (Date.now() >= deadline) throw new Error("Timed out acquiring workspace apply lock");
      else await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}
async function releaseWorkspaceLock(path, token) { const owner = await readFile(path, "utf8").then(JSON.parse).catch(() => null); if (owner?.token === token) await unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; }); }
function processRunning(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } }
