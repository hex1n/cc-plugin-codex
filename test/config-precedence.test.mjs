import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { loadRuntimeConfig, readReviewGateConfig } from "../scripts/lib/config.mjs";

async function writeJson(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

test("config precedence is project over user over environment over defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-config-layers-"));
  const workspace = join(root, "repo", "nested");
  const userFile = join(root, "home", ".codex", "claude-companion", "config.json");
  await mkdir(workspace, { recursive: true });
  await writeJson(userFile, { task: { model: "user-model", maxTurns: 8, maxBudgetUsd: 3 }, review: { model: "user-review-model", profile: "quick" }, jobs: { backgroundTimeoutMs: 9000 } });
  await writeJson(join(root, "repo", ".codex", "cc-plugin-codex.json"), { task: { model: "project-model", maxTurns: 5 }, review: { model: "project-review-model", profile: "standard", profiles: { standard: { maxTurns: 10, finalizeAtTurn: 8, maxBudgetUsd: 0.8, timeoutMs: 180000 } } } });

  const config = await loadRuntimeConfig({
    cwd: workspace,
    home: join(root, "home"),
    env: { CLAUDE_COMPANION_MODEL: "env-model", CLAUDE_COMPANION_MAX_TURNS: "12", CLAUDE_COMPANION_MAX_BUDGET_USD: "7", CLAUDE_COMPANION_BACKGROUND_TIMEOUT_MS: "12000" }
  });

  assert.equal(config.task.model, "project-model");
  assert.equal(config.task.maxTurns, 5);
  assert.equal(config.task.maxBudgetUsd, 3);
  assert.equal(config.task.profile, "standard");
  assert.equal(config.task.profiles.standard.model, "sonnet");
  assert.equal(config.review.model, "project-review-model");
  assert.equal(config.review.profile, "standard");
  assert.equal(config.review.profiles.standard.maxTurns, 10);
  assert.equal(config.jobs.backgroundTimeoutMs, 9000);
  assert.equal(config.sources.project, join(root, "repo", ".codex", "cc-plugin-codex.json"));
  assert.equal(config.sources.user, userFile);
});

test("task profile overrides merge without losing inherited envelope fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-task-profile-config-")), cwd = join(root, "repo");
  await mkdir(cwd, { recursive: true });
  await writeJson(join(cwd, ".codex", "cc-plugin-codex.json"), { task: { profile: "quick", profiles: { quick: { model: "fable" } } } });
  const config = await loadRuntimeConfig({ cwd, home: join(root, "home"), env: {} });
  assert.equal(config.task.profile, "quick");
  assert.equal(config.task.profiles.quick.model, "fable");
  assert.equal(config.task.profiles.quick.effort, "low");
  assert.equal(config.task.profiles.quick.maxTurns, 4);
});

test("invalid configuration fails before Claude starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-config-invalid-"));
  const cwd = join(root, "repo");
  await mkdir(cwd, { recursive: true });
  await writeJson(join(cwd, ".codex", "cc-plugin-codex.json"), { task: { maxTurns: 0 } });
  await assert.rejects(() => loadRuntimeConfig({ cwd, home: join(root, "home"), env: {} }), /maxTurns.*positive integer/i);
});

test("review profiles cannot exceed absolute safety ceilings", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-config-ceiling-test-")), cwd = join(root, "repo"); await mkdir(join(cwd, ".codex"), { recursive: true });
  await writeJson(join(cwd, ".codex", "cc-plugin-codex.json"), { review: { profiles: { deep: { maxTurns: 41 } } } });
  await assert.rejects(() => loadRuntimeConfig({ cwd, home: join(root, "home"), env: {} }), /must not exceed 40/);
  await writeJson(join(cwd, ".codex", "cc-plugin-codex.json"), { review: { profiles: { gate: { maxBudgetUsd: 0.6 } } } });
  await assert.rejects(() => loadRuntimeConfig({ cwd, home: join(root, "home"), env: {} }), /Stop gate safety ceiling/);
});

test("review gate environment override is explicit and validated", async () => {
  const previous = process.env.CLAUDE_COMPANION_REVIEW_GATE;
  try {
    process.env.CLAUDE_COMPANION_REVIEW_GATE = "on";
    const enabled = await readReviewGateConfig();
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.source, "environment");
    process.env.CLAUDE_COMPANION_REVIEW_GATE = "off";
    assert.equal((await readReviewGateConfig()).enabled, false);
    process.env.CLAUDE_COMPANION_REVIEW_GATE = "maybe";
    await assert.rejects(() => readReviewGateConfig(), /must be one of/);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_COMPANION_REVIEW_GATE;
    else process.env.CLAUDE_COMPANION_REVIEW_GATE = previous;
  }
});
