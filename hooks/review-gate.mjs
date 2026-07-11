#!/usr/bin/env node
import { readReviewGateConfig } from "../scripts/lib/config.mjs";
import { runClaude } from "../scripts/lib/claude.mjs";
import { collectReviewContext } from "../scripts/lib/git.mjs";
import { renderPrompt, schemaPath } from "../scripts/lib/prompts.mjs";

const pass = () => ({ continue: true, suppressOutput: true });
const block = reason => ({ decision: "block", reason });

async function main() {
  const input = JSON.parse(await readStdin());
  if (input.hook_event_name !== "Stop") return pass();
  const config = await readReviewGateConfig();
  if (!config.enabled || input.stop_hook_active === true) return pass();
  const context = await collectReviewContext({ cwd: input.cwd ?? process.cwd() });
  if (context.diff === "[No diff detected.]") return pass();
  const timeoutMs = Number(process.env.CLAUDE_REVIEW_GATE_TIMEOUT_MS ?? 840_000);
  const rendered = await renderPrompt("stop-review-gate", { REVIEW_INPUT: `Repository: ${context.root}\nRange: ${context.range}\n${context.diff}` });
  const result = await runClaude({ profile: "review", prompt: rendered.text, cwd: context.root, timeoutMs, schemaPath: schemaPath("stop-gate-output") });
  const verdict = result.structuredOutput;
  if (!verdict || !["allow", "block"].includes(verdict.verdict) || typeof verdict.summary !== "string") throw new Error("Claude returned an invalid review-gate verdict");
  return verdict.verdict === "block" ? block(`Claude review found actionable issues: ${verdict.summary}`) : pass();
}

function readStdin() { return new Promise((resolve, reject) => { let value = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => { value += chunk; }); process.stdin.on("end", () => resolve(value)); process.stdin.on("error", reject); }); }

try { process.stdout.write(`${JSON.stringify(await main())}\n`); }
catch (error) { process.stdout.write(`${JSON.stringify(block(`Claude review gate could not complete: ${error.message}. Fix setup or disable the review gate explicitly.`))}\n`); }
