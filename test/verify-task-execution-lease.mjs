#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const invariants = [
  [readFileSync(resolve(root, "mcp/server.mjs"), "utf8").includes('tool("claude_task_resume"'), "typed resume tool is missing"],
  [readFileSync(resolve(root, "scripts/lib/config.mjs"), "utf8").includes("executionLeaseEnabled: false"), "Task Execution Lease is not default-off"],
  [readFileSync(resolve(root, "skills/claude-task/SKILL.md"), "utf8").includes("Never auto-apply, auto-resume, retry"), "task Skill no longer forbids automatic continuation"],
  [readFileSync(resolve(root, "scripts/lib/patch-artifact.mjs"), "utf8").includes('job.status !== "completed" || job.artifactStatus !== "awaiting_apply"'), "write apply is not completion-gated"],
];

const failedInvariant = invariants.find(([passed]) => !passed);
if (failedInvariant) {
  console.log("TASKLOOP_CRITERION: unsatisfied - " + failedInvariant[1]);
  process.exit(3);
}

for (const args of [
  ["--test", "test/task-execution-controller.test.mjs", "test/task-execution-lease.test.mjs"],
  ["scripts/check.mjs"],
]) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.error) {
    console.log("TASKLOOP_CRITERION: unknown - verifier could not start: " + result.error.message);
    process.exit(4);
  }
  if (result.status !== 0) {
    console.log("TASKLOOP_CRITERION: unsatisfied - verification command failed");
    process.exit(3);
  }
}

console.log("TASKLOOP_CRITERION: satisfied - Task Execution Lease E2E and full checks pass");
process.exit(4);
