import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeEvidence,
  createEvidenceLease,
  denyEvidence,
  evidenceUnitsFor,
} from "../scripts/lib/review-evidence-lease.mjs";

test("evidence units are deterministic and file reads are weighted by returned bytes", () => {
  assert.equal(evidenceUnitsFor({ kind: "diff", returnedBytes: 64 * 1024 }), 1);
  assert.equal(evidenceUnitsFor({ kind: "context", returnedBytes: 0 }), 1);
  assert.equal(evidenceUnitsFor({ kind: "file", returnedBytes: 0 }), 1);
  assert.equal(evidenceUnitsFor({ kind: "file", returnedBytes: 1 }), 2);
  assert.equal(evidenceUnitsFor({ kind: "file", returnedBytes: 32 * 1024 }), 2);
  assert.equal(evidenceUnitsFor({ kind: "file", returnedBytes: 32 * 1024 + 1 }), 3);
});

test("the final allowed response enters finalizing and later calls return no evidence", () => {
  const initial = createEvidenceLease(3);
  const first = consumeEvidence(initial, {
    kind: "diff",
    returnedBytes: 512,
    filesExamined: ["src/auth.mjs"],
  });
  assert.equal(first.allowed, true);
  assert.equal(first.lease.remainingUnits, 2);
  assert.equal(first.lease.phase, "investigating");

  const final = consumeEvidence(first.lease, {
    kind: "file",
    returnedBytes: 32 * 1024,
    filesExamined: ["test/auth.test.mjs"],
    filesSkipped: ["fixtures/binary.dat"],
  });
  assert.equal(final.allowed, true);
  assert.deepEqual(final.lease, {
    limitUnits: 3,
    usedUnits: 3,
    remainingUnits: 0,
    exhausted: true,
    phase: "finalizing",
    instruction: "No more evidence is available. Synthesize the final review now.",
    allowedCalls: 2,
    deniedCalls: 0,
    bytesReturned: 32 * 1024 + 512,
    filesExamined: ["src/auth.mjs", "test/auth.test.mjs"],
    filesSkipped: ["fixtures/binary.dat"],
  });

  const denied = denyEvidence(final.lease);
  assert.equal(denied.allowed, false);
  assert.equal(denied.evidence, null);
  assert.equal(denied.lease.usedUnits, 3);
  assert.equal(denied.lease.deniedCalls, 1);
  assert.equal(denied.lease.bytesReturned, final.lease.bytesReturned);
  assert.equal(denied.lease.phase, "finalizing");
});

test("a response that would exceed the remaining lease is denied without leaking evidence", () => {
  const lease = consumeEvidence(createEvidenceLease(2), {
    kind: "diff",
    returnedBytes: 1,
  }).lease;
  const denied = consumeEvidence(lease, {
    kind: "file",
    returnedBytes: 1,
    filesExamined: ["secret.txt"],
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.evidence, null);
  assert.equal(denied.lease.usedUnits, 1);
  assert.equal(denied.lease.deniedCalls, 1);
  assert.deepEqual(denied.lease.filesExamined, []);
});

test("invalid lease limits and evidence measurements fail closed", () => {
  assert.throws(() => createEvidenceLease(0), /positive integer/);
  assert.throws(() => evidenceUnitsFor({ kind: "shell", returnedBytes: 1 }), /Unknown evidence kind/);
  assert.throws(() => evidenceUnitsFor({ kind: "file", returnedBytes: -1 }), /non-negative integer/);
});
