import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { boundedReviewManifest, collectReviewContext } from "../scripts/lib/git.mjs";

const companion = resolve("scripts/claude-companion.mjs");
const adapter = resolve("scripts/review-diff.mjs");

function exec(command, args, { cwd, env = process.env } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject); child.once("close", code => resolveRun({ code, stdout, stderr }));
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "claude-git-context-test-")), cwd = join(root, "workspace"), capture = join(root, "prompt.txt"), fake = join(root, "claude");
  await mkdir(cwd);
  for (const args of [["init", "--quiet"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test"]]) assert.equal((await exec("git", args, { cwd })).code, 0);
  await writeFile(join(cwd, "base.txt"), "base\n"); await exec("git", ["add", "base.txt"], { cwd }); await exec("git", ["commit", "--quiet", "-m", "base"], { cwd });
  await writeFile(fake, `#!/usr/bin/env node\nimport {writeFileSync} from "node:fs";writeFileSync(process.env.CAPTURE_PROMPT,process.argv.at(-1));console.log(JSON.stringify({type:"result",is_error:false,result:"reviewed",structured_output:{verdict:"approve",summary:"No findings",findings:[],next_steps:[],coverage:{files_examined:["a"],files_skipped:[],areas:["diff"]},uncertainty:"low",budget_exhausted:false,recommended_followup:{profile:"none",focus:[],reason:""}},session_id:"review-session"}));\n`); await chmod(fake, 0o755);
  return { cwd, capture, env: { ...process.env, CLAUDE_CODE_EXECUTABLE: fake, CAPTURE_PROMPT: capture } };
}

async function reviewPrompt(fx) {
  const result = await exec(process.execPath, [companion, "review", "--json"], fx);
  assert.equal(result.code, 0, result.stderr);
  return readFile(fx.capture, "utf8");
}

test("review includes an untracked-only text file", async () => {
  const fx = await fixture(); await writeFile(join(fx.cwd, "new-feature.js"), "export const feature = true;\n");
  const prompt = await reviewPrompt(fx);
  assert.match(prompt, /new-feature\.js/); assert.match(prompt, /export const feature = true/); assert.doesNotMatch(prompt, /No diff detected/);
});

test("review uses lightweight context when more than two files changed", async () => {
  const fx = await fixture();
  for (const name of ["one.js", "two.js", "three.js"]) await writeFile(join(fx.cwd, name), `const ${name[0]} = "SHOULD_NOT_INLINE";\n`);
  const prompt = await reviewPrompt(fx);
  assert.match(prompt, /Diff omitted from prompt/);
  for (const name of ["one.js", "two.js", "three.js"]) assert.match(prompt, new RegExp(name.replace(".", "\\.")));
  assert.doesNotMatch(prompt, /SHOULD_NOT_INLINE/);
  assert.match(prompt, /review-diff\.mjs/);
  assert.match(prompt, /do not use git -C/i);
});

test("large review manifests are bounded and report omissions", async () => {
  const fx = await fixture();
  for (let index = 0; index < 260; index += 1) await writeFile(join(fx.cwd, `file-${String(index).padStart(3, "0")}.js`), "export const changed = true;\n");
  const prompt = await reviewPrompt(fx);
  assert.match(prompt, /Changed files shown: 200 of 260/);
  assert.match(prompt, /Files omitted: 60/);
  assert.match(prompt, /Bounded diff stat:/);
  assert.doesNotMatch(prompt, /file-259\.js/);
});

test("100k changed paths keep the review manifest below its emergency envelope", () => {
  const names = Array.from({ length: 100_000 }, (_, index) => `src/generated/module-${String(index).padStart(6, "0")}.js`), manifest = boundedReviewManifest(names, "100000 files changed");
  assert.ok(Buffer.byteLength(manifest) < 40 * 1024);
  assert.match(manifest, /Changed files shown: 200 of 100000/);
  assert.match(manifest, /Files omitted: 99800/);
});

test("review diff adapter includes committed changes from an explicit base", async () => {
  const fx = await fixture(), base = (await exec("git", ["rev-parse", "HEAD"], fx)).stdout.trim();
  await writeFile(join(fx.cwd, "base.txt"), "committed change\n"); await exec("git", ["add", "base.txt"], fx); await exec("git", ["commit", "--quiet", "-m", "change"], fx);
  const result = await exec(process.execPath, [adapter, "--base", base, "--file", "base.txt", "--max-bytes", "4096"], fx);
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /committed change/);
});

test("untracked review fingerprints change with same-size same-mtime content", async () => {
  const fx = await fixture(), path = join(fx.cwd, "untracked.txt"), timestamp = new Date("2026-01-01T00:00:00Z");
  await writeFile(path, "aaaa"); await utimes(path, timestamp, timestamp); const first = await collectReviewContext({ cwd: fx.cwd });
  await writeFile(path, "bbbb"); await utimes(path, timestamp, timestamp); const second = await collectReviewContext({ cwd: fx.cwd });
  assert.notEqual(first.fingerprint, second.fingerprint);
});

test("review diff adapter returns bounded tracked patches and rejects unsafe paths", async () => {
  const fx = await fixture(); await writeFile(join(fx.cwd, "base.txt"), `changed\n${"x".repeat(4096)}\n`);
  const bounded = await exec(process.execPath, [adapter, "--file", "base.txt", "--max-bytes", "512"], fx);
  assert.equal(bounded.code, 0, bounded.stderr); assert.ok(Buffer.byteLength(bounded.stdout) < 640); assert.match(bounded.stdout, /omitted \d+ bytes/);
  const unsafe = await exec(process.execPath, [adapter, "--file", "../outside", "--max-bytes", "512"], fx);
  assert.equal(unsafe.code, 2); assert.match(unsafe.stderr, /outside repository/);
});
