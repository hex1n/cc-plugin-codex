import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { inspectClaudeSetup } from "./setup.mjs";
import { STATE_ROOT } from "./state.mjs";
import { pluginPath } from "./paths.mjs";

export async function inspectDoctor({ env = process.env } = {}) {
  const setup = await inspectClaudeSetup();
  const mcpConfig = env.CLAUDE_COMPANION_MCP_CONFIG || pluginPath(".mcp.json");
  const mcpServer = env.CLAUDE_COMPANION_MCP_SERVER || pluginPath("mcp", "server.mjs");
  return {
    claude: {
      installed: setup.installed,
      version: setup.version,
      authenticated: setup.authenticated,
      authentication_state: setup.authenticationState,
      auth_method: setup.authMethod
    },
    plugin: {
      root: setup.pluginRoot,
      manifest: setup.pluginManifest,
      skills: setup.skillLocation
    },
    mcp: {
      config_path: mcpConfig,
      config_readable: await canAccess(mcpConfig, constants.R_OK),
      server_path: mcpServer,
      server_readable: await canAccess(mcpServer, constants.R_OK)
    },
    review_gate: {
      enabled: setup.reviewGateEnabled,
      config_path: setup.reviewGateConfig
    },
    state: {
      root: STATE_ROOT,
      readable: await canAccess(STATE_ROOT, constants.R_OK),
      writable: await canAccess(STATE_ROOT, constants.W_OK)
    }
  };
}

async function canAccess(path, mode) {
  try { await access(path, mode); return true; }
  catch { return false; }
}
