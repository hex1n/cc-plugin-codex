import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const companion = resolve("scripts/claude-companion.mjs");
function run(args, { cwd, env }) { return new Promise((resolveRun, reject) => { const child = spawn(process.execPath, [companion, ...args], { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; }); child.once("error", reject); child.once("close", code => resolveRun({ code, stdout, stderr })); }); }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "claude-resume-test-")), cwd = join(root, "workspace"), state = join(root, "state"), invocation = join(root, "args.json"), fake = join(root, "claude");
  await mkdir(cwd);
  await writeFile(fake, `#!/usr/bin/env node\nimport {writeFileSync} from "node:fs"; const args=process.argv.slice(2); writeFileSync(process.env.FAKE_ARGS,JSON.stringify(args)); console.log(JSON.stringify({type:"result",is_error:false,result:"resumed",session_id:"continued-session"}));\n`);
  await chmod(fake, 0o755);
  return { root, cwd, state, invocation, env: { ...process.env, CLAUDE_CODE_EXECUTABLE: fake, CLAUDE_COMPANION_STATE_ROOT: state, FAKE_ARGS: invocation } };
}

test("foreground task forwards a resume session before the prompt separator", async () => {
  const fx = await fixture(), result = await run(["task", "continue work", "--resume", "source-session", "--json"], fx);
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).result, "resumed");
  const args = JSON.parse(await readFile(fx.invocation, "utf8")), resume = args.indexOf("--resume"), separator = args.indexOf("--");
  assert.ok(resume > 0); assert.equal(args[resume + 1], "source-session"); assert.ok(separator > resume); assert.match(args[separator + 1], /<task>\s*continue work[\s\S]*Beginning with turn 6/);
});

test("background task persists and forwards its resume session", async () => {
  const fx = await fixture(), result = await run(["task", "continue later", "--resume", "background-source", "--background", "--json"], fx);
  assert.equal(result.code, 0, result.stderr);
  const [workspace] = await readdir(fx.state), files = await readdir(join(fx.state, workspace)), recordName = files.find(name => name.endsWith(".json"));
  const record = JSON.parse(await readFile(join(fx.state, workspace, recordName), "utf8"));
  assert.equal(record.resumeSessionId, "background-source");
  for (let i = 0; i < 100; i += 1) { try { const args = JSON.parse(await readFile(fx.invocation, "utf8")); assert.equal(args[args.indexOf("--resume") + 1], "background-source"); return; } catch { await new Promise(resolveWait => setTimeout(resolveWait, 20)); } }
  assert.fail("Detached Claude invocation was not captured");
});

test("resume is rejected outside task", async () => {
  const fx = await fixture(), result = await run(["review", "--resume", "source-session", "--json"], fx);
  assert.equal(result.code, 1); assert.match(JSON.parse(result.stderr).error, /only supported by task/);
});
