import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { findGitRoot } from "./git.mjs";
import { runCommand } from "./process.mjs";

const PLUGIN_DATA = process.env.PLUGIN_DATA ?? process.env.CLAUDE_PLUGIN_DATA;
export const WRITE_WORKSPACE_ROOT = process.env.CLAUDE_COMPANION_WRITE_ROOT ?? (PLUGIN_DATA ? join(PLUGIN_DATA, "write-workspaces") : join(homedir(), ".codex", "claude-companion", "write-workspaces"));
export const MAX_BASELINE_UNTRACKED_FILES = 10_000;
export const MAX_BASELINE_UNTRACKED_BYTES = 128 * 1024 * 1024;

export class UnsupportedRepositoryShapeError extends Error {
  constructor(reasons) {
    super(`Repository is not supported for isolated writes: ${reasons.join("; ")}`);
    this.name = "UnsupportedRepositoryShapeError";
    this.errorKind = "unsupported_repository_shape";
    this.reasons = reasons;
  }
}

export async function inspectRepositoryShape(sourceRoot) {
  const root = await canonicalGitRoot(sourceRoot), reasons = [];
  const sparse = await git(["config", "--bool", "core.sparseCheckout"], root, { allowFailure: true });
  if (sparse.code === 0 && sparse.stdout.trim() === "true") reasons.push("sparse checkout is not supported");
  const stage = await git(["ls-files", "--stage", "-z"], root);
  if (nulList(stage.stdout).some(record => record.startsWith("160000 "))) reasons.push("Git submodules are not supported");
  const filterAttributes = await gitAttributeFilesWithFilters(root);
  if (filterAttributes.length) reasons.push(`Git filters, including LFS, are not supported: ${filterAttributes.join(", ")}`);
  const head = await git(["rev-parse", "--verify", "HEAD"], root, { allowFailure: true });
  if (head.code !== 0) reasons.push("repository must have an initial commit");
  return { root, supported: reasons.length === 0, reasons, backend: "standalone-clone-v1" };
}

export async function createIsolatedWriteWorkspace({ sourceRoot, workspaceRoot = WRITE_WORKSPACE_ROOT, workspaceId }) {
  if (typeof workspaceId !== "string" || !/^[A-Za-z0-9_-]+$/.test(workspaceId)) throw new Error("workspaceId must contain only letters, numbers, underscore, or hyphen");
  const shape = await inspectRepositoryShape(sourceRoot);
  if (!shape.supported) throw new UnsupportedRepositoryShapeError(shape.reasons);
  const root = shape.root, isolatedRoot = resolve(workspaceRoot, workspaceId), artifactRoot = resolve(workspaceRoot, `${workspaceId}.artifact`), rootPrefix = `${resolve(workspaceRoot)}${sep}`;
  if (!isolatedRoot.startsWith(rootPrefix) || !artifactRoot.startsWith(rootPrefix)) throw new Error("Isolated workspace path escaped its root");
  await mkdir(workspaceRoot, { recursive: true });
  try {
    const sourceHead = (await git(["rev-parse", "HEAD"], root)).stdout.trim();
    const sourceStatus = (await git(["status", "--porcelain=v1", "-uall"], root)).stdout;
    const sourceSnapshot = await snapshotWorkspace(root);
    await successful("git", ["clone", "--quiet", "--no-local", "--no-hardlinks", "--no-checkout", root, isolatedRoot], { cwd: dirname(isolatedRoot) });
    await git(["checkout", "--quiet", "--detach", sourceHead], isolatedRoot);
    const patch = (await git(["diff", "--no-ext-diff", "--binary", "HEAD"], root)).stdout;
    if (patch) await git(["apply", "--binary", "-"], isolatedRoot, { stdin: patch });
    const untracked = nulList((await git(["ls-files", "--others", "--exclude-standard", "-z"], root)).stdout);
    if (untracked.length > MAX_BASELINE_UNTRACKED_FILES) throw new UnsupportedRepositoryShapeError([`untracked file count exceeds ${MAX_BASELINE_UNTRACKED_FILES}`]);
    let untrackedBytes = 0;
    for (const name of untracked) {
      const source = safeWorkspacePath(root, name), target = safeWorkspacePath(isolatedRoot, name), info = await lstat(source);
      if (info.isFile()) {
        untrackedBytes += info.size;
        if (untrackedBytes > MAX_BASELINE_UNTRACKED_BYTES) throw new UnsupportedRepositoryShapeError([`untracked bytes exceed ${MAX_BASELINE_UNTRACKED_BYTES}`]);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(source, target);
      } else if (info.isSymbolicLink()) {
        await mkdir(dirname(target), { recursive: true });
        await symlink(await readlink(source), target);
      } else throw new UnsupportedRepositoryShapeError([`untracked special file is not supported: ${name}`]);
    }
    const isolatedSnapshot = await snapshotWorkspace(isolatedRoot);
    if (JSON.stringify(isolatedSnapshot) !== JSON.stringify(sourceSnapshot)) throw new Error("Isolated baseline does not match the source working tree snapshot");
    await git(["config", "user.name", "cc-plugin-codex"], isolatedRoot);
    await git(["config", "user.email", "cc-plugin-codex@localhost"], isolatedRoot);
    await git(["add", "-A"], isolatedRoot);
    await git(["commit", "--quiet", "--allow-empty", "-m", "cc-plugin-codex isolated user baseline"], isolatedRoot);
    const baselineCommit = (await git(["rev-parse", "HEAD"], isolatedRoot)).stdout.trim();
    await successful("git", ["clone", "--quiet", "--no-local", "--no-hardlinks", isolatedRoot, artifactRoot], { cwd: dirname(artifactRoot) });
    if ((await git(["rev-parse", "HEAD"], artifactRoot)).stdout.trim() !== baselineCommit) throw new Error("Trusted artifact clone does not match the isolated baseline");
    const afterStatus = (await git(["status", "--porcelain=v1", "-uall"], root)).stdout;
    if (afterStatus !== sourceStatus || JSON.stringify(await snapshotWorkspace(root)) !== JSON.stringify(sourceSnapshot)) throw new Error("Source workspace changed while preparing isolated baseline");
    return { backend: "standalone-clone-v1", sourceRoot: root, isolatedRoot: await realpath(isolatedRoot), artifactRoot: await realpath(artifactRoot), sourceHead, sourceStatus, baselineCommit, baselineFingerprint: fingerprint(sourceSnapshot), baselineRecords: sourceSnapshot };
  } catch (error) {
    await Promise.all([isolatedRoot, artifactRoot].map(path => rm(path, { recursive: true, force: true })));
    throw error;
  }
}

export async function removeIsolatedWriteWorkspace(workspace) {
  if (!workspace?.isolatedRoot) throw new Error("isolatedRoot is required");
  await Promise.all([workspace.isolatedRoot, workspace.artifactRoot].filter(Boolean).map(path => rm(path, { recursive: true, force: true })));
}

export async function verifyIsolatedWriteWorkspaceForResume(job, { workspaceRoot = WRITE_WORKSPACE_ROOT } = {}) {
  if (!job?.sourceRoot || !job.isolatedRoot || !job.artifactRoot || !job.baselineCommit || !job.baselineFingerprint) throw writeResumeError("Write checkpoint is missing workspace identity");
  const canonicalRoot = await realpath(workspaceRoot).catch(() => null);
  const sourceRoot = await realpath(job.sourceRoot).catch(() => null);
  const isolatedRoot = await realpath(job.isolatedRoot).catch(() => null);
  const artifactRoot = await realpath(job.artifactRoot).catch(() => null);
  if (!canonicalRoot || !sourceRoot || !isolatedRoot || !artifactRoot) throw writeResumeError("Write checkpoint workspace is missing");
  if (!isContained(canonicalRoot, isolatedRoot) || !isContained(canonicalRoot, artifactRoot) || isolatedRoot === artifactRoot) throw writeResumeError("Write checkpoint workspace escaped its configured root");
  if (sourceRoot !== job.cwd) throw writeResumeError("Write checkpoint source identity changed");
  if (fingerprint(await snapshotWorkspace(sourceRoot)) !== job.baselineFingerprint) throw writeResumeError("Source workspace changed after the write checkpoint");
  if ((await git(["rev-parse", "HEAD"], isolatedRoot)).stdout.trim() !== job.baselineCommit) throw writeResumeError("Isolated workspace baseline commit changed");
  if ((await git(["rev-parse", "HEAD"], artifactRoot)).stdout.trim() !== job.baselineCommit) throw writeResumeError("Trusted artifact baseline commit changed");
  if ((await git(["status", "--porcelain=v1", "-uall"], artifactRoot)).stdout) throw writeResumeError("Trusted artifact workspace changed before completion");
  return { sourceRoot, isolatedRoot, artifactRoot };
}

export async function syncResultToTrustedArtifact({ isolatedRoot, artifactRoot, baselineRecords = [] }) {
  if (!isolatedRoot || !artifactRoot) throw new Error("isolatedRoot and artifactRoot are required");
  for (const entry of await readdir(artifactRoot, { withFileTypes: true })) if (entry.name !== ".git") await rm(join(artifactRoot, entry.name), { recursive: true, force: true });
  await copyTree(isolatedRoot, artifactRoot, { files: 0, bytes: 0, sourceRoot: isolatedRoot, baseline: new Map(baselineRecords.map(record => [record.path, record])) }, true);
}

export async function snapshotResultWorkspace(root, baselineRecords = []) {
  const records = [];
  await walkTree(root, "", records);
  const byPath = new Map(records.map(record => [record.path, record]));
  for (const record of baselineRecords) if (!byPath.has(record.path)) byPath.set(record.path, { path: record.path, type: "missing", mode: null, hash: null });
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export async function snapshotWorkspace(root) {
  const names = [...new Set(nulList((await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], root)).stdout))].sort(), records = [];
  for (const name of names) {
    const path = safeWorkspacePath(root, name);
    try {
      const info = await lstat(path);
      if (info.isFile()) records.push({ path: name, type: "file", mode: info.mode & 0o777, hash: createHash("sha256").update(await readFile(path)).digest("hex") });
      else if (info.isSymbolicLink()) records.push({ path: name, type: "symlink", mode: null, hash: createHash("sha256").update(await readlink(path)).digest("hex") });
      else records.push({ path: name, type: "special", mode: info.mode & 0o777, hash: null });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      records.push({ path: name, type: "missing", mode: null, hash: null });
    }
  }
  return records;
}

export function fingerprint(records) {
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

async function canonicalGitRoot(start) {
  const root = await realpath(await findGitRoot(start));
  return root;
}

function safeWorkspacePath(root, name) {
  if (!name || name.includes("\0")) throw new Error("Invalid Git path");
  const path = resolve(root, name), rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`Git path escapes workspace: ${name}`);
  return path;
}

function nulList(value) { return value.split("\0").filter(Boolean); }

async function copyTree(sourceRoot, targetRoot, quota, top = false) {
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    if (top && entry.name === ".git") continue;
    const source = join(sourceRoot, entry.name), target = join(targetRoot, entry.name), info = await lstat(source);
    if (info.isDirectory()) { await mkdir(target, { recursive: true }); await copyTree(source, target, quota); }
    else if (info.isFile()) { const name = portableRelative(quota.sourceRoot, source), hash = await hashFile(source); if (entry.name === ".gitattributes") assertNoFilterAttributes(await readFile(source, "utf8"), name); if (!sameTreeRecord(quota.baseline.get(name), { path: name, type: "file", mode: info.mode & 0o777, hash })) { quota.files += 1; quota.bytes += info.size; enforceResultQuota(quota); } await copyFile(source, target); await chmod(target, info.mode & 0o777); }
    else if (info.isSymbolicLink()) { const name = portableRelative(quota.sourceRoot, source), link = await readlink(source), record = { path: name, type: "symlink", mode: null, hash: createHash("sha256").update(link).digest("hex") }; if (!sameTreeRecord(quota.baseline.get(name), record)) { quota.files += 1; enforceResultQuota(quota); } await symlink(link, target); }
    else throw new UnsupportedRepositoryShapeError([`agent result contains unsupported special file: ${entry.name}`]);
  }
}

async function walkTree(root, prefix, records) {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (!prefix && entry.name === ".git") continue;
    const name = prefix ? `${prefix}/${entry.name}` : entry.name, path = join(root, name), info = await lstat(path);
    if (info.isDirectory()) await walkTree(root, name, records);
    else if (info.isFile()) records.push({ path: name, type: "file", mode: info.mode & 0o777, hash: createHash("sha256").update(await readFile(path)).digest("hex") });
    else if (info.isSymbolicLink()) records.push({ path: name, type: "symlink", mode: null, hash: createHash("sha256").update(await readlink(path)).digest("hex") });
    else records.push({ path: name, type: "special", mode: info.mode & 0o777, hash: null });
  }
}

function enforceResultQuota(quota) { if (quota.files > MAX_BASELINE_UNTRACKED_FILES || quota.bytes > MAX_BASELINE_UNTRACKED_BYTES) throw new UnsupportedRepositoryShapeError(["agent result exceeds write artifact quota"]); }
function sameTreeRecord(left, right) { return JSON.stringify(left ?? null) === JSON.stringify(right ?? null); }
function portableRelative(root, path) { return relative(root, path).split(sep).join("/"); }
function isContained(parent, child) { const path = relative(parent, child); return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path)); }
function writeResumeError(message) { return Object.assign(new Error(message), { errorKind: "write_resume_invalid" }); }
async function hashFile(path) { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }

async function gitAttributeFilesWithFilters(root) {
  const names = [...new Set(nulList((await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], root)).stdout))].filter(name => name === ".gitattributes" || name.endsWith("/.gitattributes"));
  const matches = [];
  for (const name of names) if (assertNoFilterAttributes(await readFile(safeWorkspacePath(root, name), "utf8"), name, false)) matches.push(name);
  return matches;
}

function assertNoFilterAttributes(content, label, throwOnMatch = true) {
  const matched = content.split(/\r?\n/).some(line => {
    const body = line.replace(/\\#.*$/, "").trim();
    if (!body || body.startsWith("#")) return false;
    return body.split(/\s+/).slice(1).some(attribute => /^(?:-filter|!filter|filter(?:=|$))/.test(attribute));
  });
  if (matched && throwOnMatch) throw new UnsupportedRepositoryShapeError([`Git filter attributes are not supported: ${label}`]);
  return matched;
}

async function git(args, cwd, { stdin, allowFailure = false } = {}) {
  const result = await runCommand("git", args, { cwd, stdin });
  if (!allowFailure && result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result;
}

async function successful(command, args, options) {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `${command} exited with ${result.code}`);
  return result;
}
