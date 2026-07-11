import { runCommand } from "./process.mjs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
export const MAX_REVIEW_CONTEXT_BYTES = 256 * 1024;
export const MAX_INLINE_REVIEW_FILES = 2;
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
function lightweight(names) { return `[Diff omitted from prompt: ${names.length} files exceed the inline review limit. Inspect the listed files and git state with read-only tools.]\n\nChanged files:\n${names.map(name => `- ${name}`).join("\n")}`; }
export async function collectReviewContext({ cwd, base }) {
  if (base && (base.startsWith("-") || /[\0\r\n]/.test(base))) throw new Error("Review base must be a git ref, not an option or control character");
  const root = await findGitRoot(cwd), untracked = await untrackedFiles(root); let range, diff, trackedNames;
  if (base) {
    const mergeBase = await git(["merge-base", base, "HEAD"], root); range = `${mergeBase}..HEAD plus working tree`;
    const committed = await git(["diff", "--no-ext-diff", "--binary", mergeBase, "HEAD"], root), working = await git(["diff", "--no-ext-diff", "--binary", "HEAD"], root);
    diff = [committed, working].filter(Boolean).join("\n");
    trackedNames = [...nulList(await git(["diff", "--name-only", "-z", mergeBase, "HEAD"], root)), ...nulList(await git(["diff", "--name-only", "-z", "HEAD"], root))];
  } else {
    range = "working tree (staged, unstaged, and untracked)"; diff = await git(["diff", "--no-ext-diff", "--binary", "HEAD"], root);
    trackedNames = nulList(await git(["diff", "--name-only", "-z", "HEAD"], root));
  }
  const names = [...new Set([...trackedNames, ...untracked])].sort();
  if (names.length > MAX_INLINE_REVIEW_FILES || Buffer.byteLength(diff) > MAX_REVIEW_CONTEXT_BYTES) return { root, range, diff: lightweight(names), files: names, inline: false };
  const untrackedDiff = await untrackedPatch(root, untracked), combined = [diff, untrackedDiff].filter(Boolean).join("\n");
  return { root, range, diff: combined || "[No diff detected.]", files: names, inline: true };
}
