import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const PLUGIN_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const pluginPath = (...segments) => resolve(PLUGIN_ROOT, ...segments);
