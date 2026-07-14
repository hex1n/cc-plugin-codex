import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const repo = resolve("."), companion = join(repo, "scripts/claude-companion.mjs");
function run(command, args, { cwd = repo, env = process.env } = {}) { return new Promise((resolveRun, reject) => { const child = spawn(command, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; }); child.once("error", reject); child.once("close", code => resolveRun({ code, stdout, stderr })); }); }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cc-plugin-regression-")), bin = join(root, "bin"), workspace = join(root, "workspace"), invocation = join(root, "args.json"), claude = join(bin, "claude"), git = join(bin, "git");
  await mkdir(bin); await mkdir(workspace);
  await writeFile(claude, `#!/usr/bin/env node\nimport {writeFileSync} from "node:fs";\nconst args=process.argv.slice(2); if(args[0]==="--version"){console.log("9.9.9");process.exit(0)} if(args[0]==="auth"){console.log(JSON.stringify({loggedIn:false,authMethod:"none"}));process.exit(1)} let prompt="";for await(const chunk of process.stdin)prompt+=chunk;writeFileSync(process.env.FAKE_ARGS,JSON.stringify({args,prompt})); if(!prompt){console.error("prompt missing");process.exit(1)} console.log(JSON.stringify({type:"result",is_error:false,result:"review received",structured_output:{verdict:"approve",summary:"No findings",findings:[],next_steps:[],coverage:{files_examined:["a"],files_skipped:[],areas:["diff"]},uncertainty:"low",budget_exhausted:false,recommended_followup:{profile:"none",focus:[],reason:""}},session_id:"session"}));\n`);
  await writeFile(git, `#!/usr/bin/env node\nconst a=process.argv.slice(2); if(a[0]==="rev-parse") console.log(process.env.FAKE_WORKSPACE); else if(a[0]==="status") process.stdout.write(""); else if(a[0]==="diff"&&a.includes("--name-only")) process.stdout.write("a\\0"); else if(a[0]==="diff") console.log("diff --git a/a b/a\\n+bug"); else process.exit(1);\n`);
  await chmod(claude, 0o755); await chmod(git, 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_CODE_EXECUTABLE: claude, FAKE_ARGS: invocation, FAKE_WORKSPACE: workspace };
  return { root, workspace, invocation, claude, env };
}

test("review keeps variadic tool options in argv and sends the prompt through stdin", async () => {
  const fx = await fixture(), result = await run(process.execPath, [companion, "review", "--json"], { cwd: fx.workspace, env: fx.env });
  assert.equal(result.code, 0, result.stderr);
  const { args, prompt } = JSON.parse(await readFile(fx.invocation, "utf8"));
  assert.ok(args.includes("--safe-mode"));
  assert.equal(args.indexOf("--"), -1);
  assert.match(args[args.indexOf("--allowedTools") + 1], /review-diff\.mjs/);
  assert.match(prompt, /<context>/);
});

test("PLUGIN_DATA owns plugin job and configuration state", async () => {
  const fx = await fixture(), pluginData = join(fx.root, "plugin-data"), env = { ...fx.env, PLUGIN_DATA: pluginData };
  delete env.CLAUDE_COMPANION_STATE_ROOT; delete env.CLAUDE_COMPANION_CONFIG_ROOT; delete env.CLAUDE_PLUGIN_DATA;
  const stateCode = `import {createJob} from './scripts/lib/state.mjs'; console.log(JSON.stringify(await createJob({cwd:'/fixture',profile:'task'})))`;
  const state = await run(process.execPath, ["--input-type=module", "-e", stateCode], { env });
  assert.equal(state.code, 0, state.stderr); assert.ok(JSON.parse(state.stdout).stdoutPath.startsWith(join(pluginData, "jobs")));
  const configCode = `import {readReviewGateConfig} from './scripts/lib/config.mjs'; console.log(JSON.stringify(await readReviewGateConfig()))`;
  const config = await run(process.execPath, ["--input-type=module", "-e", configCode], { env });
  assert.equal(config.code, 0, config.stderr); assert.ok(JSON.parse(config.stdout).path.startsWith(join(pluginData, "config")));
});

test("setup reports a sandbox-visible auth miss as ambiguous", async () => {
  const fx = await fixture(), result = await run(process.execPath, [companion, "setup", "--json"], { cwd: fx.workspace, env: fx.env });
  assert.equal(result.code, 0, result.stderr);
  const setup = JSON.parse(result.stdout).setup;
  assert.equal(setup.authenticated, false);
  assert.equal(setup.authenticationState, "unavailable-or-not-logged-in");
});

test("stateful and Claude-backed skills use permission-aware escalation", async () => {
  const required = ["claude-adversarial-review", "claude-setup"];
  for (const name of required) {
    const skill = await readFile(join(repo, "skills", name, "SKILL.md"), "utf8");
    assert.match(skill, /automatic-approval mode/, name);
    assert.match(skill, /without asking the user for pre-confirmation/, name);
    assert.match(skill, /make the tool call with sandbox escalation/, name);
    assert.match(skill, /unrestricted\/full-access mode/, name);
    assert.match(skill, /approvals disabled, do not attempt/, name);
    assert.match(skill, /permission profile must change/, name);
    assert.match(skill, /When sandbox escalation is available, request it only/, name);
    assert.doesNotMatch(skill, /Request sandbox escalation/, name);
    assert.doesNotMatch(skill, /full-access mode, or when approvals are disabled/, name);
  }
  assert.equal(required.length, 2);
  for (const name of ["claude-adversarial-review"]) {
    const skill = await readFile(join(repo, "skills", name, "SKILL.md"), "utf8");
    assert.match(skill, /retry only after a permission-profile change or host-provided authorization change/, name);
    assert.doesNotMatch(skill, /retry only after explicit consent/, name);
  }
  const mcpSkills = { "claude-task": "claude_task_readonly", "claude-review": "claude_review_changes", "claude-plan-review": "claude_review_plan", "claude-status": "claude_job_status", "claude-result": "claude_job_result", "claude-cancel": "claude_job_cancel" };
  for (const [name, tool] of Object.entries(mcpSkills)) {
    const skill = await readFile(join(repo, "skills", name, "SKILL.md"), "utf8");
    assert.match(skill, new RegExp(tool), name);
    assert.match(skill, /MCP is unavailable/i, name);
  }
  const readme = await readFile(join(repo, "README.md"), "utf8");
  assert.match(readme, /conversational consent alone does not change that boundary/);
});
