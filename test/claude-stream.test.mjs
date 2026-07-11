import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendStreamEvent, createStreamJsonParser, progressForStreamEvent } from "../scripts/lib/claude-stream.mjs";

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

test("append-only event log excludes prompt and tool inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-stream-log-")), path = join(root, "events.jsonl");
  await appendStreamEvent(path, { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "cat super-secret" } }, { type: "text", text: "private reasoning" }] } });
  await appendStreamEvent(path, { type: "result", session_id: "session-1", result: "sensitive final response" });
  const log = await readFile(path, "utf8"), records = log.trim().split("\n").map(JSON.parse);
  assert.equal(records.length, 2); assert.equal(records[0].phase, "investigating"); assert.deepEqual(records[0].tools, ["Bash"]); assert.equal(records[1].phase, "finalizing");
  assert.doesNotMatch(log, /super-secret|private reasoning|sensitive final response/);
});
