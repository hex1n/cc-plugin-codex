import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const server = resolve("mcp/server.mjs");

test("MCP job listing is workspace-scoped, bounded, and cursor-stable", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobs-list-test-")), workspace = join(root, "workspace"), state = join(root, "state");
  await mkdir(workspace); await git(["init", "--quiet"], workspace);
  const env = { ...process.env, CLAUDE_COMPANION_STATE_ROOT: state };
  await seedJobs(await realpath(workspace), env);

  const first = await call(env, {
    name: "claude_jobs_list",
    arguments: { workspace_root: workspace, limit: 1 }
  });
  assert.equal(first.jobs.length, 1, JSON.stringify(first));
  assert.equal(first.jobs[0].id, "newest-user");
  assert.equal(first.jobs[0].status, "completed");
  assert.equal("disclosure" in first.jobs[0], false);
  assert.equal("prompt" in first.jobs[0], false);
  assert.equal(first.has_more, true);
  assert.equal(typeof first.next_cursor, "string");

  const second = await call(env, {
    name: "claude_jobs_list",
    arguments: { workspace_root: workspace, limit: 1, cursor: first.next_cursor }
  });
  assert.deepEqual(second.jobs.map(job => job.id), ["older-user"]);
  assert.equal(second.has_more, false);
  assert.equal(second.next_cursor, null);
});

test("MCP job listing rejects malformed cursor and non-RFC-3339 timestamps as invalid arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobs-list-invalid-test-")), workspace = join(root, "workspace"), state = join(root, "state");
  await mkdir(workspace); await git(["init", "--quiet"], workspace);
  const env = { ...process.env, CLAUDE_COMPANION_STATE_ROOT: state };
  for (const arguments_ of [
    { workspace_root: workspace, cursor: "not-a-cursor" },
    { workspace_root: workspace, updated_after: "07/17/2026" },
    { workspace_root: workspace, updated_after: "2025-02-29T00:00:00Z" },
    { workspace_root: workspace, updated_after: "2026-04-31T12:00:00Z" },
    { workspace_root: workspace, updated_after: "2026-04-15T12:34:60Z" },
    { workspace_root: workspace, updated_after: "2026-04-30T23:59:60Z" },
    { workspace_root: workspace, updated_after: "2016-12-31T23:59:60-00:00" }
  ]) {
    const response = await callRaw(env, { name: "claude_jobs_list", arguments: arguments_ });
    assert.equal(response.error.code, -32602, JSON.stringify(response));
  }
  const leapSecond = await callRaw(env, { name: "claude_jobs_list", arguments: { workspace_root: workspace, updated_after: "2016-12-31T23:59:60Z" } });
  assert.equal(leapSecond.error, undefined, JSON.stringify(leapSecond));
  const leapSecondOffset = await callRaw(env, { name: "claude_jobs_list", arguments: { workspace_root: workspace, updated_after: "2017-01-01T00:59:60+01:00" } });
  assert.equal(leapSecondOffset.error, undefined, JSON.stringify(leapSecondOffset));
});

async function seedJobs(workspace, env) {
  const source = `
    import { saveJob } from ${JSON.stringify(new URL("../scripts/lib/state.mjs", import.meta.url).href)};
    const workspace = process.argv[1];
    for (const item of [
      { id: "older-user", purpose: "user", createdAt: "2026-07-17T01:00:00.000Z", finishedAt: "2026-07-17T04:00:00.000Z" },
      { id: "hidden-e2e", purpose: "e2e", createdAt: "2026-07-17T03:00:00.000Z" },
      { id: "newest-user", purpose: "user", createdAt: "2026-07-17T02:00:00.000Z" }
    ]) {
      await saveJob({ recordVersion: 3, id: item.id, cwd: workspace, profile: "task", purpose: item.purpose, status: "completed", phase: "done", pid: null, createdAt: item.createdAt, finishedAt: item.finishedAt ?? item.createdAt, disclosure: { secret: "must-not-leak" } });
    }
  `;
  const result = await spawnCapture(process.execPath, ["--input-type=module", "--eval", source, workspace], { cwd: resolve("."), env });
  assert.equal(result.code, 0, result.stderr);
}

async function call(env, invocation) {
  const response = await callRaw(env, invocation);
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result.structuredContent;
}

async function callRaw(env, invocation) {
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: invocation }
  ];
  const result = await spawnCapture(process.execPath, [server], { cwd: resolve("."), env, stdin: `${requests.map(JSON.stringify).join("\n")}\n` });
  assert.equal(result.code, 0, result.stderr);
  const responses = result.stdout.trim().split("\n").map(JSON.parse);
  const response = responses.find(value => value.id === 2);
  return response;
}

function git(args, cwd) { return spawnCapture("git", args, { cwd, env: process.env }).then(result => { assert.equal(result.code, 0, result.stderr); }); }

function spawnCapture(command, args, { cwd, env, stdin = "" }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject); child.once("close", code => resolveRun({ code, stdout, stderr })); child.stdin.end(stdin);
  });
}
