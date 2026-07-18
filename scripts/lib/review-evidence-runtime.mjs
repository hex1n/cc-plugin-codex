import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { STATE_ROOT } from "./state.mjs";
import {
  REVIEW_EVIDENCE_QUALIFIED_TOOLS,
  REVIEW_EVIDENCE_SERVER_KEY,
  REVIEW_EXPECTED_INIT_TOOLS,
} from "./review-evidence-contract.mjs";

const SERVER_PATH = fileURLToPath(new URL("../review-evidence-mcp.mjs", import.meta.url));

export async function prepareReviewEvidenceRuntime({
  workspaceRoot,
  stateRoot = STATE_ROOT,
  base = null,
  evidenceUnits,
} = {}) {
  const root = await realpath(workspaceRoot);
  if (!Number.isSafeInteger(evidenceUnits) || evidenceUnits <= 0) {
    throw new Error("Review evidenceUnits must be a positive integer");
  }
  const controlRoot = join(stateRoot, "review-controls", randomUUID());
  const executionCwd = join(controlRoot, "cwd");
  const mcpConfigPath = join(controlRoot, "mcp.json");
  const leaseStatePath = join(controlRoot, "lease-state.json");
  await mkdir(executionCwd, { recursive: true, mode: 0o700 });
  await chmod(controlRoot, 0o700);
  await chmod(executionCwd, 0o700);
  const config = {
    mcpServers: {
      [REVIEW_EVIDENCE_SERVER_KEY]: {
        command: process.execPath,
        args: [SERVER_PATH],
        env: {
          REVIEW_ROOT: root,
          REVIEW_BASE: base ?? "HEAD",
          REVIEW_LEASE_UNITS: String(evidenceUnits),
          REVIEW_LEASE_STATE_PATH: leaseStatePath,
        },
      },
    },
  };
  await writeFile(mcpConfigPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(mcpConfigPath, 0o600);
  return {
    controlRoot,
    executionCwd,
    mcpConfigPath,
    leaseStatePath,
    evidenceUnits,
    allowedTools: REVIEW_EVIDENCE_QUALIFIED_TOOLS,
    expectedInitTools: REVIEW_EXPECTED_INIT_TOOLS,
  };
}

export async function cleanupReviewEvidenceRuntime(runtime) {
  if (runtime?.controlRoot) await rm(runtime.controlRoot, { recursive: true, force: true });
}

export async function readReviewEvidenceState(path, { expectedParentPid = null } = {}) {
  let value;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { throw mcpStateError(`Review evidence lease state is unavailable or invalid: ${error.message}`); }
  for (const key of ["revision", "serverPid", "serverPpid", "limitUnits", "usedUnits", "remainingUnits", "allowedCalls", "deniedCalls", "bytesReturned"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < (key === "revision" || key === "serverPid" || key === "serverPpid" || key === "limitUnits" ? 1 : 0)) {
      throw mcpStateError(`Review evidence lease state has invalid ${key}`);
    }
  }
  if (expectedParentPid != null && value.serverPpid !== expectedParentPid) throw mcpStateError("Review evidence MCP parent PID does not match the Claude process");
  if (value.usedUnits + value.remainingUnits !== value.limitUnits) throw mcpStateError("Review evidence lease unit totals are inconsistent");
  if (!new Set(["investigating", "finalizing"]).has(value.phase)) throw mcpStateError("Review evidence lease phase is invalid");
  if (value.exhausted !== (value.remainingUnits === 0)) throw mcpStateError("Review evidence lease exhaustion state is inconsistent");
  if (!Array.isArray(value.filesExamined) || !Array.isArray(value.filesSkipped)) throw mcpStateError("Review evidence file metrics are invalid");
  return value;
}

function mcpStateError(message) {
  return Object.assign(new Error(message), { errorKind: "mcp_startup", suggestedAction: "inspect_review_evidence_runtime" });
}
