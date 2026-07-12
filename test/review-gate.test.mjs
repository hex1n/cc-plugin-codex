import assert from "node:assert/strict";
import { access, chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const companion = resolve("scripts/claude-companion.mjs"), hook = resolve("hooks/review-gate.mjs");
function runNode(script, args, { cwd, env, stdin }) { return new Promise((resolveRun, reject) => { const child = spawn(process.execPath, [script, ...args], { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] }); let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; }); child.once("error", reject); child.once("close", code => resolveRun({ code, stdout, stderr })); child.stdin.end(stdin ?? ""); }); }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "review-gate-test-")), bin = join(root, "bin"), cwd = join(root, "workspace"), config = join(root, "config"), called = join(root, "claude-called"), fakeClaude = join(bin, "claude"), fakeGit = join(bin, "git");
  await mkdir(bin); await mkdir(cwd);
  await writeFile(fakeClaude, `#!/usr/bin/env node\nimport {appendFileSync} from "node:fs";\nif(process.argv[2]==="--version"){console.log("9.9.9");process.exit(0)} if(process.argv[2]==="auth"){console.log(JSON.stringify({loggedIn:true,authMethod:"oauth"}));process.exit(0)} appendFileSync(process.env.FAKE_CALLED,JSON.stringify(process.argv.slice(2))+"\\n"); if(process.env.FAKE_FAIL==="1"){console.error("review unavailable");process.exit(1)} console.log(JSON.stringify({type:"result",is_error:false,result:"",structured_output:JSON.parse(process.env.FAKE_VERDICT),session_id:"gate-session"}));\n`);
  await writeFile(fakeGit, `#!/usr/bin/env node\nconst args=process.argv.slice(2); if(args[0]==="rev-parse") console.log(process.env.FAKE_WORKSPACE); else if(args[0]==="status") process.stdout.write(""); else if(args[0]==="diff"&&args.includes("--name-only")) process.stdout.write(process.env.FAKE_DIFF?"a.js\\0":""); else if(args[0]==="diff") process.stdout.write(process.env.FAKE_DIFF||""); else process.exit(1);\n`);
  await chmod(fakeClaude, 0o755); await chmod(fakeGit, 0o755);
  return { cwd, called, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_CODE_EXECUTABLE: fakeClaude, CLAUDE_COMPANION_CONFIG_ROOT: config, FAKE_CALLED: called, FAKE_WORKSPACE: cwd, FAKE_VERDICT: JSON.stringify({ verdict: "allow", summary: "No issues" }) } };
}
const stopInput = (fx, extra = {}) => JSON.stringify({ hook_event_name: "Stop", cwd: fx.cwd, stop_hook_active: false, ...extra });
async function setGate(fx, enabled) { const flag = enabled ? "--enable-review-gate" : "--disable-review-gate"; return runNode(companion, ["setup", flag, "--json"], fx); }
async function runHook(fx, extra = {}) { const result = await runNode(hook, [], { ...fx, stdin: stopInput(fx, extra) }); assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout); }
async function wasCalled(path) { try { await access(path); return true; } catch { return false; } }

test("setup explicitly enables and disables the review gate", async () => {
  const fx = await fixture();
  assert.equal(JSON.parse((await setGate(fx, true)).stdout).setup.reviewGateEnabled, true);
  assert.equal(JSON.parse((await setGate(fx, false)).stdout).setup.reviewGateEnabled, false);
});

test("disabled and recursive Stop hooks pass without invoking Claude", async () => {
  const disabled = await fixture(); assert.deepEqual(await runHook(disabled), { continue: true, suppressOutput: true }); assert.equal(await wasCalled(disabled.called), false);
  const recursive = await fixture(); await setGate(recursive, true); assert.deepEqual(await runHook(recursive, { stop_hook_active: true }), { continue: true, suppressOutput: true }); assert.equal(await wasCalled(recursive.called), false);
});

test("an enabled gate passes a clean workspace without invoking Claude", async () => {
  const fx = await fixture(); await setGate(fx, true); assert.deepEqual(await runHook(fx), { continue: true, suppressOutput: true }); assert.equal(await wasCalled(fx.called), false);
});

test("an enabled gate continues Codex when Claude finds actionable issues", async () => {
  const fx = await fixture(); await setGate(fx, true); fx.env.FAKE_DIFF = "diff --git a/a.js b/a.js\n+bug"; fx.env.FAKE_VERDICT = JSON.stringify({ verdict: "block", summary: "Race in a.js" });
  const output = await runHook(fx); assert.equal(output.decision, "block"); assert.match(output.reason, /Race in a\.js/);
});

test("an enabled gate enforces a small budget and caches an unchanged verdict", async () => {
  const fx = await fixture(); await setGate(fx, true); fx.env.FAKE_DIFF = "diff --git a/a.js b/a.js\n+safe";
  assert.deepEqual(await runHook(fx), { continue: true, suppressOutput: true });
  assert.deepEqual(await runHook(fx), { continue: true, suppressOutput: true });
  const calls = (await readFile(fx.called, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 1);
  const args = calls[0];
  assert.equal(args[args.indexOf("--max-turns") + 1], "4");
  assert.equal(args[args.indexOf("--max-budget-usd") + 1], "0.2");
});

test("an enabled gate continues Codex with setup guidance when Claude fails", async () => {
  const fx = await fixture(); await setGate(fx, true); fx.env.FAKE_DIFF = "diff"; fx.env.FAKE_FAIL = "1";
  const output = await runHook(fx); assert.equal(output.decision, "block"); assert.match(output.reason, /review unavailable/); assert.match(output.reason, /disable the review gate/);
});
