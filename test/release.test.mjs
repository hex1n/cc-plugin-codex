import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

function run(command, args) { return new Promise((resolveRun, reject) => { const child = spawn(command, args, { cwd: resolve("."), shell: false, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; }); child.once("error", reject); child.once("close", code => resolveRun({ code, stdout, stderr })); }); }

test("package and plugin versions share one release base", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8")), plugin = JSON.parse(await readFile(".codex-plugin/plugin.json", "utf8"));
  assert.equal(plugin.version.split("+")[0], pkg.version); assert.equal(pkg.license, "Apache-2.0"); assert.equal(pkg.scripts.check, "node scripts/check.mjs");
  const check = await run(process.execPath, ["scripts/check.mjs", "--syntax-only"]); assert.equal(check.code, 0, check.stderr);
});

test("CI covers the supported desktop operating systems", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  for (const os of ["ubuntu-latest", "windows-latest", "macos-latest"]) assert.match(workflow, new RegExp(os));
  assert.match(workflow, /npm run check/); assert.match(workflow, /--syntax-only/); assert.match(workflow, /node-version:\s*22/);
});

test("release and operations documentation is present", async () => {
  assert.match(await readFile("LICENSE", "utf8"), /Apache License/); assert.match(await readFile("NOTICE", "utf8"), /cc-plugin-codex/); assert.match(await readFile("CHANGELOG.md", "utf8"), /Unreleased/);
  const readme = await readFile("README.md", "utf8");
  for (const heading of ["Installation", "Updating", "Configuration", "Prompt contracts", "Security model", "Platform support", "Troubleshooting", "Uninstalling"]) assert.match(readme, new RegExp(`## ${heading}`));
});
