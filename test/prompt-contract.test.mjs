import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { parseClaudeJson } from "../scripts/lib/claude.mjs";
import { renderError, renderResult } from "../scripts/lib/render.mjs";
import { renderPrompt } from "../scripts/lib/prompts.mjs";

test("Claude usage metadata survives parsing and result rendering", () => {
  const parsed = parseClaudeJson(JSON.stringify({ type: "result", result: "ok", session_id: "usage-session", usage: { input_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 5, output_tokens: 7 }, modelUsage: { opus: { inputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 5, outputTokens: 7 }, haiku: { inputTokens: 11, outputTokens: 13 } }, total_cost_usd: 1.25, num_turns: 4, duration_ms: 100, duration_api_ms: 90 }));
  const json = JSON.parse(renderResult(parsed, { json: true }));
  assert.equal(json.usage.output_tokens, 7);
  assert.equal(json.model_usage.opus.cacheReadInputTokens, 5);
  assert.equal(json.total_tokens, 41);
  assert.match(json.usage_summary, /tokens=41/);
  assert.equal(json.total_cost_usd, 1.25);
  assert.equal(json.num_turns, 4);
  assert.equal(json.duration_ms, 100);
  assert.match(renderResult(parsed), /Usage: tokens=41 output=7 turns=4 duration_ms=100 api_ms=90 cost_usd=1\.25/);
});

test("token totals fall back to aggregate usage and distinguish unavailable from zero", () => {
  const fallback = parseClaudeJson(JSON.stringify({ type: "result", result: "ok", usage: { input_tokens: 2, output_tokens: 5 }, modelUsage: { opus: { costUSD: 1.2 } } }));
  assert.equal(JSON.parse(renderResult(fallback, { json: true })).total_tokens, 7);
  const snake = parseClaudeJson(JSON.stringify({ type: "result", result: "ok", model_usage: { opus: { input_tokens: 3, output_tokens: 4 } } }));
  assert.equal(JSON.parse(renderResult(snake, { json: true })).total_tokens, 7);
  const unavailable = parseClaudeJson(JSON.stringify({ type: "result", result: "ok", usage: {} }));
  assert.equal(JSON.parse(renderResult(unavailable, { json: true })).total_tokens, null);
});

test("plain results expose timing and turns without token usage", () => {
  const parsed = parseClaudeJson(JSON.stringify({ type: "result", result: "ok", num_turns: 3, duration_ms: 20, duration_api_ms: 10 }));
  assert.match(renderResult(parsed), /Usage: turns=3 duration_ms=20 api_ms=10/);
});

test("Claude error payloads preserve usage before raising", () => {
  const payload = { type: "result", subtype: "error_max_budget_usd", is_error: true, session_id: "budget-session", total_cost_usd: 0.2, num_turns: 2, duration_ms: 1000, usage: { input_tokens: 10, output_tokens: 3 }, modelUsage: { sonnet: { inputTokens: 10, outputTokens: 3 } } };
  assert.throws(() => parseClaudeJson(JSON.stringify(payload)), error => {
    const rendered = JSON.parse(renderError(error, { json: true }));
    assert.equal(rendered.error_kind, "max_budget");
    assert.equal(rendered.upstream_error_subtype, "error_max_budget_usd");
    assert.equal(rendered.session_id, "budget-session");
    assert.equal(rendered.total_cost_usd, 0.2);
    assert.equal(rendered.num_turns, 2);
    assert.equal(rendered.usage.output_tokens, 3);
    return true;
  });
});

test("review schema rejects oversized structured output", () => {
  const oversized = { verdict: "approve", summary: "x".repeat(4001), findings: [], next_steps: [], coverage: { files_examined: [], files_skipped: [], areas: [] }, uncertainty: "low", budget_exhausted: false, recommended_followup: { profile: "none", focus: [], reason: "" } };
  const schema = resolve("schemas/review-output.schema.json");
  assert.throws(() => parseClaudeJson(JSON.stringify({ type: "result", is_error: false, structured_output: oversized }), { schemaPath: schema }), /maximum length/);
});

test("plan review prompt and schema enforce categorized, located findings", async () => {
  const rendered = await renderPrompt("plan-review", { SUBJECT_LABEL: "docs/plan.md", SUBJECT_FINGERPRINT: "a".repeat(64), REVIEW_BUDGET_GUIDANCE: "standard budget", PLAN_CONTENT: "# Plan\nShip it." });
  assert.match(rendered.text, /immutable snapshot|immutable single-file snapshot/i); assert.match(rendered.text, /untrusted/i); assert.doesNotMatch(rendered.text, /{{[A-Z_]+}}/);
  const schema = resolve("schemas/plan-review-output.schema.json"), base = { verdict: "needs-attention", summary: "one gap", findings: [{ category: "verification", severity: "medium", title: "No rollback test", body: "The plan omits the rollback oracle.", location: { file: "docs/plan.md", section: "Verification" }, confidence: 0.9, recommendation: "Add a rollback fixture." }], coverage: { areas_examined: ["verification"], areas_skipped: [] }, uncertainty: "low", budget_exhausted: false, recommended_followup: { profile: "none", focus: [], reason: "" } };
  assert.equal(parseClaudeJson(JSON.stringify({ type: "result", is_error: false, structured_output: base }), { schemaPath: schema }).structuredOutput.verdict, "needs-attention");
  const missingLocation = structuredClone(base); delete missingLocation.findings[0].location;
  assert.throws(() => parseClaudeJson(JSON.stringify({ type: "result", is_error: false, structured_output: missingLocation }), { schemaPath: schema }), /location.*required|required.*location/i);
  const invalidSeverity = structuredClone(base); invalidSeverity.findings[0].severity = "info";
  assert.throws(() => parseClaudeJson(JSON.stringify({ type: "result", is_error: false, structured_output: invalidSeverity }), { schemaPath: schema }), /severity.*one of|one of.*severity/i);
  const tooMany = { ...base, findings: Array.from({ length: 41 }, () => base.findings[0]) };
  assert.throws(() => parseClaudeJson(JSON.stringify({ type: "result", is_error: false, structured_output: tooMany }), { schemaPath: schema }), /maximum item count/);
});

const companion = resolve("scripts/claude-companion.mjs");

function exec(command, args, { cwd, env = process.env } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject); child.once("close", code => resolveRun({ code, stdout, stderr }));
  });
}

test("prompt templates interpolate a strict, versioned contract", async () => {
  const rendered = await renderPrompt("review", { TARGET_LABEL: "working tree", REVIEW_COLLECTION_GUIDANCE: "Inspect the supplied diff.", REVIEW_BUDGET_GUIDANCE: "Review profile: standard", REVIEW_INPUT: "diff --git a/a b/a" });
  assert.equal(rendered.name, "review"); assert.match(rendered.hash, /^[a-f0-9]{64}$/);
  assert.match(rendered.text, /<role>/); assert.match(rendered.text, /untrusted/i); assert.doesNotMatch(rendered.text, /{{[A-Z_]+}}/);
  await assert.rejects(() => renderPrompt("review", { TARGET_LABEL: "x" }), /Missing prompt variable/);
  await assert.rejects(() => renderPrompt("review", { TARGET_LABEL: "x", REVIEW_COLLECTION_GUIDANCE: "x", REVIEW_BUDGET_GUIDANCE: "x", REVIEW_INPUT: "x", EXTRA: "x" }), /Unknown prompt variable/);
  for (const name of ["adversarial-review", "stop-review-gate", "task-wrapper", "transfer-seed"]) assert.match((await readFile(resolve("prompts", `${name}.md`), "utf8")), /<role>|<task>/);
});

test("review passes a JSON Schema and returns structured output", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-prompt-contract-test-")), cwd = join(root, "workspace"), capture = join(root, "args.json"), fake = join(root, "claude");
  await mkdir(cwd); await exec("git", ["init", "--quiet"], { cwd }); await exec("git", ["config", "user.email", "test@example.com"], { cwd }); await exec("git", ["config", "user.name", "Test"], { cwd });
  await writeFile(join(cwd, "base.txt"), "base\n"); await exec("git", ["add", "base.txt"], { cwd }); await exec("git", ["commit", "--quiet", "-m", "base"], { cwd }); await writeFile(join(cwd, "base.txt"), "changed\n");
  await writeFile(fake, `#!/usr/bin/env node\nimport {writeFileSync} from "node:fs";writeFileSync(process.env.CAPTURE_ARGS,JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify({type:"result",is_error:false,result:"",structured_output:{verdict:"approve",summary:"No findings",findings:[],next_steps:[],coverage:{files_examined:["a"],files_skipped:[],areas:["diff"]},uncertainty:"low",budget_exhausted:false,recommended_followup:{profile:"none",focus:[],reason:""}},session_id:"structured-session"}));\n`); await chmod(fake, 0o755);
  const result = await exec(process.execPath, [companion, "review", "--json"], { cwd, env: { ...process.env, CLAUDE_CODE_EXECUTABLE: fake, CAPTURE_ARGS: capture } });
  assert.equal(result.code, 0, result.stderr);
  const args = JSON.parse(await readFile(capture, "utf8")), schemaIndex = args.indexOf("--json-schema");
  assert.ok(schemaIndex > 0); const schema = JSON.parse(args[schemaIndex + 1]); assert.deepEqual(schema.required, ["verdict", "summary", "findings", "next_steps", "coverage", "uncertainty", "budget_exhausted", "recommended_followup"]); assert.equal("$schema" in schema, false);
  const payload = JSON.parse(result.stdout); assert.equal(payload.structured_output.verdict, "approve"); assert.equal(payload.session_id, "structured-session");
});

test("review rejects structured output that violates its schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-prompt-schema-test-")), cwd = join(root, "workspace"), fake = join(root, "claude");
  await mkdir(cwd); await exec("git", ["init", "--quiet"], { cwd }); await exec("git", ["config", "user.email", "test@example.com"], { cwd }); await exec("git", ["config", "user.name", "Test"], { cwd });
  await writeFile(join(cwd, "base.txt"), "base\n"); await exec("git", ["add", "base.txt"], { cwd }); await exec("git", ["commit", "--quiet", "-m", "base"], { cwd }); await writeFile(join(cwd, "base.txt"), "changed\n");
  await writeFile(fake, `#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"result",is_error:false,result:"",structured_output:{verdict:"approve"},session_id:"invalid-schema"}));\n`); await chmod(fake, 0o755);
  const result = await exec(process.execPath, [companion, "review", "--json"], { cwd, env: { ...process.env, CLAUDE_CODE_EXECUTABLE: fake } });
  assert.equal(result.code, 1); assert.match(JSON.parse(result.stderr).error, /required/);
});

test("background review status exposes prompt contract metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-prompt-metadata-test-")), cwd = join(root, "workspace"), state = join(root, "state"), fake = join(root, "claude");
  await mkdir(cwd); await exec("git", ["init", "--quiet"], { cwd }); await exec("git", ["config", "user.email", "test@example.com"], { cwd }); await exec("git", ["config", "user.name", "Test"], { cwd });
  await writeFile(join(cwd, "base.txt"), "base\n"); await exec("git", ["add", "base.txt"], { cwd }); await exec("git", ["commit", "--quiet", "-m", "base"], { cwd }); await writeFile(join(cwd, "base.txt"), "changed\n");
  await writeFile(fake, `#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"result",is_error:false,result:"",structured_output:{verdict:"approve",summary:"No findings",findings:[],next_steps:[],coverage:{files_examined:["a"],files_skipped:[],areas:["diff"]},uncertainty:"low",budget_exhausted:false,recommended_followup:{profile:"none",focus:[],reason:""}},session_id:"background-review"}));\n`); await chmod(fake, 0o755);
  const fx = { cwd, env: { ...process.env, CLAUDE_CODE_EXECUTABLE: fake, CLAUDE_COMPANION_STATE_ROOT: state } };
  const launched = await exec(process.execPath, [companion, "review", "--model", "fable", "--background", "--json"], fx); assert.equal(launched.code, 0, launched.stderr);
  const id = JSON.parse(launched.stdout).job.id, deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const status = await exec(process.execPath, [companion, "status", id, "--json"], fx), job = JSON.parse(status.stdout).job;
    if (job.status === "completed") {
      assert.equal(job.prompt_name, "review"); assert.match(job.prompt_hash, /^[a-f0-9]{64}$/); assert.equal(job.review_profile, "standard"); assert.equal(job.requested_model, "fable"); assert.equal(job.budget.max_turns, 12); assert.equal(job.budget.finalize_at_turn, 9);
      const completed = await exec(process.execPath, [companion, "result", id, "--json"], fx), payload = JSON.parse(completed.stdout);
      assert.equal(payload.review_profile, "standard"); assert.equal(payload.budget.max_turns, 12); assert.equal(payload.budget.finalize_at_turn, 9);
      return;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 40));
  }
  assert.fail("Background review did not complete");
});
