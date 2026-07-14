import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const companion = resolve("scripts/claude-companion.mjs");
function run(args, fx) { return new Promise((resolveRun, reject) => { const child = spawn(process.execPath, [companion, ...args], { cwd: fx.cwd, env: fx.env, shell: false, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; }); child.once("error", reject); child.once("close", code => resolveRun({ code, stdout, stderr })); }); }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "claude-tracked-jobs-test-")), cwd = join(root, "workspace"), state = join(root, "state"), capture = join(root, "args.json"), fake = join(root, "claude"); await mkdir(cwd);
  await command("git", ["init", "--quiet"], cwd); await command("git", ["config", "user.email", "test@example.invalid"], cwd); await command("git", ["config", "user.name", "Test"], cwd); await writeFile(join(cwd, "base.txt"), "base\n"); await command("git", ["add", "base.txt"], cwd); await command("git", ["commit", "--quiet", "-m", "base"], cwd);
  await writeFile(fake, `#!/usr/bin/env node
import {writeFileSync} from "node:fs";if(process.argv[2]==="--version"){console.log("2.1.208 (Claude Code)");process.exit(0)}writeFileSync(process.env.CAPTURE_ARGS,JSON.stringify(process.argv.slice(2)));
const events=[
 {type:"system",subtype:"init",session_id:"stream-session"},
 {type:"assistant",message:{content:[{type:"tool_use",name:"Read",input:{file_path:"a.js"}}]}},
 {type:"assistant",message:{content:[{type:"tool_use",name:"Edit",input:{file_path:"a.js"}}]}},
 {type:"assistant",message:{content:[{type:"tool_use",name:"Bash",input:{command:"npm test"}}]}},
 {type:"result",subtype:"success",is_error:false,result:"stream complete",session_id:"stream-session"}
];
for(const event of events){console.log(JSON.stringify(event));await new Promise(r=>setTimeout(r,180))}
`); await chmod(fake, 0o755);
  return { cwd, state, capture, env: { ...process.env, CLAUDE_CODE_EXECUTABLE: fake, CLAUDE_COMPANION_STATE_ROOT: state, CLAUDE_COMPANION_WRITE_ROOT: join(root, "write-workspaces"), CAPTURE_ARGS: capture } };
}

function command(executable, args, cwd) { return new Promise((resolveCommand, reject) => { const child = spawn(executable, args, { cwd, shell: false, stdio: "ignore" }); child.once("error", reject); child.once("close", code => code === 0 ? resolveCommand() : reject(new Error(`${executable} exited ${code}`))); }); }

test("background stream exposes phases and status --wait completes", async () => {
  const fx = await fixture(), launched = await run(["task", "inspect and verify", "--background", "--json"], fx); assert.equal(launched.code, 0, launched.stderr);
  const id = JSON.parse(launched.stdout).job.id, deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const status = await run(["status", id, "--json"], fx); assert.equal(status.code, 0, status.stderr); const job = JSON.parse(status.stdout).job;
    if (job.status === "completed") break; await new Promise(resolveWait => setTimeout(resolveWait, 30));
  }
  const [workspaceState] = await readdir(fx.state), events = (await readFile(join(fx.state, workspaceState, `${id}.events.jsonl`), "utf8")).trim().split("\n").map(JSON.parse), phases = new Set(events.map(event => event.phase));
  assert.ok(phases.has("investigating"), [...phases].join(",")); assert.ok(phases.has("editing"), [...phases].join(",")); assert.ok(phases.has("verifying"), [...phases].join(","));
  const waited = await run(["status", id, "--wait", "--timeout-ms", "5000", "--poll-interval-ms", "20", "--json"], fx); assert.equal(waited.code, 0, waited.stderr); assert.equal(JSON.parse(waited.stdout).job.status, "completed");
  const args = JSON.parse(await readFile(fx.capture, "utf8")); assert.equal(args[args.indexOf("--output-format") + 1], "stream-json"); assert.ok(args.includes("--verbose"));
});

test("result without an id returns the latest finished job", async () => {
  const fx = await fixture(), launched = await run(["task", "latest", "--background", "--json"], fx); assert.equal(launched.code, 0, launched.stderr); const id = JSON.parse(launched.stdout).job.id;
  const waited = await run(["status", id, "--wait", "--timeout-ms", "5000", "--json"], fx); assert.equal(waited.code, 0, waited.stderr);
  const result = await run(["result", "--json"], fx); assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).result, "stream complete");
});

test("status --wait reports timeout without changing the running job", async () => {
  const fx = await fixture(), launched = await run(["task", "slow", "--background", "--json"], fx); assert.equal(launched.code, 0, launched.stderr); const id = JSON.parse(launched.stdout).job.id;
  const waited = await run(["status", id, "--wait", "--timeout-ms", "50", "--poll-interval-ms", "10", "--json"], fx); assert.equal(waited.code, 1); assert.match(JSON.parse(waited.stderr).error, /Timed out waiting/);
  const status = await run(["status", id, "--json"], fx); assert.ok(["running", "completed"].includes(JSON.parse(status.stdout).job.status));
  if (JSON.parse(status.stdout).job.status === "running") { const cancelled = await run(["cancel", "--json"], fx); assert.equal(cancelled.code, 0, cancelled.stderr); }
});
