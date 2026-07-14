import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SANDBOX_POLICY_VERSION,
  createWriteSandboxSettings,
  evaluateSandboxCompatibility,
  sandboxPolicyHash,
  writeSandboxPreflight
} from "../scripts/lib/sandbox-policy.mjs";
import { buildClaudeInvocation } from "../scripts/lib/claude.mjs";

const verifiedExecutableSha256 = "051c7f28871b158132ac03a6140f2f2ab4046b18ecc4f7a91a2ac4d54774551e";
const compatibleManifest = {
  schemaVersion: 1,
  policyVersion: SANDBOX_POLICY_VERSION,
  policyHash: sandboxPolicyHash(),
  entries: [{ claudeVersion: "2.1.208", platform: "darwin", executableSha256: verifiedExecutableSha256, backend: "standalone-clone-v1", enforcementVerified: true }]
};

test("sandbox compatibility fails closed on version, platform, policy, or prerequisites", () => {
  assert.deepEqual(evaluateSandboxCompatibility({ manifest: compatibleManifest, claudeVersion: "2.1.208", executableSha256: verifiedExecutableSha256, platform: "darwin", prerequisites: { available: true } }), { available: true, backend: "standalone-clone-v1", reason: null });
  for (const input of [
    { claudeVersion: "2.1.209", platform: "darwin", prerequisites: { available: true }, reason: /version/i },
    { claudeVersion: "2.1.208", platform: "linux", prerequisites: { available: true }, reason: /platform|compatibility/i },
    { claudeVersion: "2.1.208", platform: "darwin", prerequisites: { available: false, reason: "seatbelt missing" }, reason: /seatbelt missing/i },
    { claudeVersion: "2.1.208", platform: "darwin", prerequisites: { available: true }, manifest: { ...compatibleManifest, policyHash: "wrong" }, reason: /policy hash/i }
  ]) {
    const result = evaluateSandboxCompatibility({ manifest: input.manifest ?? compatibleManifest, claudeVersion: input.claudeVersion, executableSha256: verifiedExecutableSha256, platform: input.platform, prerequisites: input.prerequisites });
    assert.equal(result.available, false);
    assert.match(result.reason, input.reason);
  }
});

test("write sandbox settings disable fallback and deny source and sensitive paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-policy-test-")), settingsPath = join(root, "settings.json"), sourceRoot = join(root, "source"), isolatedRoot = join(root, "isolated"), artifactRoot = join(root, "artifact"), stateRoot = join(root, "state");
  const created = await createWriteSandboxSettings({ settingsPath, sourceRoot, isolatedRoot, artifactRoot, stateRoot });
  assert.equal(created.policyVersion, SANDBOX_POLICY_VERSION);
  assert.equal(created.policyHash, sandboxPolicyHash());
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(settings.permissions.defaultMode, "acceptEdits");
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert(settings.sandbox.filesystem.denyWrite.includes(sourceRoot));
  assert(settings.sandbox.filesystem.denyWrite.includes(artifactRoot));
  assert(settings.sandbox.filesystem.denyWrite.includes(join(isolatedRoot, ".git")));
  assert(settings.sandbox.filesystem.denyRead.includes(sourceRoot));
  assert(settings.sandbox.filesystem.denyRead.includes(stateRoot));
  assert(!settings.sandbox.filesystem.denyWrite.includes(isolatedRoot));
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
  const invocation = buildClaudeInvocation("task", "probe", { write: true, claudeExecutable: "/verified/claude", model: "sonnet", maxTurns: 4, maxBudgetUsd: 2.5, settingsPath, settingSources: "" }), sources = invocation.args.indexOf("--setting-sources"), localSettings = invocation.args.indexOf("--settings");
  assert.equal(invocation.command, "/verified/claude"); assert.equal(invocation.args[sources + 1], ""); assert.equal(invocation.args[localSettings + 1], settingsPath);
  assert(invocation.args.includes("acceptEdits")); assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], "sonnet"); assert.equal(invocation.args[invocation.args.indexOf("--max-turns") + 1], "4"); assert.equal(invocation.args[invocation.args.indexOf("--max-budget-usd") + 1], "2.5");
});

test("runtime preflight rejects an unverified Claude version before workspace creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-preflight-test-")), fake = join(root, "claude"), manifestPath = join(root, "compatibility.json");
  await writeFile(fake, "#!/bin/sh\necho '9.9.9 (Claude Code)'\n");
  await import("node:fs/promises").then(({ chmod }) => chmod(fake, 0o755));
  const fakeSha = createHash("sha256").update(await readFile(fake)).digest("hex");
  await writeFile(manifestPath, `${JSON.stringify({ ...compatibleManifest, entries: [{ ...compatibleManifest.entries[0], executableSha256: fakeSha }] })}\n`);
  await assert.rejects(() => writeSandboxPreflight({ claudeExecutable: fake, compatibilityPath: manifestPath }), error => {
    assert.equal(error.errorKind, "write_capability_unavailable");
    assert.match(error.message, /version/i);
    return true;
  });
});

test("a version-spoofing wrapper is rejected by executable identity before invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-identity-test-")), marker = join(root, "called"), fake = join(root, "claude"), manifestPath = join(root, "compatibility.json");
  await writeFile(fake, `#!/bin/sh\ntouch ${marker}\necho '2.1.208 (Claude Code)'\n`); await chmod(fake, 0o755); await writeFile(manifestPath, `${JSON.stringify(compatibleManifest)}\n`);
  await assert.rejects(() => writeSandboxPreflight({ claudeExecutable: fake, compatibilityPath: manifestPath }), error => error.errorKind === "write_capability_unavailable" && /identity/i.test(error.message));
  await assert.rejects(() => stat(marker), error => error.code === "ENOENT");
});

test("missing platform prerequisites fail before the Claude executable is called", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-prerequisite-test-")), marker = join(root, "called"), fake = join(root, "claude"), manifestPath = join(root, "compatibility.json");
  await writeFile(fake, `#!/bin/sh\ntouch ${marker}\necho '2.1.208 (Claude Code)'\n`); await chmod(fake, 0o755); await writeFile(manifestPath, `${JSON.stringify(compatibleManifest)}\n`);
  await assert.rejects(() => writeSandboxPreflight({ claudeExecutable: fake, compatibilityPath: manifestPath, platform: "win32" }), error => error.errorKind === "write_capability_unavailable" && /not supported/i.test(error.message));
  await assert.rejects(() => stat(marker), error => error.code === "ENOENT");
});
