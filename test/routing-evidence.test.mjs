import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("plan-review routing evidence covers external, local, implementation, and code intents", async () => {
  const evidence = JSON.parse(await readFile(resolve("config/plan-review-routing-evidence.json"), "utf8"));
  assert.equal(evidence.samples.length, 20);
  assert.equal(evidence.result.passed, 20); assert.equal(evidence.result.failed, 0);
  assert(evidence.samples.some(sample => sample.intent === "review-plan" && sample.externalModelExplicit && sample.expectedRoute === "claude-plan-review"));
  assert(evidence.samples.some(sample => sample.intent === "review-plan" && !sample.externalModelExplicit && sample.expectedRoute === "local-plan-review"));
  assert(evidence.samples.some(sample => sample.intent === "implement-plan" && sample.expectedRoute === "claude-task"));
  assert(evidence.samples.every(sample => !(sample.intent === "review-plan" && sample.expectedRoute === "claude-task")));
  assert(evidence.samples.every(sample => sample.outcome === "pass"));
});
