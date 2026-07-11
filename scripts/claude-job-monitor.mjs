#!/usr/bin/env node
import { reconcileJob } from "./lib/job-lifecycle.mjs";
import { readJob } from "./lib/state.mjs";

const [cwd, id, timeoutValue] = process.argv.slice(2), timeoutMs = Number(timeoutValue);
if (!cwd || !id || !Number.isFinite(timeoutMs) || timeoutMs <= 0) process.exit(2);
while (true) {
  const job = await readJob(cwd, id);
  if (job.status !== "running") break;
  const reconciled = await reconcileJob(job);
  if (reconciled.status !== "running") break;
  await new Promise(resolve => setTimeout(resolve, 100));
}
