#!/usr/bin/env node
import { parseArgs } from "node:util";
import { lstat, open } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { findGitRoot } from "./lib/git.mjs";
import { runCommand } from "./lib/process.mjs";

const HARD_MAX_BYTES = 256 * 1024;
const HARD_MAX_FILES = 10;

try {
  const { values } = parseArgs({ options: { file: { type: "string", multiple: true }, base: { type: "string", default: "HEAD" }, "max-bytes": { type: "string", default: "65536" } }, allowPositionals: false });
  const files = values.file ?? [];
  const maxBytes = Number(values["max-bytes"]);
  const base = values.base;
  if (!files.length || files.length > HARD_MAX_FILES) throw new Error(`--file is required and may be repeated at most ${HARD_MAX_FILES} times`);
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > HARD_MAX_BYTES) throw new Error(`--max-bytes must be an integer between 1 and ${HARD_MAX_BYTES}`);
  if (!base || base.startsWith("-") || /[\0\r\n]/.test(base)) throw new Error("--base must be a git ref, not an option or control character");
  const root = await findGitRoot(process.cwd()), blocks = [];
  for (const name of files) blocks.push(await patchFor(root, name, base, maxBytes));
  const output = blocks.join("\n"), bytes = Buffer.from(output);
  if (bytes.length <= maxBytes) process.stdout.write(output);
  else process.stdout.write(`${bytes.subarray(0, maxBytes).toString("utf8")}\n[Review diff adapter omitted ${bytes.length - maxBytes} bytes.]\n`);
} catch (error) {
  process.stderr.write(`review-diff: ${error.message}\n`);
  process.exitCode = 2;
}

async function patchFor(root, name, base, maxBytes) {
  if (!name || name.startsWith("-") || /[\0\r\n]/.test(name)) throw new Error("unsafe file path");
  const path = resolve(root, name), prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!path.startsWith(prefix)) throw new Error(`file is outside repository: ${name}`);
  const tracked = await runCommand("git", ["ls-files", "--error-unmatch", "--", name], { cwd: root });
  if (tracked.code === 0) {
    const result = await runCommand("git", ["diff", "--no-ext-diff", "--binary", base, "--", name], { cwd: root, maxOutputBytes: maxBytes });
    if (result.code !== 0) throw new Error(result.stderr.trim() || `git diff failed for ${name}`);
    return `${result.stdout || `[No tracked diff for ${name}]`}${result.stdoutTruncated ? "\n[Tracked diff truncated by adapter.]" : ""}`;
  }
  const stat = await lstat(path);
  if (!stat.isFile()) return `[Untracked non-file: ${name}]`;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(maxBytes, HARD_MAX_BYTES)), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0), content = buffer.subarray(0, bytesRead);
    if (content.includes(0)) return `[Untracked binary file: ${name}]`;
    const suffix = stat.size > bytesRead ? `\n[Untracked file truncated by adapter; ${stat.size - bytesRead} bytes omitted.]` : "";
    return `diff --git a/${name} b/${name}\nnew file\n--- /dev/null\n+++ b/${name}\n@@ untracked file @@\n${content.toString("utf8")}${suffix}`;
  } finally { await handle.close(); }
}
