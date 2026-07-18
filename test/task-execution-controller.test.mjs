import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

test("task controller exposes two bounded receipts and only completes with no gaps", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-controller-"));
  const statePath = join(root, "state.json");
  const responses = await exchange(statePath, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "task_checkpoint", arguments: { summary: "partial", completed_steps: ["one"], remaining_steps: ["two"], verification: [], uncertainty: "low" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "task_complete", arguments: { summary: "not complete", verification: [], remaining_gaps: ["two"] } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "task_complete", arguments: { summary: "complete", verification: ["passed"], remaining_gaps: [] } } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "task_checkpoint", arguments: { summary: "late", completed_steps: ["one"], remaining_steps: ["two"], verification: [], uncertainty: "low" } } },
  ]);

  assert.deepEqual(responses.find(value => value.id === 2).result.tools.map(tool => tool.name), ["task_checkpoint", "task_complete"]);
  assert.equal(responses.find(value => value.id === 3).result.structuredContent.phase, "checkpointed");
  assert.match(responses.find(value => value.id === 4).error.message, /invalid/);
  assert.equal(responses.find(value => value.id === 5).result.structuredContent.phase, "completed");
  assert.match(responses.find(value => value.id === 6).error.message, /cannot be checkpointed/);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.phase, "completed");
  assert.equal(state.checkpointCalls, 1);
  assert.equal(state.completionCalls, 1);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
});

function exchange(statePath, messages) {
  return new Promise((resolveExchange, reject) => {
    const child = spawn(process.execPath, [resolve("scripts/task-execution-mcp.mjs")], {
      env: { ...process.env, TASK_EXECUTION_STATE_PATH: statePath },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => {
      if (code !== 0) return reject(new Error(stderr || "task controller exited " + code));
      resolveExchange(stdout.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse));
    });
    for (const message of messages) child.stdin.write(JSON.stringify(message) + "\n");
    child.stdin.end();
  });
}
