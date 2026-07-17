import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const repo = resolve(".");

test("PLUGIN_DATA owns plugin job and configuration state", async () => {
  const root = await mkdtemp(join(tmpdir(), "cc-plugin-regression-")), pluginData = join(root, "plugin-data"), env = { ...process.env, PLUGIN_DATA: pluginData };
  delete env.CLAUDE_COMPANION_STATE_ROOT; delete env.CLAUDE_COMPANION_CONFIG_ROOT; delete env.CLAUDE_PLUGIN_DATA;
  const stateCode = `import {createJob} from './scripts/lib/state.mjs'; console.log(JSON.stringify(await createJob({cwd:'/fixture',profile:'task'})))`;
  const state = await run(process.execPath, ["--input-type=module", "-e", stateCode], { env });
  assert.equal(state.code, 0, state.stderr); assert.ok(JSON.parse(state.stdout).stdoutPath.startsWith(join(pluginData, "jobs")));
  const configCode = `import {readReviewGateConfig} from './scripts/lib/config.mjs'; console.log(JSON.stringify(await readReviewGateConfig()))`;
  const config = await run(process.execPath, ["--input-type=module", "-e", configCode], { env });
  assert.equal(config.code, 0, config.stderr); assert.ok(JSON.parse(config.stdout).path.startsWith(join(pluginData, "config")));
});

test("stateful and Claude-backed skills use permission-aware escalation", async () => {
  const required = ["claude-adversarial-review", "claude-setup"];
  for (const name of required) {
    const skill = await readFile(join(repo, "skills", name, "SKILL.md"), "utf8");
    assert.match(skill, /automatic-approval mode/, name); assert.match(skill, /without asking the user for pre-confirmation/, name);
    assert.match(skill, /make the tool call with sandbox escalation/, name); assert.match(skill, /unrestricted\/full-access mode/, name);
    assert.match(skill, /approvals disabled, do not attempt/, name); assert.match(skill, /permission profile must change/, name);
    assert.match(skill, /When sandbox escalation is available, request it only/, name);
    assert.doesNotMatch(skill, /Request sandbox escalation/, name); assert.doesNotMatch(skill, /full-access mode, or when approvals are disabled/, name);
  }
  const adversarial = await readFile(join(repo, "skills", "claude-adversarial-review", "SKILL.md"), "utf8");
  assert.match(adversarial, /retry only after a permission-profile change or host-provided authorization change/);
  const mcpSkills = { "claude-task": "claude_task_readonly", "claude-review": "claude_review_changes", "claude-plan-review": "claude_review_plan", "claude-status": "claude_job_status", "claude-result": "claude_job_result", "claude-cancel": "claude_job_cancel" };
  for (const [name, tool] of Object.entries(mcpSkills)) {
    const skill = await readFile(join(repo, "skills", name, "SKILL.md"), "utf8"); assert.match(skill, new RegExp(tool), name); assert.match(skill, /MCP is unavailable/i, name);
  }
  assert.match(await readFile(join(repo, "README.md"), "utf8"), /conversational consent alone does not change that boundary/);
});

function run(command, args, { env }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: repo, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject); child.once("close", code => resolveRun({ code, stdout, stderr }));
  });
}
