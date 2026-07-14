import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";

const PLUGIN_DATA = process.env.PLUGIN_DATA ?? process.env.CLAUDE_PLUGIN_DATA;
const CONFIG_ROOT = process.env.CLAUDE_COMPANION_CONFIG_ROOT ?? (PLUGIN_DATA ? join(PLUGIN_DATA, "config") : join(homedir(), ".codex", "claude-companion"));
const REVIEW_GATE_PATH = join(CONFIG_ROOT, "review-gate.json");
const REVIEW_GATE_CACHE_PATH = join(CONFIG_ROOT, "review-gate-cache.json");
const REVIEW_HARD_LIMITS = Object.freeze({ maxTurns: 40, maxBudgetUsd: 5, timeoutMs: 900_000 });
const PROFILE_NAMES = Object.freeze(["quick", "standard", "deep"]);
const EFFORT_LEVELS = Object.freeze(["low", "medium", "high"]);

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

export async function readReviewGateCache() {
  try { return JSON.parse(await readFile(REVIEW_GATE_CACHE_PATH, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function writeReviewGateCache(value) {
  await mkdir(CONFIG_ROOT, { recursive: true });
  await writeFile(REVIEW_GATE_CACHE_PATH, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return { ...value, path: REVIEW_GATE_CACHE_PATH };
}

const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  task: Object.freeze({
    profile: "standard",
    model: null,
    effort: null,
    maxTurns: null,
    finalizeAtTurn: null,
    maxBudgetUsd: null,
    timeoutMs: null,
    profiles: Object.freeze({
      quick: Object.freeze({ model: "sonnet", effort: "low", maxTurns: 4, finalizeAtTurn: 3, maxBudgetUsd: 0.5, timeoutMs: 120_000 }),
      standard: Object.freeze({ model: "sonnet", effort: "medium", maxTurns: 8, finalizeAtTurn: 6, maxBudgetUsd: 1.5, timeoutMs: 300_000 }),
      deep: Object.freeze({ model: "opus", effort: "high", maxTurns: 16, finalizeAtTurn: 12, maxBudgetUsd: 5, timeoutMs: 900_000 })
    })
  }),
  review: Object.freeze({
    base: null,
    model: null,
    profile: "standard",
    profiles: Object.freeze({
      gate: Object.freeze({ model: "sonnet", effort: "low", maxTurns: 4, finalizeAtTurn: 3, maxBudgetUsd: 0.2, timeoutMs: 90_000 }),
      quick: Object.freeze({ model: "sonnet", effort: "low", maxTurns: 6, finalizeAtTurn: 4, maxBudgetUsd: 0.3, timeoutMs: 120_000 }),
      standard: Object.freeze({ model: "sonnet", effort: "medium", maxTurns: 12, finalizeAtTurn: 9, maxBudgetUsd: 1, timeoutMs: 240_000 }),
      deep: Object.freeze({ model: "opus", effort: "high", maxTurns: 24, finalizeAtTurn: 20, maxBudgetUsd: 3, timeoutMs: 600_000 })
    })
  }),
  jobs: Object.freeze({ backgroundTimeoutMs: 3_600_000 })
});

export async function loadRuntimeConfig({ cwd = process.cwd(), env = process.env, home = homedir() } = {}) {
  const user = env.CLAUDE_COMPANION_CONFIG_FILE ?? join(home, ".codex", "claude-companion", "config.json");
  const project = await findProjectConfig(cwd);
  const environment = {
    task: {
      profile: emptyToNull(env.CLAUDE_COMPANION_TASK_PROFILE),
      model: emptyToNull(env.CLAUDE_COMPANION_MODEL),
      effort: emptyToNull(env.CLAUDE_COMPANION_EFFORT),
      maxTurns: numberOrNull(env.CLAUDE_COMPANION_MAX_TURNS),
      finalizeAtTurn: numberOrNull(env.CLAUDE_COMPANION_FINALIZE_AT_TURN),
      maxBudgetUsd: numberOrNull(env.CLAUDE_COMPANION_MAX_BUDGET_USD),
      timeoutMs: numberOrNull(env.CLAUDE_COMPANION_TASK_TIMEOUT_MS)
    },
    review: { base: emptyToNull(env.CLAUDE_COMPANION_REVIEW_BASE), model: emptyToNull(env.CLAUDE_COMPANION_REVIEW_MODEL), profile: emptyToNull(env.CLAUDE_COMPANION_REVIEW_PROFILE) },
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
  const allowed = { task: new Set(["profile", "model", "effort", "maxTurns", "finalizeAtTurn", "maxBudgetUsd", "timeoutMs", "profiles"]), review: new Set(["base", "model", "profile", "profiles"]), jobs: new Set(["backgroundTimeoutMs"]) };
  for (const [section, fields] of Object.entries(value)) {
    if (!allowed[section]) throw new Error(`Unknown configuration section: ${section}`);
    if (!plainObject(fields)) throw new Error(`Configuration section ${section} must be an object`);
    for (const field of Object.keys(fields)) if (!allowed[section].has(field)) throw new Error(`Unknown configuration field: ${section}.${field}`);
    if ((section === "task" || section === "review") && fields.profiles !== undefined) validateProfileMap(section, fields.profiles, path);
  }
}

function mergeConfig(...layers) {
  const output = { task: {}, review: {}, jobs: {} };
  for (const layer of layers) {
    for (const section of ["task", "review", "jobs"]) {
      for (const [key, value] of Object.entries(layer[section] ?? {})) if (value !== null && value !== undefined && value !== "") {
        if ((section === "task" || section === "review") && key === "profiles") {
          output[section].profiles ??= {};
          for (const [name, profile] of Object.entries(value)) output[section].profiles[name] = { ...(output[section].profiles[name] ?? {}), ...profile };
        } else output[section][key] = value;
      }
    }
  }
  return output;
}

function validateRuntimeConfig(config) {
  nullableString(config.task.model, "task.model");
  profileName(config.task.profile, "task.profile");
  nullableEnum(config.task.effort, EFFORT_LEVELS, "task.effort");
  positiveInteger(config.task.maxTurns, "task.maxTurns", true);
  positiveInteger(config.task.finalizeAtTurn, "task.finalizeAtTurn", true);
  positiveNumber(config.task.maxBudgetUsd, "task.maxBudgetUsd", true);
  positiveInteger(config.task.timeoutMs, "task.timeoutMs", true);
  if (config.task.finalizeAtTurn != null && config.task.maxTurns != null && config.task.finalizeAtTurn >= config.task.maxTurns) throw new Error("task.finalizeAtTurn must be lower than task.maxTurns");
  for (const [name, profile] of Object.entries(config.task.profiles)) validateCommonProfile(profile, `task.profiles.${name}`);
  nullableString(config.review.base, "review.base");
  nullableString(config.review.model, "review.model");
  profileName(config.review.profile, "review.profile");
  for (const [name, profile] of Object.entries(config.review.profiles)) validateReviewProfile(profile, `review.profiles.${name}`);
  positiveInteger(config.jobs.backgroundTimeoutMs, "jobs.backgroundTimeoutMs", false);
}

function numberOrNull(value) { return value == null || value === "" ? null : Number(value); }
function emptyToNull(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function plainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nullableString(value, name) { if (value != null && (typeof value !== "string" || !value.trim())) throw new Error(`${name} must be a non-empty string or null`); }
function profileName(value, name) { if (!PROFILE_NAMES.includes(value)) throw new Error(`${name} must be one of: ${PROFILE_NAMES.join(", ")}`); }
function reviewProfileKey(value, name) { if (!["gate", "quick", "standard", "deep"].includes(value)) throw new Error(`${name} must be one of: gate, quick, standard, deep`); }
function validateProfileMap(section, value, path) {
  if (!plainObject(value)) throw new Error(`Configuration field ${section}.profiles in ${path} must be an object`);
  const allowed = new Set(["model", "effort", "maxTurns", "finalizeAtTurn", "maxBudgetUsd", "timeoutMs"]);
  for (const [name, profile] of Object.entries(value)) {
    if (section === "review") reviewProfileKey(name, "review.profiles key");
    else profileName(name, "task.profiles key");
    if (!plainObject(profile)) throw new Error(`Configuration ${section}.profiles.${name} must be an object`);
    for (const key of Object.keys(profile)) if (!allowed.has(key)) throw new Error(`Unknown configuration field: ${section}.profiles.${name}.${key}`);
  }
}
function validateReviewProfile(profile, name) {
  validateCommonProfile(profile, name);
  if (profile.maxTurns > REVIEW_HARD_LIMITS.maxTurns) throw new Error(`${name}.maxTurns must not exceed ${REVIEW_HARD_LIMITS.maxTurns}`);
  if (profile.maxBudgetUsd > REVIEW_HARD_LIMITS.maxBudgetUsd) throw new Error(`${name}.maxBudgetUsd must not exceed ${REVIEW_HARD_LIMITS.maxBudgetUsd}`);
  if (profile.timeoutMs > REVIEW_HARD_LIMITS.timeoutMs) throw new Error(`${name}.timeoutMs must not exceed ${REVIEW_HARD_LIMITS.timeoutMs}`);
  if (name.endsWith(".gate") && (profile.maxTurns > 6 || profile.maxBudgetUsd > 0.5 || profile.timeoutMs > 120_000)) throw new Error(`${name} exceeds the Stop gate safety ceiling`);
}
function validateCommonProfile(profile, name) {
  nullableString(profile.model, `${name}.model`);
  enumValue(profile.effort, EFFORT_LEVELS, `${name}.effort`);
  positiveInteger(profile.maxTurns, `${name}.maxTurns`, false);
  positiveInteger(profile.finalizeAtTurn, `${name}.finalizeAtTurn`, false);
  if (profile.finalizeAtTurn >= profile.maxTurns) throw new Error(`${name}.finalizeAtTurn must be lower than maxTurns`);
  positiveNumber(profile.maxBudgetUsd, `${name}.maxBudgetUsd`, false);
  positiveInteger(profile.timeoutMs, `${name}.timeoutMs`, false);
}
function nullableEnum(value, values, name) { if (value != null) enumValue(value, values, name); }
function enumValue(value, values, name) { if (!values.includes(value)) throw new Error(`${name} must be one of: ${values.join(", ")}`); }
function positiveInteger(value, name, nullable) { if (nullable && value == null) return; if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`); }
function positiveNumber(value, name, nullable) { if (nullable && value == null) return; if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`); }
