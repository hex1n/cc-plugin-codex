import { spawn } from "node:child_process";
import { resolve } from "node:path";

const server = resolve("mcp/server.mjs");

export async function callMcp(env, name, arguments_) {
  const response = await callMcpRaw(env, name, arguments_);
  if (response.error) throw Object.assign(new Error(response.error.message), { response });
  return response.result.structuredContent;
}

export async function callMcpRaw(env, name, arguments_) {
  const input = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: arguments_ } })}\n`;
  const outcome = await spawnCapture(process.execPath, [server], { cwd: resolve("."), env, stdin: input });
  if (outcome.code !== 0) throw new Error(`MCP server exited ${outcome.code}: ${outcome.stderr}`);
  return outcome.stdout.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse).find(value => value.id === 1);
}

function spawnCapture(command, args, { cwd, env, stdin }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject); child.once("close", code => resolveRun({ code, stdout, stderr })); child.stdin.end(stdin);
  });
}
