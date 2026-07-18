import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

import { pluginPath } from "./paths.mjs";
import { TASK_EXECUTION_SERVER_KEY } from "./task-execution-contract.mjs";

const SERVER_PATH = pluginPath("scripts", "task-execution-mcp.mjs");

export async function prepareTaskExecutionRuntime() {
  const parent = process.env.CLAUDE_COMPANION_TASK_CONTROL_ROOT ?? tmpdir();
  const controlRoot = await realpath(await mkdtemp(join(parent, "cc-plugin-task-execution-")));
  await chmod(controlRoot, 0o700);
  const statePath = join(controlRoot, "task-state.json");
  const mcpConfigPath = join(controlRoot, "mcp.json");
  const config = {
    mcpServers: {
      [TASK_EXECUTION_SERVER_KEY]: {
        command: process.execPath,
        args: [SERVER_PATH],
        cwd: controlRoot,
        env: { TASK_EXECUTION_STATE_PATH: statePath },
      },
    },
  };
  await writeFile(mcpConfigPath, `${JSON.stringify(config)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(mcpConfigPath, 0o600);
  return { controlRoot, statePath, mcpConfigPath };
}

export async function cleanupTaskExecutionRuntime(runtime) {
  if (runtime?.controlRoot) await rm(runtime.controlRoot, { recursive: true, force: true });
}

export async function readTaskExecutionState(path, { expectedParentPid } = {}) {
  if (!path || !isAbsolute(path)) throw taskStateError("Task execution state path is invalid");
  const canonical = await realpath(path).catch(() => null);
  if (!canonical || canonical !== path) throw taskStateError("Task execution state path is missing or not canonical");
  const [fileInfo, directoryInfo] = await Promise.all([lstat(canonical), lstat(dirname(canonical))]);
  if (!fileInfo.isFile() || (fileInfo.mode & 0o777) !== 0o600) throw taskStateError("Task execution state file permissions are invalid");
  if (!directoryInfo.isDirectory() || (directoryInfo.mode & 0o777) !== 0o700) throw taskStateError("Task execution control directory permissions are invalid");
  let value;
  try { value = JSON.parse(await readFile(canonical, "utf8")); }
  catch (error) { throw taskStateError("Task execution state is invalid: " + error.message); }
  if (!Number.isInteger(value.revision) || value.revision <= 0) throw taskStateError("Task execution state revision is invalid");
  if (!Number.isInteger(value.serverPid) || !Number.isInteger(value.serverPpid)) throw taskStateError("Task execution server ownership is invalid");
  if (expectedParentPid != null && value.serverPpid !== expectedParentPid) throw taskStateError("Task execution server parent does not match Claude");
  if (!["working", "checkpointed", "completed"].includes(value.phase)) throw taskStateError("Task execution phase is invalid");
  if (!Number.isInteger(value.checkpointCalls) || value.checkpointCalls < 0 || !Number.isInteger(value.completionCalls) || value.completionCalls < 0) throw taskStateError("Task execution call totals are invalid");
  if (value.phase === "checkpointed" && !value.checkpoint) throw taskStateError("Checkpointed task state has no checkpoint receipt");
  if (value.phase === "completed" && !value.completion) throw taskStateError("Completed task state has no completion receipt");
  return value;
}

function taskStateError(message) {
  return Object.assign(new Error(message), { errorKind: "mcp_startup", suggestedAction: "inspect_task_execution_runtime" });
}
