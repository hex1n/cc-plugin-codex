import { CLAUDE_CLI } from "./claude.mjs";
import { runCommand } from "./process.mjs";
import { readReviewGateConfig } from "./config.mjs";
import { PLUGIN_ROOT, pluginPath } from "./paths.mjs";

export async function inspectClaudeSetup() {
  const installHint = ["npm", "install", "-g", "@anthropic-ai/claude-code"].join(" ");
  const gate = await readReviewGateConfig();
  const base = { installed: false, authenticated: false, authenticationState: "cli-not-installed", version: null, authMethod: null, installHint, pluginRoot: PLUGIN_ROOT, skillLocation: pluginPath("skills"), pluginManifest: pluginPath(".codex-plugin", "plugin.json"), reviewGateEnabled: gate.enabled, reviewGateConfig: gate.path };
  let version;
  try { version = await runCommand(CLAUDE_CLI.executable, ["--version"]); } catch (error) { if (error.code === "ENOENT") return base; throw error; }
  if (version.code !== 0) return base;
  const report = { ...base, installed: true, authenticationState: "unavailable-or-not-logged-in", version: version.stdout.trim() || version.stderr.trim() };
  const auth = await runCommand(CLAUDE_CLI.executable, ["auth", "status", "--json"]);
  let payload;
  try { payload = JSON.parse(auth.stdout || auth.stderr); } catch { return report; }
  const authenticated = payload.loggedIn === true;
  return { ...report, authenticated, authenticationState: authenticated ? "authenticated" : "unavailable-or-not-logged-in", authMethod: payload.authMethod ?? null };
}
