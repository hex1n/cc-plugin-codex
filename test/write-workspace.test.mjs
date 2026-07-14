import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, readFile, readlink, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import { createIsolatedWriteWorkspace, inspectRepositoryShape, removeIsolatedWriteWorkspace } from "../scripts/lib/write-workspace.mjs";

function exec(command, args, cwd, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; }); child.once("error", reject); child.once("close", code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} ${args.join(" ")} failed: ${stderr}`))); if (stdin !== undefined) child.stdin.end(stdin);
  });
}

async function repoFixture() {
  const root = await mkdtemp(join(tmpdir(), "write-workspace-test-")), source = join(root, "source"), workspaces = join(root, "workspaces");
  await mkdir(source); await exec("git", ["init", "--quiet"], source); await exec("git", ["config", "user.email", "test@example.invalid"], source); await exec("git", ["config", "user.name", "Test"], source);
  await writeFile(join(source, ".gitignore"), ".env\nnode_modules/\n");
  await writeFile(join(source, "staged.txt"), "staged-base\n"); await writeFile(join(source, "unstaged.txt"), "unstaged-base\n"); await writeFile(join(source, "delete.txt"), "delete-base\n"); await writeFile(join(source, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(source, "executable.sh"), "#!/bin/sh\necho base\n"); await chmod(join(source, "executable.sh"), 0o644);
  await exec("git", ["add", "-A"], source); await exec("git", ["commit", "--quiet", "-m", "base"], source);
  await writeFile(join(source, "staged.txt"), "staged-user\n"); await exec("git", ["add", "staged.txt"], source);
  await writeFile(join(source, "unstaged.txt"), "unstaged-user\n"); await unlink(join(source, "delete.txt")); await writeFile(join(source, "binary.bin"), Buffer.from([9, 0, 8, 0, 7])); await chmod(join(source, "executable.sh"), 0o755);
  await writeFile(join(source, "untracked.txt"), "untracked-user\n"); await symlink("unstaged.txt", join(source, "untracked-link")); await writeFile(join(source, ".env"), "SECRET=do-not-copy\n");
  return { root, source, workspaces };
}

test("standalone isolated workspace reproduces dirty Git state without touching the source", async () => {
  const fx = await repoFixture(), statusBefore = (await exec("git", ["status", "--porcelain=v1", "-uall"], fx.source)).stdout;
  const isolated = await createIsolatedWriteWorkspace({ sourceRoot: fx.source, workspaceRoot: fx.workspaces, workspaceId: "job-1" });
  assert.equal(isolated.backend, "standalone-clone-v1");
  assert.equal((await exec("git", ["status", "--porcelain=v1", "-uall"], fx.source)).stdout, statusBefore);
  assert.equal(await readFile(join(isolated.isolatedRoot, "staged.txt"), "utf8"), "staged-user\n");
  assert.equal(await readFile(join(isolated.isolatedRoot, "unstaged.txt"), "utf8"), "unstaged-user\n");
  await assert.rejects(() => stat(join(isolated.isolatedRoot, "delete.txt")), error => error.code === "ENOENT");
  assert.deepEqual(await readFile(join(isolated.isolatedRoot, "binary.bin")), Buffer.from([9, 0, 8, 0, 7]));
  assert.equal((await stat(join(isolated.isolatedRoot, "executable.sh"))).mode & 0o111, 0o111);
  assert.equal(await readFile(join(isolated.isolatedRoot, "untracked.txt"), "utf8"), "untracked-user\n");
  assert.equal(await readlink(join(isolated.isolatedRoot, "untracked-link")), "unstaged.txt");
  await assert.rejects(() => stat(join(isolated.isolatedRoot, ".env")), error => error.code === "ENOENT");
  await assert.rejects(() => stat(join(isolated.isolatedRoot, ".git", "objects", "info", "alternates")), error => error.code === "ENOENT");
  assert.equal((await exec("git", ["status", "--porcelain=v1", "-uall"], isolated.isolatedRoot)).stdout, "");
  assert.match(isolated.baselineFingerprint, /^[a-f0-9]{64}$/);
  await removeIsolatedWriteWorkspace(isolated);
  await assert.rejects(() => lstat(isolated.isolatedRoot), error => error.code === "ENOENT");
});

test("repository shape gate rejects submodules, sparse checkout, and LFS before isolation", async () => {
  const submodule = await repoFixture(), head = (await exec("git", ["rev-parse", "HEAD"], submodule.source)).stdout.trim();
  await exec("git", ["update-index", "--add", "--cacheinfo", `160000,${head},vendor/submodule`], submodule.source);
  assert.equal((await inspectRepositoryShape(submodule.source)).supported, false);

  const sparse = await repoFixture(); await exec("git", ["config", "core.sparseCheckout", "true"], sparse.source);
  assert.match((await inspectRepositoryShape(sparse.source)).reasons.join(" "), /sparse/i);

  const lfs = await repoFixture(); await writeFile(join(lfs.source, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  assert.match((await inspectRepositoryShape(lfs.source)).reasons.join(" "), /LFS/i);
});

test("versioned repository and backend support matrices match the implementation", async () => {
  const shapes = JSON.parse(await readFile(resolve("config/repository-shape-support.json"), "utf8")), backend = JSON.parse(await readFile(resolve("config/write-backend-evidence.json"), "utf8"));
  assert.equal(shapes.schemaVersion, 1); assert.equal(shapes.backend, "standalone-clone-v1"); assert.match(shapes.rejectedBeforeClaude.join(" "), /submodule.*sparse.*LFS/i);
  assert.equal(backend.defaultBackend, "standalone-clone-v1"); assert.equal(backend.worktreeAuthorized, false); assert.equal(backend.properties.alternatesAbsent, true);
});
