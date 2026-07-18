import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const admin = resolve("scripts/claude-admin.mjs");

function run(args, env = process.env) {
  return spawnCapture(process.execPath, [admin, ...args], { cwd: resolve("."), env });
}

function spawnCapture(command, args, { cwd, env }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject); child.once("close", code => resolveRun({ code, stdout, stderr }));
  });
}

test("admin CLI rejects normal product commands", async () => {
  for (const command of ["review", "adversarial-review", "task", "apply", "result"]) {
    const result = await run([command]);
    assert.equal(result.code, 1, `${command}: ${result.stderr}`);
    assert.match(result.stderr, /not an admin command/i, command);
  }
});

test("admin doctor remains useful when the MCP manifest is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-admin-doctor-")), bin = join(root, "bin"), fakeClaude = join(bin, "claude");
  await mkdir(bin);
  await writeFile(fakeClaude, `#!/usr/bin/env node
if (process.argv[2] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "oauth" })); process.exit(0); }
process.exit(1);
`);
  await chmod(fakeClaude, 0o755);
  const env = {
    ...process.env,
    CLAUDE_CODE_EXECUTABLE: fakeClaude,
    CLAUDE_COMPANION_CONFIG_ROOT: join(root, "config"),
    CLAUDE_COMPANION_STATE_ROOT: join(root, "state"),
    CLAUDE_COMPANION_MCP_CONFIG: join(root, "missing.mcp.json")
  };
  const result = await run(["doctor", "--json"], env);
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.doctor.claude.installed, true);
  assert.equal(payload.doctor.claude.authentication_state, "authenticated");
  assert.equal(payload.doctor.review_gate.enabled, false);
  assert.equal(payload.doctor.mcp.config_readable, false);
});

test("admin review-gate controls remain available without MCP", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-admin-gate-"));
  const env = { ...process.env, CLAUDE_COMPANION_CONFIG_ROOT: join(root, "config"), CLAUDE_COMPANION_MCP_CONFIG: join(root, "missing.mcp.json") };
  const initial = JSON.parse((await run(["review-gate", "status", "--json"], env)).stdout);
  assert.equal(initial.review_gate.enabled, false);
  const enabled = JSON.parse((await run(["review-gate", "enable", "--json"], env)).stdout);
  assert.equal(enabled.review_gate.enabled, true);
  const status = JSON.parse((await run(["review-gate", "status", "--json"], env)).stdout);
  assert.equal(status.review_gate.enabled, true);
  const disabled = JSON.parse((await run(["review-gate", "disable", "--json"], env)).stdout);
  assert.equal(disabled.review_gate.enabled, false);
});

test("admin MCP probe performs only initialize and tool discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-admin-probe-"));
  const env = { ...process.env, CLAUDE_COMPANION_MCP_CONFIG: join(root, "missing.mcp.json"), CLAUDE_COMPANION_MCP_SERVER: resolve("mcp/server.mjs") };
  const result = await run(["mcp", "probe", "--json"], env);
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.probe.ok, true);
  assert.equal(payload.probe.tool_count, 13);
  for (const name of ["claude_adversarial_review", "claude_jobs_list", "claude_doctor"]) assert(payload.probe.tools.includes(name));
});

test("admin MCP probe reports a broken server without affecting offline gate controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-admin-broken-probe-"));
  const brokenServer = join(root, "broken-server.mjs");
  await writeFile(brokenServer, "process.stderr.write('fixture unavailable\\n'); process.exit(23);\n");
  const env = {
    ...process.env,
    CLAUDE_COMPANION_CONFIG_ROOT: join(root, "config"),
    CLAUDE_COMPANION_MCP_SERVER: brokenServer
  };
  const probe = await run(["mcp", "probe", "--json"], env);
  assert.equal(probe.code, 1);
  assert.match(probe.stderr, /exited 23.*fixture unavailable/i);
  const enabled = await run(["review-gate", "enable", "--json"], env);
  assert.equal(enabled.code, 0, enabled.stderr);
  assert.equal(JSON.parse(enabled.stdout).review_gate.enabled, true);
});

test("admin jobs list and reconcile use explicit workspace state", async () => {
  const fx = await stateFixture();
  await seedJob(fx.workspace, fx.env, { id: "stale-start", status: "starting", phase: "starting", createdAt: "2020-01-01T00:00:00.000Z" });
  const listed = await run(["jobs", "list", "--workspace", fx.workspace, "--json"], fx.env);
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).jobs.map(job => job.id), ["stale-start"]);
  const reconciled = await run(["jobs", "reconcile", "--workspace", fx.workspace, "--json"], fx.env);
  assert.equal(reconciled.code, 0, reconciled.stderr);
  const job = JSON.parse(reconciled.stdout).jobs.find(value => value.id === "stale-start");
  assert.equal(job.status, "failed");
  assert.equal(job.error_kind, "starting_timeout");
});

test("admin recovery commands reject list-only filters", async () => {
  const fx = await stateFixture();
  for (const args of [
    ["jobs", "reconcile", "--workspace", fx.workspace, "--status", "failed"],
    ["jobs", "cancel", "job-id", "--workspace", fx.workspace, "--include-test"],
    ["artifact", "inspect", "job-id", "--workspace", fx.workspace, "--global"]
  ]) {
    const result = await run(args, fx.env);
    assert.equal(result.code, 1, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stderr, /only accepts|does not accept/i);
  }
});

test("admin artifact inspection refuses to discard partial apply recovery state", async () => {
  const fx = await stateFixture();
  await seedJob(fx.workspace, fx.env, { id: "partial", status: "completed", phase: "recovery_required", write: true, artifactStatus: "partial_apply", recoveryRequired: true, patchHash: "a".repeat(64), changedPaths: ["src/a.js"] });
  const inspected = await run(["artifact", "inspect", "partial", "--workspace", fx.workspace, "--json"], fx.env);
  assert.equal(inspected.code, 0, inspected.stderr);
  const artifact = JSON.parse(inspected.stdout).artifact;
  assert.equal(artifact.artifact_status, "partial_apply");
  assert.equal(artifact.recovery_required, true);
  assert.deepEqual(artifact.changed_paths, ["src/a.js"]);
  const discarded = await run(["artifact", "discard", "partial", "--workspace", fx.workspace, "--json"], fx.env);
  assert.equal(discarded.code, 1);
  assert.match(discarded.stderr, /manual recovery|cannot be discarded/i);
});

async function stateFixture() {
  const root = await mkdtemp(join(tmpdir(), "claude-admin-state-")), workspace = join(root, "workspace"), state = join(root, "state");
  await mkdir(workspace);
  const initialized = await spawnCapture("git", ["init", "--quiet"], { cwd: workspace, env: process.env });
  assert.equal(initialized.code, 0, initialized.stderr);
  return { workspace: await realpath(workspace), env: { ...process.env, CLAUDE_COMPANION_STATE_ROOT: state, CLAUDE_COMPANION_CONFIG_ROOT: join(root, "config") } };
}

async function seedJob(workspace, env, fields) {
  const source = `import { saveJob } from ${JSON.stringify(new URL("../scripts/lib/state.mjs", import.meta.url).href)}; await saveJob(JSON.parse(process.argv[1]));`;
  const record = { recordVersion: 3, id: fields.id, cwd: workspace, profile: "task", purpose: "user", status: "completed", phase: "done", pid: null, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ...fields };
  const result = await spawnCapture(process.execPath, ["--input-type=module", "--eval", source, JSON.stringify(record)], { cwd: resolve("."), env });
  assert.equal(result.code, 0, result.stderr);
}
