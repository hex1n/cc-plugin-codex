import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pluginPath } from "./paths.mjs";

export async function renderPrompt(name, variables) {
  const template = await readFile(pluginPath("prompts", `${name}.md`), "utf8");
  const required = new Set([...template.matchAll(/{{([A-Z][A-Z0-9_]*)}}/g)].map(match => match[1]));
  for (const key of required) if (!(key in variables)) throw new Error(`Missing prompt variable: ${key}`);
  for (const key of Object.keys(variables)) if (!required.has(key)) throw new Error(`Unknown prompt variable: ${key}`);
  const versionMatch = template.match(/^<!--\s*version:\s*(\d+)\s*-->\s*$/m);
  if (!versionMatch) throw new Error(`Prompt ${name} is missing a numeric version declaration`);
  const version = Number(versionMatch[1]);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error(`Prompt ${name} has an invalid version declaration`);
  const text = template.replace(/{{([A-Z][A-Z0-9_]*)}}/g, (_, key) => String(variables[key]));
  if (/{{[A-Z][A-Z0-9_]*}}/.test(text)) throw new Error(`Prompt ${name} contains unresolved variables`);
  return { name, version, hash: createHash("sha256").update(template).digest("hex"), text };
}

export function schemaPath(name) { return pluginPath("schemas", `${name}.schema.json`); }
