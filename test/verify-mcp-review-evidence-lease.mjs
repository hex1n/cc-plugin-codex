#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requiredFiles = [
  "scripts/lib/review-evidence-lease.mjs",
  "scripts/lib/review-evidence-contract.mjs",
  "scripts/review-evidence-mcp.mjs",
  "test/review-evidence-lease.test.mjs",
  "test/review-evidence-mcp.test.mjs",
  "test/review-evidence-integration.test.mjs",
];

try {
  for (const file of requiredFiles) await access(resolve(root, file));

  const claude = await readFile(resolve(root, "scripts/lib/claude.mjs"), "utf8");
  const required = [
    '"--tools", ""',
    '"--setting-sources", ""',
    '"--disable-slash-commands"',
    '"--strict-mcp-config"',
    '"--mcp-config"',
    '"--permission-mode", "dontAsk"',
  ];
  for (const token of required) {
    if (!claude.includes(token)) unsatisfied(`missing fixed Claude review contract: ${token}`);
  }
  if (claude.includes("--fallback-model")) unsatisfied("automatic model fallback is present");

  const config = await readFile(resolve(root, "scripts/lib/config.mjs"), "utf8");
  for (const token of ["evidenceLeaseEnabled: false", "evidenceUnits: 3", "evidenceUnits: 5", "evidenceUnits: 8"]) {
    if (!config.includes(token)) unsatisfied(`missing default-off profile contract: ${token}`);
  }
  const service = await readFile(resolve(root, "scripts/lib/service.mjs"), "utf8");
  for (const forbidden of ["--resume", "--continue", "fallbackModel"]) {
    if (service.includes(forbidden)) unsatisfied(`automatic review continuation contract is present: ${forbidden}`);
  }
  const readme = await readFile(resolve(root, "README.md"), "utf8");
  for (const token of ["evidence_lease_exhausted", "cost_budget_exhausted", "turn_limit_reached", "default-off"]) {
    if (!readme.includes(token)) unsatisfied(`documentation is missing: ${token}`);
  }

  const tests = spawnSync("npm", ["run", "check"], {
    cwd: root,
    encoding: "utf8",
    shell: false,
    timeout: 110_000,
  });
  if (tests.error) indeterminate(`test runner failed: ${tests.error.message}`);
  if (tests.status !== 0) unsatisfied(tail(`${tests.stdout}\n${tests.stderr}`));
  satisfied("offline Evidence Lease contract and full Node test suite passed");
} catch (error) {
  if (error?.code === "ENOENT") unsatisfied(`required implementation artifact missing: ${error.path}`);
  indeterminate(error?.stack ?? String(error));
}

function tail(value) {
  return value.trim().split(/\r?\n/).slice(-30).join("\n");
}

function emit(verdict, message, code) {
  process.stdout.write(`TASKLOOP_CRITERION: ${verdict} - ${message}\n`);
  process.exit(code);
}

function satisfied(message) { emit("satisfied", message, 4); }
function unsatisfied(message) { emit("unsatisfied", message, 3); }
function indeterminate(message) { emit("indeterminate", message, 2); }
