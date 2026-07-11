#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const requiredFiles = ["execution-report.md", "issues/ISSUE-001-review-prompt-swallowed.md", "issues/ISSUE-002-sandbox-auth-state.md", "scripts/seed-fixture.sh", "scripts/cleanup.sh"];
await Promise.all(requiredFiles.map(path => access(join(root, path))));
const report = await readFile(join(root, "execution-report.md"), "utf8");
for (const heading of ["Execution Summary", "Run Metadata", "Environment & Capability Map", "DAG Schedule", "Scenario Results", "Evidence & Failure Scenes", "Failures / Defects / Plan Gaps", "Data Created & Cleanup", "Re-run Instructions", "Next Actions for Agent"]) {
  if (!report.includes(`## ${heading}`)) throw new Error(`Missing report section: ${heading}`);
}
for (const script of ["seed-fixture.sh", "cleanup.sh"]) {
  const result = spawnSync("bash", ["-n", join(root, "scripts", script)], { encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(result.stderr || `${script} failed bash -n`);
}
console.log("E2E report artifact contract passed");
