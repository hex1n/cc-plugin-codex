#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function collectMjs(directory) {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await collectMjs(relative));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(relative);
  }
  return files;
}

function run(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, shell: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", code => resolveRun(code ?? 1));
  });
}

async function validateMetadata() {
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const plugin = JSON.parse(await readFile(resolve(root, ".codex-plugin/plugin.json"), "utf8"));
  if (plugin.name !== pkg.name) throw new Error("package and plugin names differ");
  if (plugin.version.split("+")[0] !== pkg.version) throw new Error("package and plugin base versions differ");
  const skills = await readdir(resolve(root, "skills"), { withFileTypes: true });
  if (skills.filter(entry => entry.isDirectory()).length !== 8) throw new Error("plugin must expose exactly 8 skills");
}

await validateMetadata();
const files = (await Promise.all(["scripts", "hooks", "test"].map(collectMjs))).flat().sort();
for (const file of files) {
  const code = await run(["--check", file]);
  if (code !== 0) process.exit(code);
}

if (!process.argv.includes("--syntax-only")) {
  const code = await run(["--test", ...files.filter(file => file.startsWith("test/"))]);
  if (code !== 0) process.exit(code);
}
