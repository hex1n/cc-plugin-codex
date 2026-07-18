import { appendFile, chmod } from "node:fs/promises";
import { REVIEW_EVIDENCE_SERVER_KEY, REVIEW_EXPECTED_INIT_TOOLS } from "./review-evidence-contract.mjs";

/**
 * Incrementally parse Claude's newline-delimited stream-json output.
 *
 * Claude writes one JSON object per line, but a child-process `data` event is
 * not guaranteed to align with those lines. Keeping the framing here avoids
 * every caller having to reimplement the same (and subtly broken) buffering.
 * Malformed lines are reported without including their contents in the
 * callback, so callers can safely persist the error while keeping prompts and
 * tool arguments out of job logs.
 */
export function createStreamJsonParser({ onEvent = () => {}, onMalformed = () => {} } = {}) {
  let pending = "";
  let ended = false;

  function consumeLine(line) {
    const value = line.trim();
    if (!value) return;
    let event;
    try {
      event = JSON.parse(value);
    } catch (error) {
      onMalformed({ error: error instanceof Error ? error : new Error(String(error)) });
      return;
    }
    onEvent(event);
  }

  return {
    push(chunk) {
      if (ended) throw new Error("Cannot push to an ended stream-json parser");
      pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    },
    end() {
      if (ended) return;
      ended = true;
      if (pending.trim()) consumeLine(pending);
      pending = "";
    }
  };
}

export function parseStreamJson(text, options = {}) {
  const parser = createStreamJsonParser(options);
  parser.push(text);
  parser.end();
}

export function createReviewInitValidator() {
  let ready = false;
  return {
    observe(event) {
      if (event?.type !== "system" || event.subtype !== "init") return false;
      const serversValue = event.mcp_servers ?? event.mcpServers ?? [];
      const servers = Array.isArray(serversValue)
        ? serversValue
        : Object.entries(serversValue).map(([name, value]) => ({ name, ...(typeof value === "object" ? value : { status: value }) }));
      const server = servers.find(value => (value.name ?? value.server) === REVIEW_EVIDENCE_SERVER_KEY);
      if (!server || server.status !== "connected") throw mcpStartupError("Required review evidence MCP server is not connected");
      const actual = (event.tools ?? []).map(value => typeof value === "string" ? value : value?.name).filter(Boolean);
      const expected = [...REVIEW_EXPECTED_INIT_TOOLS];
      if (actual.length !== new Set(actual).size || !sameSet(actual, expected)) {
        throw mcpStartupError(`Claude init tool set does not exactly match the review evidence contract (expected ${expected.join(", ")})`);
      }
      ready = true;
      return true;
    },
    assertReady() {
      if (!ready) throw mcpStartupError("Claude returned no valid review evidence MCP init event");
      return true;
    },
  };
}

export function progressForStreamEvent(event) {
  if (event?.type === "system" && event.subtype === "api_retry") return { phase: "retrying", progressMessage: `API retry ${event.attempt ?? ""}`.trim() };
  if (event?.type === "retry") return { phase: "retrying", progressMessage: `API retry ${event.attempt ?? ""}`.trim() };
  if (event?.type === "system" && event.subtype === "init") return { phase: "starting", progressMessage: "Claude session initialized", ...(event.session_id ? { sessionId: event.session_id } : {}) };
  if (event?.type === "system" && event.subtype === "plugin_install") return { phase: "investigating", progressMessage: "Claude is preparing a plugin" };
  if (event?.type === "result") return { phase: "finalizing", progressMessage: event.is_error ? "Claude returned an error result" : "Claude returned its final result", ...(event.session_id ? { sessionId: event.session_id } : {}) };
  if (event?.type === "user" && toolResultUses(event).length) return { phase: "investigating", progressMessage: "Claude received tool output" };
  if (event?.type !== "assistant" && event?.type !== "tool_use") return null;
  const tools = toolUses(event);
  if (tools.some(tool => ["Edit", "Write", "NotebookEdit"].includes(tool.name))) return { phase: "editing", progressMessage: "Claude is editing files" };
  const bash = tools.find(tool => tool.name === "Bash"), command = bash?.input?.command ?? "";
  if (bash && /(^|\s)(test|npm test|npm run|pnpm test|yarn test|pytest|cargo test|go test|mvn test|gradle test)/i.test(command)) return { phase: "verifying", progressMessage: "Claude is running verification" };
  if (tools.length) return { phase: "investigating", progressMessage: `Claude is using ${tools.map(tool => tool.name).join(", ")}` };
  return { phase: "investigating", progressMessage: "Claude is reasoning about the task" };
}

export function errorForStreamResult(event) {
  if (event?.type !== "result" || event.is_error !== true) return null;
  const subtype = event.subtype ?? "unknown";
  const modelUsage = event.modelUsage ?? event.model_usage;
  const common = { upstreamErrorSubtype: subtype, ...(event.session_id ? { sessionId: event.session_id } : {}), ...present("usage", event.usage), ...present("modelUsage", modelUsage), ...present("effectiveModels", modelUsage && typeof modelUsage === "object" ? Object.keys(modelUsage) : null), ...present("totalCostUsd", event.total_cost_usd ?? event.totalCostUsd), ...present("numTurns", event.num_turns ?? event.numTurns), ...present("durationMs", event.duration_ms ?? event.durationMs), ...present("durationApiMs", event.duration_api_ms ?? event.durationApiMs) };
  if (subtype === "error_max_turns") return { errorKind: "max_turns", ...common, error: "Claude reached the configured turn limit before producing a final result", suggestedAction: "resume_or_increase_turns", costBudgetExhausted: false, turnLimitReached: true };
  if (subtype === "error_max_budget_usd") return { errorKind: "max_budget", ...common, error: "Claude reached the configured budget before producing a final result", suggestedAction: "increase_budget_or_reduce_scope", costBudgetExhausted: true, turnLimitReached: false };
  if (subtype === "error_during_execution") return { errorKind: "claude_execution", ...common, error: "Claude reported an execution error", suggestedAction: "inspect_stderr_or_resume" };
  return { errorKind: "claude_result", ...common, error: `Claude returned an error result (${subtype})`, suggestedAction: "inspect_stderr_or_resume" };
}

export async function appendStreamEvent(path, event, now = new Date()) {
  const progress = progressForStreamEvent(event);
  if (!progress) return;
  const record = { at: now.toISOString(), event: event.type, subtype: event.subtype ?? null, phase: progress.phase, message: progress.progressMessage, tools: toolUses(event).map(tool => tool.name), sessionId: progress.sessionId ?? null };
  await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

function toolUses(event) {
  const content = [...(event?.message?.content ?? []), ...(event?.content ?? [])];
  if (event?.type === "tool_use" && typeof event.name === "string") content.push(event);
  return content.filter(part => part?.type === "tool_use" && typeof part.name === "string");
}

function toolResultUses(event) {
  const content = [...(event?.message?.content ?? []), ...(event?.content ?? [])];
  return content.filter(part => part?.type === "tool_result" || part?.type === "tool_output");
}
function present(key, value) { return value == null ? {} : { [key]: value }; }

function sameSet(left, right) {
  return left.length === right.length && left.every(value => right.includes(value));
}

function mcpStartupError(message) {
  return Object.assign(new Error(message), { errorKind: "mcp_startup", suggestedAction: "inspect_review_evidence_runtime" });
}
