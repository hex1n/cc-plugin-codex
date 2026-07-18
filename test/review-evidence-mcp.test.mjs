import assert from "node:assert/strict";
import { access, chmod, lstat, mkdtemp, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  REVIEW_EVIDENCE_SERVER_NAME,
  REVIEW_EVIDENCE_TOOL_NAMES,
} from "../scripts/lib/review-evidence-contract.mjs";

const server = resolve("scripts/review-evidence-mcp.mjs");

async function fixture(units = 3) {
  const root = await mkdtemp(join(tmpdir(), "review-evidence-mcp-"));
  const workspace = join(root, "workspace");
  const control = join(root, "control");
  const outside = join(root, "outside.txt");
  const state = join(control, "lease-state.json");
  await mkdir(workspace);
  await mkdir(control, { mode: 0o700 });
  await chmod(control, 0o700);
  await command("git", ["init", "--quiet"], workspace);
  await command("git", ["config", "user.email", "test@example.invalid"], workspace);
  await command("git", ["config", "user.name", "Test"], workspace);
  await writeFile(join(workspace, "auth.mjs"), "export const allowed = role === 'admin';\n");
  await writeFile(join(workspace, "caller.mjs"), "import { allowed } from './auth.mjs';\nif (!allowed) throw new Error('denied');\n");
  await command("git", ["add", "auth.mjs", "caller.mjs"], workspace);
  await command("git", ["commit", "--quiet", "-m", "base"], workspace);
  await writeFile(join(workspace, "auth.mjs"), "export const allowed = role = 'admin';\n");
  await writeFile(outside, "outside-secret\n");
  await symlink(outside, join(workspace, "escape.txt"));
  return {
    workspace,
    state,
    outside,
    env: {
      ...process.env,
      REVIEW_ROOT: workspace,
      REVIEW_BASE: "HEAD",
      REVIEW_LEASE_UNITS: String(units),
      REVIEW_LEASE_STATE_PATH: state,
    },
  };
}

test("stdio MCP exposes exactly the bounded review evidence tools", async () => {
  const fx = await fixture();
  const responses = await mcp(fx.env, [
    initialize(1),
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);
  assert.equal(responses.find(value => value.id === 1).result.serverInfo.name, REVIEW_EVIDENCE_SERVER_NAME);
  assert.deepEqual(responses.find(value => value.id === 2).result.tools.map(tool => tool.name), REVIEW_EVIDENCE_TOOL_NAMES);
});

test("the server owns the lease, publishes atomic state, and returns no evidence after exhaustion", async () => {
  const fx = await fixture(3);
  const responses = await mcp(fx.env, [
    initialize(1),
    call(2, "review_diff", {}),
    call(3, "review_file", { paths: ["auth.mjs"] }),
    call(4, "review_context", { query: "allowed" }),
  ]);
  const diff = responses.find(value => value.id === 2).result.structuredContent;
  assert.equal(diff.ok, true);
  assert.match(diff.evidence.diff, /role = 'admin'/);
  assert.equal(diff.evidenceLease.remainingUnits, 2);

  const file = responses.find(value => value.id === 3).result.structuredContent;
  assert.equal(file.ok, true);
  assert.equal(file.evidenceLease.phase, "finalizing");
  assert.equal(file.evidenceLease.remainingUnits, 0);

  const denied = responses.find(value => value.id === 4).result.structuredContent;
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, true);
  assert.equal(denied.evidence, null);
  assert.equal(denied.evidenceLease.deniedCalls, 1);

  const published = JSON.parse(await readFile(fx.state, "utf8"));
  assert.equal(published.revision, 4);
  assert.equal(published.phase, "finalizing");
  assert.equal(published.deniedCalls, 1);
  assert.equal(typeof published.serverPid, "number");
  assert.doesNotMatch(JSON.stringify(published), /role =|outside-secret|allowed =/);
  assert.equal((await lstat(dirname(fx.state))).mode & 0o777, 0o700);
  assert.equal((await lstat(fx.state)).mode & 0o777, 0o600);
});

test("review_file rejects absolute paths and symlink escapes without returning or charging evidence", async () => {
  const fx = await fixture(5);
  const responses = await mcp(fx.env, [
    call(1, "review_file", { paths: [fx.outside] }),
    call(2, "review_file", { paths: ["escape.txt"] }),
    call(3, "review_file", { paths: ["."] }),
  ]);
  for (const response of responses) {
    const payload = response.result.structuredContent;
    assert.equal(payload.ok, false);
    assert.equal(payload.evidence, null);
    assert.match(payload.reason, /path|symlink|workspace/i);
    assert.equal(payload.evidenceLease.usedUnits, 0);
  }
  assert.equal(responses[2].result.structuredContent.evidenceLease.deniedCalls, 3);
});

test("review_file fails closed when a checked path is replaced before open", async () => {
  const fx = await fixture(5);
  const loader = join(dirname(fx.workspace), "review-fs-loader.mjs");
  const wrapper = join(dirname(fx.workspace), "review-fs-promises.mjs");
  const ready = join(dirname(fx.workspace), "open-ready");
  const release = join(dirname(fx.workspace), "open-release");
  const target = join(fx.workspace, "auth.mjs");
  await writeFile(loader, `
import { pathToFileURL } from "node:url";
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "node:fs/promises") {
    return { url: pathToFileURL(process.env.REVIEW_TEST_WRAPPER).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`);
  await writeFile(wrapper, `
import fs from "node:fs";
import { existsSync, writeFileSync } from "node:fs";
const fsPromises = fs.promises;
export const chmod = fsPromises.chmod;
export const lstat = fsPromises.lstat;
export const mkdir = fsPromises.mkdir;
export const opendir = fsPromises.opendir;
export const readFile = fsPromises.readFile;
export const realpath = fsPromises.realpath;
export const rename = fsPromises.rename;
export const stat = fsPromises.stat;
export const writeFile = fsPromises.writeFile;
export async function open(path, ...args) {
  if (!existsSync(process.env.REVIEW_TEST_READY)) {
    writeFileSync(process.env.REVIEW_TEST_READY, "ready");
    while (!existsSync(process.env.REVIEW_TEST_RELEASE)) await new Promise(resolve => setTimeout(resolve, 5));
  }
  return fsPromises.open(path, ...args);
}
`);

  const responsePromise = mcp({
    ...fx.env,
    NODE_OPTIONS: `--experimental-loader=${loader}`,
    REVIEW_TEST_WRAPPER: wrapper,
    REVIEW_TEST_READY: ready,
    REVIEW_TEST_RELEASE: release,
  }, [call(1, "review_file", { paths: ["auth.mjs"] })]);
  await waitForPath(ready);
  await rename(target, `${target}.checked`);
  await symlink(fx.outside, target);
  await writeFile(release, "release");

  const [response] = await responsePromise;
  const payload = response.result.structuredContent;
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, "review_path_changed_during_read");
  assert.equal(payload.evidence, null);
  assert.equal(payload.evidenceLease.usedUnits, 0);
  assert.equal(payload.evidenceLease.deniedCalls, 1);
});

test("review_file enforces file-count and response-byte ceilings", async () => {
  const fx = await fixture(5);
  await writeFile(join(fx.workspace, "large.txt"), "x".repeat(80 * 1024));
  const responses = await mcp(fx.env, [
    call(1, "review_file", { paths: Array(6).fill("auth.mjs") }),
    call(2, "review_file", { paths: ["large.txt"] }),
  ]);
  assert.equal(responses[0].error.code, -32602);
  const payload = responses[1].result.structuredContent;
  assert.equal(payload.ok, true);
  assert.equal(payload.evidence.truncated, true);
  assert(Buffer.byteLength(payload.evidence.files[0].content) <= 64 * 1024);
  assert(Buffer.byteLength(JSON.stringify(payload.evidence)) <= 64 * 1024);
  assert.equal(payload.evidenceLease.usedUnits, 3);
});

test("review_context returns bounded literal matches from repository files", async () => {
  const fx = await fixture(5);
  const [response] = await mcp(fx.env, [call(1, "review_context", { query: "throw new Error", max_results: 3 })]);
  const payload = response.result.structuredContent;
  assert.equal(payload.ok, true);
  assert.equal(payload.evidence.matches.length, 1);
  assert.equal(payload.evidence.matches[0].path, "caller.mjs");
  assert.match(payload.evidence.matches[0].text, /denied/);
  assert.equal(payload.evidenceLease.usedUnits, 1);
});

test("review_context records candidates skipped after bounded search completion", async () => {
  const fx = await fixture(5);
  const [response] = await mcp(fx.env, [call(1, "review_context", { query: "allowed", max_results: 1 })]);
  const payload = response.result.structuredContent;
  const published = JSON.parse(await readFile(fx.state, "utf8"));

  assert.equal(payload.ok, true);
  assert.equal(payload.evidence.truncated, true);
  assert.deepEqual(published.filesExamined, ["auth.mjs"]);
  assert.deepEqual(published.filesSkipped, ["caller.mjs"]);
});

function initialize(id) {
  return { jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
}

function call(id, name, arguments_) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: arguments_ } };
}

function mcp(env, messages) {
  return new Promise((resolveMcp, reject) => {
    const child = spawn(process.execPath, [server], { cwd: resolve("."), env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => code === 0
      ? resolveMcp(stdout.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse))
      : reject(new Error(`Evidence MCP exited ${code}: ${stderr}`)));
    child.stdin.end(`${messages.map(JSON.stringify).join("\n")}\n`);
  });
}

function command(executable, args, cwd) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolveCommand() : reject(new Error(`${executable} exited ${code}`)));
  });
}

async function waitForPath(path) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { await access(path); return; }
    catch { await new Promise(resolveWait => setTimeout(resolveWait, 10)); }
  }
  throw new Error(`Timed out waiting for ${path}`);
}
