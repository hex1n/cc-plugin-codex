import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const companion = resolve("scripts/claude-companion.mjs");

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
  await writeFile(fake, `#!/usr/bin/env node\nimport {writeFileSync} from "node:fs";writeFileSync(process.env.CAPTURE_PROMPT,process.argv.at(-1));console.log(JSON.stringify({type:"result",is_error:false,result:"reviewed",structured_output:{verdict:"approve",summary:"No findings",findings:[],next_steps:[]},session_id:"review-session"}));\n`); await chmod(fake, 0o755);
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
});
