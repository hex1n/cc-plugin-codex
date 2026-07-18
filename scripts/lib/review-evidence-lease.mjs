const FILE_UNIT_BYTES = 32 * 1024;
const FINALIZE_INSTRUCTION = "No more evidence is available. Synthesize the final review now.";

export function createEvidenceLease(limitUnits) {
  assertPositiveInteger(limitUnits, "Evidence lease limit");
  return {
    limitUnits,
    usedUnits: 0,
    remainingUnits: limitUnits,
    exhausted: false,
    phase: "investigating",
    instruction: null,
    allowedCalls: 0,
    deniedCalls: 0,
    bytesReturned: 0,
    filesExamined: [],
    filesSkipped: [],
  };
}

export function evidenceUnitsFor({ kind, returnedBytes = 0 }) {
  assertNonNegativeInteger(returnedBytes, "Evidence returnedBytes");
  if (kind === "diff" || kind === "context") return 1;
  if (kind === "file") return 1 + Math.ceil(returnedBytes / FILE_UNIT_BYTES);
  throw new Error(`Unknown evidence kind: ${String(kind)}`);
}

export function consumeEvidence(lease, {
  kind,
  returnedBytes = 0,
  filesExamined = [],
  filesSkipped = [],
} = {}) {
  assertLease(lease);
  const units = evidenceUnitsFor({ kind, returnedBytes });
  if (lease.exhausted || units > lease.remainingUnits) return denyEvidence(lease);

  const usedUnits = lease.usedUnits + units;
  const exhausted = usedUnits === lease.limitUnits;
  return {
    allowed: true,
    evidence: undefined,
    units,
    lease: {
      ...lease,
      usedUnits,
      remainingUnits: lease.limitUnits - usedUnits,
      exhausted,
      phase: exhausted ? "finalizing" : "investigating",
      instruction: exhausted ? FINALIZE_INSTRUCTION : null,
      allowedCalls: lease.allowedCalls + 1,
      bytesReturned: lease.bytesReturned + returnedBytes,
      filesExamined: mergePaths(lease.filesExamined, filesExamined),
      filesSkipped: mergePaths(lease.filesSkipped, filesSkipped),
    },
  };
}

export function denyEvidence(lease) {
  assertLease(lease);
  return {
    allowed: false,
    evidence: null,
    units: 0,
    reason: lease.exhausted ? "evidence_lease_exhausted" : "insufficient_evidence_units",
    lease: {
      ...lease,
      deniedCalls: lease.deniedCalls + 1,
    },
  };
}

function assertLease(lease) {
  if (!lease || typeof lease !== "object") throw new Error("Evidence lease must be an object");
  assertPositiveInteger(lease.limitUnits, "Evidence lease limit");
  for (const key of ["usedUnits", "remainingUnits", "allowedCalls", "deniedCalls", "bytesReturned"]) {
    assertNonNegativeInteger(lease[key], `Evidence lease ${key}`);
  }
  if (lease.usedUnits + lease.remainingUnits !== lease.limitUnits) {
    throw new Error("Evidence lease unit totals are inconsistent");
  }
}

function mergePaths(current, incoming) {
  if (!Array.isArray(incoming) || incoming.some(value => typeof value !== "string")) {
    throw new Error("Evidence file lists must contain strings");
  }
  return [...new Set([...current, ...incoming])];
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}
