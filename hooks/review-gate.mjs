#!/usr/bin/env node
import { loadRuntimeConfig, readReviewGateCache, readReviewGateConfig, writeReviewGateCache } from "../scripts/lib/config.mjs";
import { runClaude } from "../scripts/lib/claude.mjs";
import { collectReviewContext } from "../scripts/lib/git.mjs";
import { renderPrompt, schemaPath } from "../scripts/lib/prompts.mjs";
import { createHash } from "node:crypto";

const CACHE_TTL_MS = 30 * 60_000;

const pass = () => ({ continue: true, suppressOutput: true });
const block = reason => ({ decision: "block", reason });

async function main() {
  const input = JSON.parse(await readStdin());
  if (input.hook_event_name !== "Stop") return pass();
  const config = await readReviewGateConfig();
  if (!config.enabled || input.stop_hook_active === true) return pass();
  const context = await collectReviewContext({ cwd: input.cwd ?? process.cwd() });
  if (context.diff === "[No diff detected.]") return pass();
  const runtime = await loadRuntimeConfig({ cwd: context.root }), gate = runtime.review.profiles.gate;
  const key = createHash("sha256").update(context.root).update("\0").update(context.fingerprint).update("\0").update(JSON.stringify(gate)).update("\0stop-gate-v2").digest("hex");
  const cached = await readReviewGateCache();
  if (cached?.key === key && Date.now() - Date.parse(cached.cachedAt) <= CACHE_TTL_MS) return cached.verdict === "block" ? block(`Claude review found actionable issues: ${cached.summary}`) : pass();
  const rendered = await renderPrompt("stop-review-gate", { REVIEW_INPUT: `Repository: ${context.root}\nRange: ${context.range}\n${context.diff}` });
  const result = await runClaude({ profile: "review", prompt: rendered.text, cwd: context.root, model: gate.model ?? runtime.review.model, maxTurns: gate.maxTurns, maxBudgetUsd: gate.maxBudgetUsd, timeoutMs: gate.timeoutMs, schemaPath: schemaPath("stop-gate-output") });
  const verdict = result.structuredOutput;
  if (!verdict || !["allow", "block"].includes(verdict.verdict) || typeof verdict.summary !== "string") throw new Error("Claude returned an invalid review-gate verdict");
  await writeReviewGateCache({ key, verdict: verdict.verdict, summary: verdict.summary, cachedAt: new Date().toISOString() });
  return verdict.verdict === "block" ? block(`Claude review found actionable issues: ${verdict.summary}`) : pass();
}

function readStdin() { return new Promise((resolve, reject) => { let value = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => { value += chunk; }); process.stdin.on("end", () => resolve(value)); process.stdin.on("error", reject); }); }

try { process.stdout.write(`${JSON.stringify(await main())}\n`); }
catch (error) { process.stdout.write(`${JSON.stringify(block(`Claude review gate could not complete: ${error.message}. Fix setup or disable the review gate explicitly.`))}\n`); }
