import { spawn } from "node:child_process";
import { chmodSync, closeSync, openSync } from "node:fs";
export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const detached = options.detached ?? (options.timeoutMs > 0 && process.platform !== "win32");
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, shell: false, detached, stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", stdoutTruncated = false, stderrTruncated = false;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { const next = appendBounded(stdout, chunk, options.maxOutputBytes); stdout = next.value; stdoutTruncated ||= next.truncated; });
    child.stderr.on("data", chunk => { const next = appendBounded(stderr, chunk, options.maxOutputBytes); stderr = next.value; stderrTruncated ||= next.truncated; });
    let timedOut = false, termination = Promise.resolve();
    const timer = options.timeoutMs > 0 ? setTimeout(() => { timedOut = true; termination = terminateProcessTree(child.pid); }, options.timeoutMs) : null;
    timer?.unref();
    child.on("error", error => { if (timer) clearTimeout(timer); reject(error); });
    child.on("close", async (code, signal) => { if (timer) clearTimeout(timer); try { await termination; resolve({ code, signal, stdout, stderr, stdoutTruncated, stderrTruncated, pid: child.pid, timedOut }); } catch (error) { reject(error); } });
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
export async function terminateProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("A positive integer PID is required");
  if (process.platform === "win32") return requireSuccessfulTermination(await runCommand("taskkill", ["/PID", String(pid), "/T", "/F"]), "taskkill");
  signalProcessTree(pid, "SIGTERM");
  if (await waitForExit(() => isProcessTreeRunning(pid), 500)) return { code: 0, signal: "SIGTERM", stdout: "", stderr: "", pid, verified: true };
  signalProcessTree(pid, "SIGKILL");
  if (!await waitForExit(() => isProcessTreeRunning(pid), 2_000)) throw new Error(`Process tree ${pid} did not exit after SIGKILL`);
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

function isProcessTreeRunning(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === "EPERM") return true; if (error.code === "ESRCH") return isProcessRunning(pid); throw error; }
}

async function waitForExit(isRunning, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isRunning() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  return !isRunning();
}
