import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

test("bundled skills use MCP for normal flows and reserve admin for explicit gate control", async () => {
  const skillRoot = resolve("skills"), names = await readdir(skillRoot);
  assert.equal(names.length, 9);
  for (const name of names) {
    const skill = await readFile(join(skillRoot, name, "SKILL.md"), "utf8");
    assert.doesNotMatch(skill, /claude-companion\.mjs/, name);
  }
  assert.match(await readFile(join(skillRoot, "claude-adversarial-review", "SKILL.md"), "utf8"), /claude_adversarial_review/);
  assert.match(await readFile(join(skillRoot, "claude-status", "SKILL.md"), "utf8"), /claude_jobs_list/);
  const setup = await readFile(join(skillRoot, "claude-setup", "SKILL.md"), "utf8");
  assert.match(setup, /claude_doctor/); assert.match(setup, /claude-companion-admin/);
  const transfer = await readFile(join(skillRoot, "claude-transfer", "SKILL.md"), "utf8");
  assert.match(transfer, /local|本地/i); assert.doesNotMatch(transfer, /`claude_[a-z_]+`|node "/i);
});

test("result-producing skills require usage metrics to be reported", async () => {
  for (const name of ["claude-task", "claude-result", "claude-review", "claude-plan-review", "claude-adversarial-review"]) {
    const skill = await readFile(resolve("skills", name, "SKILL.md"), "utf8");
    for (const metric of ["token", "cost", "turn", "duration"]) assert.match(skill, new RegExp(metric, "i"), `${name} must report ${metric}`);
  }
});
