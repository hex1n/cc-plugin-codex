import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { parseArgs } from "../scripts/lib/args.mjs";

test("positional words that contain flag names are preserved", () => {
  const parsed = parseArgs(["task", "please", "rebase", "onto", "main"]);
  assert.deepEqual(parsed.positional, ["please", "rebase", "onto", "main"]);
  assert.equal(parsed.options.base, null);
});

test("end-of-options preserves literal flag-shaped prompt text", () => {
  const parsed = parseArgs(["task", "explain", "--", "--help", "--unknown"]);
  assert.deepEqual(parsed.positional, ["explain", "--help", "--unknown"]);
  assert.equal(parsed.options.help, false);
});

const companion = resolve("scripts/claude-companion.mjs");
function run(args, { cwd, env }) { return new Promise((resolveRun, reject) => { const child = spawn(process.execPath, [companion, ...args], { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; }); child.once("error", reject); child.once("close", code => resolveRun({ code, stdout, stderr })); }); }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "claude-commands-test-")), bin = join(root, "bin"), cwd = join(root, "workspace"), invocation = join(root, "invocation.json"), fakeClaude = join(bin, "claude"), fakeGit = join(bin, "git");
  await mkdir(bin); await mkdir(cwd);
  await writeFile(fakeClaude, `#!/usr/bin/env node\nimport {writeFileSync} from "node:fs";\nif (process.argv[2] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }\nif (process.argv[2] === "auth") { console.log(JSON.stringify({loggedIn:true,authMethod:"oauth"})); process.exit(0); }\nwriteFileSync(process.env.FAKE_INVOCATION, JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify({type:"result",is_error:false,result:"challenged",structured_output:{verdict:"approve",summary:"No findings",findings:[],next_steps:[]},session_id:"review-session"}));\n`);
  await writeFile(fakeGit, `#!/usr/bin/env node\nconst args=process.argv.slice(2); if(args[0]==="rev-parse") console.log(process.env.FAKE_WORKSPACE); else if(args[0]==="status") process.stdout.write(""); else if(args[0]==="diff"&&args.includes("--name-only")) process.stdout.write("a.js\\0"); else if(args[0]==="diff") console.log("diff --git a/a.js b/a.js\\n+change"); else if(args[0]==="merge-base") console.log("base-sha"); else process.exit(1);\n`);
  await chmod(fakeClaude, 0o755); await chmod(fakeGit, 0o755);
  return { cwd, invocation, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_CODE_EXECUTABLE: fakeClaude, FAKE_INVOCATION: invocation, FAKE_WORKSPACE: cwd } };
}

test("adversarial-review uses the read-only profile and includes focus", async () => {
  const fx = await fixture(), result = await run(["adversarial-review", "concurrency", "--json"], fx);
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).result, "challenged");
  const args = JSON.parse(await readFile(fx.invocation, "utf8"));
  assert.deepEqual(args.slice(0, 3), ["--print", "--output-format", "json"]);
  assert.ok(args.includes("--safe-mode")); assert.ok(args.includes("--permission-mode")); assert.ok(args.includes("plan")); assert.match(args.at(-1), /User focus: concurrency/); assert.match(args.at(-1), /<context>/);
});

test("transfer emits an explicit non-faithful summary seed", async () => {
  const fx = await fixture(), result = await run(["transfer", "Goal: finish tests", "--json"], fx), payload = JSON.parse(result.stdout);
  assert.equal(result.code, 0, result.stderr); assert.equal(payload.kind, "summary-seed"); assert.equal(payload.faithful_import, false); assert.match(payload.prompt, /Goal: finish tests/);
});

test("setup reports CLI version, auth, and current Codex locations", async () => {
  const fx = await fixture(), result = await run(["setup", "--json"], fx), setup = JSON.parse(result.stdout).setup;
  assert.equal(result.code, 0, result.stderr); assert.equal(setup.installed, true); assert.equal(setup.authenticated, true); assert.match(setup.version, /9\.9\.9/); assert.equal(setup.pluginRoot, resolve(".")); assert.equal(setup.skillLocation, resolve("skills")); assert.equal(setup.pluginManifest, resolve(".codex-plugin/plugin.json")); assert.match(setup.installHint, /@anthropic-ai\/claude-code/);
});

test("every bundled skill uses the plugin-root helper entrypoint", async () => {
  const skillRoot = resolve("skills"), names = await readdir(skillRoot);
  assert.equal(names.length, 8);
  for (const name of names) {
    const skill = await readFile(join(skillRoot, name, "SKILL.md"), "utf8");
    assert.match(skill, /<PLUGIN_ROOT>\/scripts\/claude-companion\.mjs/, name);
    assert.doesNotMatch(skill, /\.\.\/\.\.\/scripts\//, name);
  }
});
