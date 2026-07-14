import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { collectPlanReviewTarget } from "../scripts/lib/plan-review-target.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "plan-review-target-"));
  await command("git", ["init", "--quiet"], root);
  await mkdir(join(root, "docs", "plans"), { recursive: true });
  await writeFile(join(root, "docs", "plans", "a.md"), "# Plan\n\nShip safely.\n");
  return root;
}

test("collects one immutable UTF-8 file relative to the Git root", async () => {
  const root = await fixture();
  const target = await collectPlanReviewTarget({ cwd: join(root, "docs"), targetFile: "docs/plans/a.md" });
  assert.equal(target.root, await realpath(root));
  assert.equal(target.label, "docs/plans/a.md");
  assert.equal(target.content, "# Plan\n\nShip safely.\n");
  assert.match(target.fingerprint, /^[a-f0-9]{64}$/);
  const absolute = await collectPlanReviewTarget({ cwd: root, targetFile: join(root, "docs", "plans", "a.md") });
  assert.equal(absolute.fingerprint, target.fingerprint);
});

test("allows in-root symlinks but rejects path and symlink escapes", async () => {
  const root = await fixture(), outside = join(root, "..", `outside-${Date.now()}.md`);
  await symlink("a.md", join(root, "docs", "plans", "alias.md"));
  assert.equal((await collectPlanReviewTarget({ cwd: root, targetFile: "docs/plans/alias.md" })).label, "docs/plans/a.md");
  await writeFile(outside, "outside\n");
  await symlink(outside, join(root, "docs", "plans", "escape.md"));
  await assert.rejects(() => collectPlanReviewTarget({ cwd: root, targetFile: "../outside.md" }), /outside/i);
  await assert.rejects(() => collectPlanReviewTarget({ cwd: root, targetFile: "docs/plans/escape.md" }), /outside/i);
});

test("rejects directories, empty/NUL/invalid UTF-8, and oversized files", async () => {
  const root = await fixture();
  await writeFile(join(root, "empty.md"), "");
  await writeFile(join(root, "nul.md"), Buffer.from("a\0b"));
  await writeFile(join(root, "invalid.md"), Buffer.from([0xc3, 0x28]));
  await writeFile(join(root, "large.md"), "x".repeat(256 * 1024 + 1));
  await assert.rejects(() => collectPlanReviewTarget({ cwd: root, targetFile: "." }), /regular file/i);
  await assert.rejects(() => collectPlanReviewTarget({ cwd: root, targetFile: "empty.md" }), /empty/i);
  await assert.rejects(() => collectPlanReviewTarget({ cwd: root, targetFile: "nul.md" }), /NUL/i);
  await assert.rejects(() => collectPlanReviewTarget({ cwd: root, targetFile: "invalid.md" }), /UTF-8/i);
  await assert.rejects(() => collectPlanReviewTarget({ cwd: root, targetFile: "large.md" }), /262144/);
});

function command(executable, args, cwd) {
  return new Promise((resolve, reject) => { const child = spawn(executable, args, { cwd, shell: false, stdio: "ignore" }); child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(new Error(`${executable} exited ${code}`))); });
}
