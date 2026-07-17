#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const requiredFiles = [
  "scripts/claude-admin.mjs",
  "test/admin-cli.test.mjs",
  "test/jobs-list.test.mjs",
  "test/verify-installed-host-routing.mjs"
];

function fail(reason) {
  process.stdout.write(`TASKLOOP_CRITERION: mcp-cli-contraction-incomplete\n${reason}\n`);
  process.exit(1);
}

for (const path of requiredFiles) if (!existsSync(path)) fail(`missing required file: ${path}`);
if (existsSync("scripts/claude-companion.mjs")) fail("legacy normal companion CLI still exists");

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (JSON.stringify(pkg.bin) !== JSON.stringify({ "claude-companion-admin": "scripts/claude-admin.mjs" })) fail("package bin is not admin-only");

const server = readFileSync("mcp/server.mjs", "utf8");
for (const name of ["claude_adversarial_review", "claude_jobs_list", "claude_doctor"]) if (!server.includes(name)) fail(`missing MCP tool: ${name}`);

const skillNames = ["claude-adversarial-review", "claude-cancel", "claude-plan-review", "claude-result", "claude-review", "claude-setup", "claude-status", "claude-task", "claude-transfer"];
for (const name of skillNames) {
  const skill = readFileSync(`skills/${name}/SKILL.md`, "utf8");
  if (skill.includes("claude-companion.mjs")) fail(`normal CLI fallback remains in ${name}`);
}

const check = spawnSync(process.execPath, ["scripts/check.mjs"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
if (check.status !== 0) fail((check.stderr || check.stdout || "npm check failed").trim().slice(-4000));

const host = spawnSync(process.execPath, ["test/verify-installed-host-routing.mjs"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
if (host.status !== 0) fail((host.stderr || host.stdout || "installed host routing verification failed").trim().slice(-4000));
try {
  const evidence = JSON.parse(host.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
  if (evidence.criterion !== "installed-host-routing-complete" || evidence.fresh_sessions < 5 || evidence.operations < 10 || evidence.legacy_cli_surface !== false || evidence.automatic_fallbacks !== 0) fail("installed host routing evidence is incomplete");
} catch (error) { fail(`invalid installed host routing evidence: ${error.message}`); }

process.stdout.write("TASKLOOP_CRITERION: mcp-cli-contraction-complete\n");
