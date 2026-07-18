import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendStreamEvent, createReviewInitValidator, createStreamJsonParser, errorForStreamResult, progressForStreamEvent } from "../scripts/lib/claude-stream.mjs";
import { REVIEW_EVIDENCE_QUALIFIED_TOOLS, REVIEW_EVIDENCE_SERVER_KEY, REVIEW_EXPECTED_INIT_TOOLS } from "../scripts/lib/review-evidence-contract.mjs";

test("stream-json parser handles chunk boundaries and reports malformed lines", () => {
  const events = [], malformed = [];
  const parser = createStreamJsonParser({ onEvent: event => events.push(event), onMalformed: value => malformed.push(value.error.message) });
  parser.push('{"type":"system","subtype":"init"}\n{"type":"res');
  parser.push('ult","session_id":"s"}\nnot-json\n');
  parser.end();
  assert.equal(events.length, 2);
  assert.equal(events[1].type, "result");
  assert.equal(malformed.length, 1);
  assert.match(malformed[0], /JSON|unexpected/i);
});

test("stream events map to stable job phases", () => {
  assert.equal(progressForStreamEvent({ type: "system", subtype: "init", session_id: "s" }).phase, "starting");
  assert.equal(progressForStreamEvent({ type: "system", subtype: "api_retry", attempt: 2 }).phase, "retrying");
  assert.equal(progressForStreamEvent({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/secret" } }] } }).phase, "editing");
  assert.equal(progressForStreamEvent({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } }).phase, "verifying");
  assert.equal(progressForStreamEvent({ type: "result", session_id: "s" }).phase, "finalizing");
  assert.equal(progressForStreamEvent({ type: "tool_use", name: "Read" }).phase, "investigating");
  assert.equal(progressForStreamEvent({ type: "retry", attempt: 3 }).phase, "retrying");
});

test("Claude result subtypes map to actionable stable errors", () => {
  assert.deepEqual(errorForStreamResult({ type: "result", subtype: "error_max_turns", is_error: true, session_id: "s" }), {
    errorKind: "max_turns",
    upstreamErrorSubtype: "error_max_turns",
    error: "Claude reached the configured turn limit before producing a final result",
    suggestedAction: "resume_or_increase_turns",
    sessionId: "s",
    costBudgetExhausted: false,
    turnLimitReached: true
  });
  assert.equal(errorForStreamResult({ type: "result", subtype: "success" }), null);
  assert.deepEqual(errorForStreamResult({ type: "result", subtype: "error_max_budget_usd", is_error: true, session_id: "budget", total_cost_usd: 0.3, num_turns: 2, usage: { output_tokens: 9 } }), {
    errorKind: "max_budget",
    upstreamErrorSubtype: "error_max_budget_usd",
    error: "Claude reached the configured budget before producing a final result",
    suggestedAction: "increase_budget_or_reduce_scope",
    sessionId: "budget",
    usage: { output_tokens: 9 },
    totalCostUsd: 0.3,
    numTurns: 2,
    costBudgetExhausted: true,
    turnLimitReached: false,
  });
});

test("append-only event log excludes prompt and tool inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-stream-log-")), path = join(root, "events.jsonl");
  await appendStreamEvent(path, { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "cat super-secret" } }, { type: "text", text: "private reasoning" }] } });
  await appendStreamEvent(path, { type: "result", session_id: "session-1", result: "sensitive final response" });
  const log = await readFile(path, "utf8"), records = log.trim().split("\n").map(JSON.parse);
  assert.equal(records.length, 2); assert.equal(records[0].phase, "investigating"); assert.deepEqual(records[0].tools, ["Bash"]); assert.equal(records[1].phase, "finalizing");
  assert.doesNotMatch(log, /super-secret|private reasoning|sensitive final response/);
});

test("Evidence Review init requires one connected server and an exact tool set", () => {
  const validator = createReviewInitValidator();
  validator.observe({
    type: "system",
    subtype: "init",
    mcp_servers: [{ name: REVIEW_EVIDENCE_SERVER_KEY, status: "connected" }],
    tools: REVIEW_EXPECTED_INIT_TOOLS,
  });
  assert.equal(validator.assertReady(), true);

  for (const event of [
    { type: "system", subtype: "init", mcp_servers: [{ name: REVIEW_EVIDENCE_SERVER_KEY, status: "failed" }], tools: REVIEW_EXPECTED_INIT_TOOLS },
    { type: "system", subtype: "init", mcp_servers: [{ name: REVIEW_EVIDENCE_SERVER_KEY, status: "connected" }], tools: REVIEW_EVIDENCE_QUALIFIED_TOOLS },
    { type: "system", subtype: "init", mcp_servers: [{ name: REVIEW_EVIDENCE_SERVER_KEY, status: "connected" }], tools: [...REVIEW_EXPECTED_INIT_TOOLS, "Read"] },
  ]) {
    const rejected = createReviewInitValidator();
    assert.throws(() => rejected.observe(event), error => error.errorKind === "mcp_startup");
  }
  assert.throws(() => createReviewInitValidator().assertReady(), error => error.errorKind === "mcp_startup");
});
