import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { findWorkspaceRoot } from "./git.mjs";

export const PLAN_REVIEW_MAX_BYTES = 256 * 1024;

export async function collectPlanReviewTarget({ cwd, targetFile, maxBytes = PLAN_REVIEW_MAX_BYTES }) {
  if (typeof targetFile !== "string" || !targetFile.trim()) throw new Error("Plan review requires target_file");
  if (targetFile.includes("\0")) throw new Error("Plan review target path contains NUL");
  const root = await realpath(await findWorkspaceRoot(cwd));
  const candidate = resolve(root, targetFile);
  if (!isAbsolute(targetFile)) ensureContained(root, candidate);
  let target;
  try { target = await realpath(candidate); }
  catch (error) { throw new Error(`Plan review target cannot be resolved: ${error.message}`); }
  ensureContained(root, target);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("Plan review target must be a regular file");
  if (info.size === 0) throw new Error("Plan review target must not be empty");
  if (info.size > maxBytes) throw new Error(`Plan review target exceeds ${maxBytes} bytes`);
  const bytes = await readFile(target);
  if (bytes.length > maxBytes) throw new Error(`Plan review target exceeds ${maxBytes} bytes`);
  if (bytes.includes(0)) throw new Error("Plan review target contains NUL bytes");
  let content;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("Plan review target must contain valid UTF-8"); }
  const label = relative(root, target).split(sep).join("/");
  return Object.freeze({ root, path: target, label, content, size: bytes.length, fingerprint: createHash("sha256").update(bytes).digest("hex") });
}

function ensureContained(root, target) {
  const path = relative(root, target);
  if (path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))) return;
  throw new Error("Plan review target is outside the repository root");
}
