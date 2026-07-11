#!/usr/bin/env node
import { findWorkspaceRoot } from "../scripts/lib/git.mjs";
import { pruneWorkspaceJobs } from "../scripts/lib/job-lifecycle.mjs";

const pass = () => ({ continue: true, suppressOutput: true });
async function main() {
  const input = JSON.parse(await readStdin()); if (input.hook_event_name !== "SessionEnd") return pass();
  await pruneWorkspaceJobs(await findWorkspaceRoot(input.cwd ?? process.cwd())); return pass();
}
function readStdin() { return new Promise((resolve, reject) => { let value = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => { value += chunk; }); process.stdin.on("end", () => resolve(value)); process.stdin.on("error", reject); }); }
try { process.stdout.write(`${JSON.stringify(await main())}\n`); }
catch (error) { process.stderr.write(`Claude job retention cleanup skipped: ${error.message}\n`); process.stdout.write(`${JSON.stringify(pass())}\n`); }
