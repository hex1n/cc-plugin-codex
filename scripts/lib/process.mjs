import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, openSync } from "node:fs";
export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const detached = options.detached ?? (options.timeoutMs > 0 && process.platform !== "win32");
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, shell: false, detached, stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", stdoutTruncated = false, stderrTruncated = false;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    let inspectionError = null;
    child.stdout.on("data", chunk => {
      const next = appendBounded(stdout, chunk, options.maxOutputBytes); stdout = next.value; stdoutTruncated ||= next.truncated;
      if (!inspectionError && options.onStdoutChunk) {
        try { options.onStdoutChunk(chunk); }
        catch (error) { inspectionError = error; termination = termination.then(() => terminateProcessTree(child.pid)); }
      }
    });
    child.stderr.on("data", chunk => { const next = appendBounded(stderr, chunk, options.maxOutputBytes); stderr = next.value; stderrTruncated ||= next.truncated; });
    let timedOut = false, termination = Promise.resolve();
    const timer = options.timeoutMs > 0 ? setTimeout(() => { timedOut = true; termination = terminateProcessTree(child.pid); }, options.timeoutMs) : null;
    timer?.unref();
    child.on("error", error => { if (timer) clearTimeout(timer); reject(error); });
    child.on("close", async (code, signal) => { if (timer) clearTimeout(timer); try { await termination; resolve({ code, signal, stdout, stderr, stdoutTruncated, stderrTruncated, pid: child.pid, timedOut, inspectionError }); } catch (error) { reject(error); } });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
  });
}
function appendBounded(current, chunk, maxBytes) {
  if (!(maxBytes > 0)) return { value: current + chunk, truncated: false };
  const remaining = maxBytes - Buffer.byteLength(current);
  if (remaining <= 0) return { value: current, truncated: Boolean(chunk) };
  const bytes = Buffer.from(chunk);
  if (bytes.length <= remaining) return { value: current + chunk, truncated: false };
  return { value: current + bytes.subarray(0, remaining).toString("utf8"), truncated: true };
}
export function spawnDetached(command, args, { cwd, env = process.env, stdoutPath, stderrPath }) {
  return new Promise((resolve, reject) => {
    const stdout = openSync(stdoutPath, "a", 0o600);
    const stderr = openSync(stderrPath, "a", 0o600);
    chmodSync(stdoutPath, 0o600); chmodSync(stderrPath, 0o600);
    const child = spawn(command, args, { cwd, env, shell: false, detached: true, stdio: ["ignore", stdout, stderr] });
    const closeLogs = () => { closeSync(stdout); closeSync(stderr); };
    child.once("error", error => { closeLogs(); reject(error); });
    child.once("spawn", () => { closeLogs(); child.unref(); resolve({ pid: child.pid }); });
  });
}
export function spawnDetachedSilent(command, args, { cwd, env = process.env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve({ pid: child.pid }); });
  });
}
export function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "EPERM") return true; if (error.code === "ESRCH") return false; throw error; }
}
export async function terminateProcessTree(pid, { graceMs = 500, killWaitMs = 2_000 } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("A positive integer PID is required");
  if (process.platform === "win32") return requireSuccessfulTermination(await runCommand("taskkill", ["/PID", String(pid), "/T", "/F"]), "taskkill");
  signalProcessTree(pid, "SIGTERM");
  if (await waitForExit(() => isProcessTreeRunning(pid), graceMs)) return { code: 0, signal: "SIGTERM", stdout: "", stderr: "", pid, verified: true };
  signalProcessTree(pid, "SIGKILL");
  if (!await waitForExit(() => isProcessTreeRunning(pid), killWaitMs)) throw new Error(`Process tree ${pid} did not exit after SIGKILL`);
  return { code: 0, signal: "SIGKILL", stdout: "", stderr: "", pid, verified: true };
}

export async function terminateDescendantTree(pid, { graceMs = 500, killWaitMs = 2_000 } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("A positive integer PID is required");
  if (process.platform === "win32") return requireSuccessfulTermination(await runCommand("taskkill", ["/PID", String(pid), "/T", "/F"]), "taskkill");
  const initial = descendantPids(pid);
  signalPids([pid, ...initial], "SIGTERM");
  if (await waitForExit(() => [pid, ...initial].some(isProcessRunning), graceMs)) return { code: 0, signal: "SIGTERM", stdout: "", stderr: "", pid, verified: true };
  const remaining = [...new Set([pid, ...initial, ...descendantPids(pid)])];
  signalPids(remaining, "SIGKILL");
  if (!await waitForExit(() => remaining.some(isProcessRunning), killWaitMs)) throw new Error(`Descendant tree ${pid} did not exit after SIGKILL`);
  return { code: 0, signal: "SIGKILL", stdout: "", stderr: "", pid, verified: true };
}

export function requireSuccessfulTermination(result, command = "process termination") {
  if (result.code === 0) return result;
  throw new Error(result.stderr?.trim() || `${command} exited with code ${result.code}`);
}

function signalProcessTree(pid, signal) {
  try { process.kill(-pid, signal); }
  catch (error) {
    if (error.code === "ESRCH") { try { process.kill(pid, signal); } catch (inner) { if (inner.code !== "ESRCH") throw inner; } }
    else throw error;
  }
}

function descendantPids(rootPid) {
  const result = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", timeout: 5_000 });
  if (result.status !== 0) return [];
  const children = new Map();
  for (const line of result.stdout.split(/\r?\n/)) {
    const [pidValue, parentValue] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pidValue) || !Number.isInteger(parentValue)) continue;
    const values = children.get(parentValue) ?? [];
    values.push(pidValue);
    children.set(parentValue, values);
  }
  const descendants = [], pending = [...(children.get(rootPid) ?? [])];
  while (pending.length) {
    const current = pending.pop();
    descendants.push(current);
    pending.push(...(children.get(current) ?? []));
  }
  return descendants;
}

function signalPids(pids, signal) {
  for (const pid of [...pids].reverse()) {
    try { process.kill(pid, signal); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}

function isProcessTreeRunning(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === "EPERM") return true; if (error.code === "ESRCH") return isProcessRunning(pid); throw error; }
}

async function waitForExit(isRunning, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isRunning() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  return !isRunning();
}
