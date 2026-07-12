import { runCommand } from "./process.mjs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
export const MAX_REVIEW_CONTEXT_BYTES = 256 * 1024;
export const MAX_INLINE_REVIEW_FILES = 2;
export const MAX_REVIEW_MANIFEST_BYTES = 32 * 1024;
export const MAX_REVIEW_MANIFEST_FILES = 200;
const MAX_UNTRACKED_BYTES = 24 * 1024;
async function git(args, cwd) { const result = await runCommand("git", args, { cwd }); if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`); return result.stdout.trimEnd(); }
export async function findGitRoot(cwd) { return git(["rev-parse", "--show-toplevel"], cwd); }
export async function findWorkspaceRoot(cwd) { try { return await findGitRoot(cwd); } catch { try { return await realpath(cwd); } catch { return resolve(cwd); } } }
function nulList(value) { return value.split("\0").filter(Boolean); }
async function untrackedFiles(root) {
  const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root);
  return nulList(status).filter(entry => entry.startsWith("?? ")).map(entry => entry.slice(3)).sort();
}
async function untrackedPatch(root, names) {
  const blocks = [];
  for (const name of names) {
    const path = resolve(root, name), rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
    if (!path.startsWith(rootPrefix)) { blocks.push(`[Skipped unsafe untracked path: ${name}]`); continue; }
    try {
      const stat = await lstat(path);
      if (!stat.isFile()) { blocks.push(`[Untracked non-file: ${name}]`); continue; }
      const bytes = await readFile(path);
      if (bytes.includes(0)) { blocks.push(`[Untracked binary file: ${name}]`); continue; }
      const content = bytes.subarray(0, MAX_UNTRACKED_BYTES).toString("utf8"), suffix = bytes.length > MAX_UNTRACKED_BYTES ? `\n[Content omitted after ${MAX_UNTRACKED_BYTES} bytes.]` : "";
      blocks.push(`diff --git a/${name} b/${name}\nnew file\n--- /dev/null\n+++ b/${name}\n@@ untracked file @@\n${content}${suffix}`);
    } catch { blocks.push(`[Unreadable untracked file: ${name}]`); }
  }
  return blocks.join("\n");
}
export function boundedReviewManifest(names, diffStat) {
  const shown = [];
  let bytes = 0;
  for (const name of names) {
    if (shown.length >= MAX_REVIEW_MANIFEST_FILES) break;
    const line = `- ${name}\n`, next = Buffer.byteLength(line);
    if (bytes + next > MAX_REVIEW_MANIFEST_BYTES) break;
    shown.push(name); bytes += next;
  }
  const omitted = names.length - shown.length;
  return `[Diff omitted from prompt: ${names.length} files exceed the inline review limit. Use the bounded read-only review adapter for focused patches.]\nChanged files shown: ${shown.length} of ${names.length}\nFiles omitted: ${omitted}\n\nBounded diff stat:\n${diffStat || "[No tracked diff stat available.]"}\n\nChanged file sample:\n${shown.map(name => `- ${name}`).join("\n")}`;
}
export async function collectReviewContext({ cwd, base }) {
  if (base && (base.startsWith("-") || /[\0\r\n]/.test(base))) throw new Error("Review base must be a git ref, not an option or control character");
  const root = await findGitRoot(cwd), untracked = await untrackedFiles(root); let range, diff, trackedNames, adapterBase;
  if (base) {
    const mergeBase = await git(["merge-base", base, "HEAD"], root); range = `${mergeBase}..HEAD plus working tree`; adapterBase = mergeBase;
    const committed = await git(["diff", "--no-ext-diff", "--binary", mergeBase, "HEAD"], root), working = await git(["diff", "--no-ext-diff", "--binary", "HEAD"], root);
    diff = [committed, working].filter(Boolean).join("\n");
    trackedNames = [...nulList(await git(["diff", "--name-only", "-z", mergeBase, "HEAD"], root)), ...nulList(await git(["diff", "--name-only", "-z", "HEAD"], root))];
  } else {
    range = "working tree (staged, unstaged, and untracked)"; adapterBase = "HEAD"; diff = await git(["diff", "--no-ext-diff", "--binary", "HEAD"], root);
    trackedNames = nulList(await git(["diff", "--name-only", "-z", "HEAD"], root));
  }
  const names = [...new Set([...trackedNames, ...untracked])].sort();
  const fingerprint = await reviewFingerprint(root, range, diff, names, untracked);
  if (names.length > MAX_INLINE_REVIEW_FILES || Buffer.byteLength(diff) > MAX_REVIEW_CONTEXT_BYTES) {
    const stat = await runCommand("git", ["diff", "--stat=120,80", adapterBase], { cwd: root, maxOutputBytes: 8 * 1024 });
    if (stat.code !== 0) throw new Error(stat.stderr.trim() || "git diff --stat failed");
    const diffStat = `${stat.stdout.trimEnd()}${stat.stdoutTruncated ? "\n[Diff stat truncated.]" : ""}`;
    return { root, range, diff: boundedReviewManifest(names, diffStat), files: names, inline: false, fingerprint, adapterBase };
  }
  const untrackedDiff = await untrackedPatch(root, untracked), combined = [diff, untrackedDiff].filter(Boolean).join("\n");
  return { root, range, diff: combined || "[No diff detected.]", files: names, inline: true, fingerprint, adapterBase };
}

async function reviewFingerprint(root, range, diff, names, untracked) {
  const hash = createHash("sha256").update(root).update("\0").update(range).update("\0").update(diff).update("\0").update(names.join("\0"));
  for (const name of untracked) {
    try {
      const path = resolve(root, name), stat = await lstat(path);
      hash.update("\0").update(JSON.stringify([name, stat.size, stat.mtimeMs]));
      if (stat.isFile()) for await (const chunk of createReadStream(path)) hash.update(chunk);
    } catch { hash.update("\0").update(JSON.stringify([name, null, null])); }
  }
  return hash.digest("hex");
}
