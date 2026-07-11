import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";

const PLUGIN_DATA = process.env.PLUGIN_DATA ?? process.env.CLAUDE_PLUGIN_DATA;
const CONFIG_ROOT = process.env.CLAUDE_COMPANION_CONFIG_ROOT ?? (PLUGIN_DATA ? join(PLUGIN_DATA, "config") : join(homedir(), ".codex", "claude-companion"));
const REVIEW_GATE_PATH = join(CONFIG_ROOT, "review-gate.json");

export async function readReviewGateConfig() {
  const environment = process.env.CLAUDE_COMPANION_REVIEW_GATE;
  if (environment !== undefined && environment !== "") return { enabled: booleanValue(environment, "CLAUDE_COMPANION_REVIEW_GATE"), path: REVIEW_GATE_PATH, source: "environment" };
  try {
    const value = JSON.parse(await readFile(REVIEW_GATE_PATH, "utf8"));
    return { enabled: value.enabled === true, path: REVIEW_GATE_PATH, source: "file" };
  } catch (error) {
    if (error.code === "ENOENT") return { enabled: false, path: REVIEW_GATE_PATH, source: "default" };
    throw error;
  }
}

function booleanValue(value, name) {
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be one of: 1, 0, true, false, yes, no, on, off`);
}

export async function setReviewGateEnabled(enabled) {
  await mkdir(CONFIG_ROOT, { recursive: true });
  await writeFile(REVIEW_GATE_PATH, `${JSON.stringify({ enabled, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  return { enabled, path: REVIEW_GATE_PATH };
}

const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  task: Object.freeze({ model: null, maxTurns: null, maxBudgetUsd: null }),
  review: Object.freeze({ base: null }),
  jobs: Object.freeze({ backgroundTimeoutMs: 3_600_000 })
});

export async function loadRuntimeConfig({ cwd = process.cwd(), env = process.env, home = homedir() } = {}) {
  const user = env.CLAUDE_COMPANION_CONFIG_FILE ?? join(home, ".codex", "claude-companion", "config.json");
  const project = await findProjectConfig(cwd);
  const environment = {
    task: {
      model: emptyToNull(env.CLAUDE_COMPANION_MODEL),
      maxTurns: numberOrNull(env.CLAUDE_COMPANION_MAX_TURNS),
      maxBudgetUsd: numberOrNull(env.CLAUDE_COMPANION_MAX_BUDGET_USD)
    },
    review: { base: emptyToNull(env.CLAUDE_COMPANION_REVIEW_BASE) },
    jobs: { backgroundTimeoutMs: numberOrNull(env.CLAUDE_COMPANION_BACKGROUND_TIMEOUT_MS) }
  };
  const userValue = await readOptionalConfig(user);
  const projectValue = project ? await readOptionalConfig(project) : {};
  const merged = mergeConfig(DEFAULT_RUNTIME_CONFIG, environment, userValue, projectValue);
  validateRuntimeConfig(merged);
  return { ...merged, sources: { user, project } };
}

async function findProjectConfig(start) {
  let current = start;
  while (true) {
    const candidate = join(current, ".codex", "cc-plugin-codex.json");
    try { await readFile(candidate, "utf8"); return candidate; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) return null;
    current = parent;
  }
}

async function readOptionalConfig(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    validateShape(value, path);
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${path}: ${error.message}`);
    throw error;
  }
}

function validateShape(value, path) {
  if (!plainObject(value)) throw new Error(`Configuration ${path} must be a JSON object`);
  const allowed = { task: new Set(["model", "maxTurns", "maxBudgetUsd"]), review: new Set(["base"]), jobs: new Set(["backgroundTimeoutMs"]) };
  for (const [section, fields] of Object.entries(value)) {
    if (!allowed[section]) throw new Error(`Unknown configuration section: ${section}`);
    if (!plainObject(fields)) throw new Error(`Configuration section ${section} must be an object`);
    for (const field of Object.keys(fields)) if (!allowed[section].has(field)) throw new Error(`Unknown configuration field: ${section}.${field}`);
  }
}

function mergeConfig(...layers) {
  const output = { task: {}, review: {}, jobs: {} };
  for (const layer of layers) {
    for (const section of ["task", "review", "jobs"]) {
      for (const [key, value] of Object.entries(layer[section] ?? {})) if (value !== null && value !== undefined && value !== "") output[section][key] = value;
    }
  }
  return output;
}

function validateRuntimeConfig(config) {
  nullableString(config.task.model, "task.model");
  nullableString(config.review.base, "review.base");
  positiveInteger(config.task.maxTurns, "task.maxTurns", true);
  positiveNumber(config.task.maxBudgetUsd, "task.maxBudgetUsd", true);
  positiveInteger(config.jobs.backgroundTimeoutMs, "jobs.backgroundTimeoutMs", false);
}

function numberOrNull(value) { return value == null || value === "" ? null : Number(value); }
function emptyToNull(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function plainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nullableString(value, name) { if (value != null && (typeof value !== "string" || !value.trim())) throw new Error(`${name} must be a non-empty string or null`); }
function positiveInteger(value, name, nullable) { if (nullable && value == null) return; if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`); }
function positiveNumber(value, name, nullable) { if (nullable && value == null) return; if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`); }
