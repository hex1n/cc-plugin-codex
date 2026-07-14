import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { pluginPath } from "./paths.mjs";
import { runCommand } from "./process.mjs";

export const SANDBOX_POLICY_VERSION = 1;
export const SANDBOX_COMPATIBILITY_PATH = pluginPath("config", "sandbox-compatibility.json");

const POLICY_TEMPLATE = Object.freeze({
  permissions: {
    defaultMode: "acceptEdits",
    deny: [
      "Read(~/.ssh/**)",
      "Read(~/.aws/**)",
      "Read(~/.gnupg/**)",
      "Read(~/.config/gcloud/**)",
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(<SOURCE_ROOT>/**)",
      "Read(<ARTIFACT_ROOT>/**)",
      "Read(<STATE_ROOT>/**)",
      "Edit(<SOURCE_ROOT>/**)",
      "Edit(<ARTIFACT_ROOT>/**)",
      "Edit(<STATE_ROOT>/**)",
      "Edit(<ISOLATED_ROOT>/.git/**)"
    ]
  },
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      allowWrite: ["<ISOLATED_ROOT>"],
      denyWrite: ["<SOURCE_ROOT>", "<ARTIFACT_ROOT>", "<STATE_ROOT>", "<ISOLATED_ROOT>/.git"],
      denyRead: ["<SOURCE_ROOT>", "<ARTIFACT_ROOT>", "<STATE_ROOT>", "~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gcloud", "~/.codex/claude-companion"]
    }
  }
});

export class WriteCapabilityUnavailableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "WriteCapabilityUnavailableError";
    this.errorKind = "write_capability_unavailable";
    Object.assign(this, details);
  }
}

export function sandboxPolicyHash() {
  return createHash("sha256").update(canonicalJson({ policyVersion: SANDBOX_POLICY_VERSION, settings: POLICY_TEMPLATE })).digest("hex");
}

export function evaluateSandboxCompatibility({ manifest, claudeVersion, executableSha256, platform, prerequisites }) {
  if (!prerequisites?.available) return { available: false, backend: null, reason: prerequisites?.reason ?? "Sandbox prerequisites are unavailable" };
  if (manifest?.schemaVersion !== 1 || manifest?.policyVersion !== SANDBOX_POLICY_VERSION) return { available: false, backend: null, reason: "Sandbox compatibility schema or policy version is not verified" };
  if (manifest.policyHash !== sandboxPolicyHash()) return { available: false, backend: null, reason: "Sandbox policy hash is not verified" };
  const entry = manifest.entries?.find(candidate => candidate.claudeVersion === claudeVersion && candidate.platform === platform);
  if (!entry) return { available: false, backend: null, reason: `Claude version ${claudeVersion} on platform ${platform} is not in the sandbox compatibility manifest` };
  if (!executableSha256 || entry.executableSha256 !== executableSha256) return { available: false, backend: null, reason: "Claude executable identity is not verified" };
  if (entry.enforcementVerified !== true) return { available: false, backend: null, reason: "Sandbox enforcement has not been verified for this version and platform" };
  if (!entry.backend) return { available: false, backend: null, reason: "Sandbox compatibility entry has no authorized write workspace backend" };
  return { available: true, backend: entry.backend, reason: null };
}

export async function createWriteSandboxSettings({ settingsPath, sourceRoot, isolatedRoot, artifactRoot, stateRoot }) {
  if (!artifactRoot || !stateRoot) throw new Error("artifactRoot and stateRoot are required for write sandbox settings");
  const replace = value => typeof value === "string" ? value.replaceAll("<SOURCE_ROOT>", sourceRoot).replaceAll("<ISOLATED_ROOT>", isolatedRoot).replaceAll("<ARTIFACT_ROOT>", artifactRoot).replaceAll("<STATE_ROOT>", stateRoot) : Array.isArray(value) ? value.map(replace) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)])) : value;
  const settings = replace(POLICY_TEMPLATE);
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(settingsPath, 0o600);
  return { settingsPath, settings, policyVersion: SANDBOX_POLICY_VERSION, policyHash: sandboxPolicyHash() };
}

export async function writeSandboxPreflight({ claudeExecutable = process.env.CLAUDE_CODE_EXECUTABLE ?? "claude", compatibilityPath = SANDBOX_COMPATIBILITY_PATH, platform = process.platform } = {}) {
  const manifest = await readFile(compatibilityPath, "utf8").then(JSON.parse).catch(error => { throw new WriteCapabilityUnavailableError(`Could not load sandbox compatibility manifest: ${error.message}`); });
  if (manifest?.schemaVersion !== 1 || manifest?.policyVersion !== SANDBOX_POLICY_VERSION || manifest.policyHash !== sandboxPolicyHash()) throw new WriteCapabilityUnavailableError("Sandbox compatibility manifest does not match the active policy");
  const prerequisites = await probeSandboxPrerequisites(platform);
  if (!prerequisites.available) throw new WriteCapabilityUnavailableError(prerequisites.reason, { platform, policyVersion: SANDBOX_POLICY_VERSION, policyHash: sandboxPolicyHash() });
  const canonicalExecutable = await resolveExecutable(claudeExecutable), executableSha256 = createHash("sha256").update(await readFile(canonicalExecutable)).digest("hex");
  if (!manifest.entries?.some(entry => entry.platform === platform && entry.executableSha256 === executableSha256)) throw new WriteCapabilityUnavailableError("Claude executable identity is not in the sandbox compatibility manifest", { platform, executableSha256, policyVersion: SANDBOX_POLICY_VERSION, policyHash: sandboxPolicyHash() });
  const versionResult = await runCommand(canonicalExecutable, ["--version"], { timeoutMs: 10_000, env: preflightEnvironment() });
  if (versionResult.code !== 0) throw new WriteCapabilityUnavailableError(versionResult.stderr.trim() || "Could not determine Claude Code version");
  const claudeVersion = /\b(\d+\.\d+\.\d+)\b/.exec(versionResult.stdout)?.[1];
  if (!claudeVersion) throw new WriteCapabilityUnavailableError("Claude Code returned an unrecognized version");
  const compatibility = evaluateSandboxCompatibility({ manifest, claudeVersion, executableSha256, platform, prerequisites });
  if (!compatibility.available) throw new WriteCapabilityUnavailableError(compatibility.reason, { claudeVersion, platform, policyVersion: SANDBOX_POLICY_VERSION, policyHash: sandboxPolicyHash() });
  return { ...compatibility, claudeVersion, claudeExecutable: canonicalExecutable, executableSha256, platform, policyVersion: SANDBOX_POLICY_VERSION, policyHash: sandboxPolicyHash(), compatibilityPath };
}

async function probeSandboxPrerequisites(platform) {
  if (platform === "darwin") {
    try { await access("/usr/bin/sandbox-exec"); return { available: true, mechanism: "seatbelt" }; }
    catch { return { available: false, reason: "macOS Seatbelt sandbox-exec is unavailable" }; }
  }
  if (platform === "linux") {
    for (const command of ["bwrap", "socat"]) {
      if (!await executableOnPath(command)) return { available: false, reason: `Linux sandbox prerequisite is missing: ${command}` };
    }
    return { available: true, mechanism: "bubblewrap" };
  }
  return { available: false, reason: `Write sandbox is not supported on platform ${platform}` };
}

async function executableOnPath(command) {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    try { await access(join(directory, command)); return true; } catch {}
  }
  return false;
}

async function resolveExecutable(executable) {
  const candidates = executable.includes("/") ? [executable] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(directory => join(directory, executable));
  for (const candidate of candidates) { try { await access(candidate); return await realpath(candidate); } catch {} }
  throw new WriteCapabilityUnavailableError(`Claude executable was not found: ${executable}`);
}

function preflightEnvironment() { const { CLAUDE_CODE_EXECUTABLE, NODE_OPTIONS, NODE_PATH, BASH_ENV, ENV, ...env } = process.env; return env; }

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
