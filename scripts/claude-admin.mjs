#!/usr/bin/env node
import { inspectDoctor } from "./lib/doctor-service.mjs";
import { cancelAdminJob, controlReviewGate, discardAdminArtifact, inspectAdminArtifact, listAdminJobs, probeMcp, reconcileAdminJobs } from "#app/admin-service";

const ADMIN_COMMANDS = new Set(["doctor", "mcp", "review-gate", "jobs", "artifact"]);

try {
  const [command, ...args] = process.argv.slice(2);
  if (!ADMIN_COMMANDS.has(command)) throw new Error(`${command || "(missing)"} is not an admin command`);
  if (command === "doctor") {
    if (args.some(value => value !== "--json")) throw new Error("doctor only accepts --json");
    const report = await inspectDoctor();
    process.stdout.write(args.includes("--json") ? `${JSON.stringify({ ok: true, doctor: report }, null, 2)}\n` : `${renderDoctor(report)}\n`);
    process.exit(0);
  }
  if (command === "review-gate") {
    const json = args.at(-1) === "--json", values = json ? args.slice(0, -1) : args;
    if (values.length !== 1) throw new Error("review-gate requires status, enable, or disable");
    const gate = await controlReviewGate(values[0]);
    process.stdout.write(json ? `${JSON.stringify({ ok: true, review_gate: gate }, null, 2)}\n` : `Review gate: ${gate.enabled ? "enabled" : "disabled"}\n`);
    process.exit(0);
  }
  if (command === "mcp") {
    const json = args.at(-1) === "--json", values = json ? args.slice(0, -1) : args;
    if (values.length !== 1 || values[0] !== "probe") throw new Error("mcp requires the probe action");
    const probe = await probeMcp();
    process.stdout.write(json ? `${JSON.stringify({ ok: true, probe }, null, 2)}\n` : `MCP: ${probe.server_name} ${probe.server_version ?? ""}\nTools: ${probe.tool_count}\n`);
    process.exit(0);
  }
  if (command === "jobs") {
    const [action, ...tail] = args, { positional, options } = parseAdminOptions(tail);
    const workspaceRoot = options.workspace ?? process.cwd();
    let outcome;
    if (action === "list") {
      if (positional.length) throw new Error("jobs list does not accept positional arguments");
      outcome = await listAdminJobs({ workspaceRoot, scope: options.global ? "global" : "workspace", status: options.status, purpose: options.purpose, includeTest: options.includeTest, updatedAfter: options.updatedAfter, cursor: options.cursor, limit: options.limit });
    } else if (action === "reconcile") {
      if (positional.length || hasListOnlyOptions(options)) throw new Error("jobs reconcile only accepts --workspace and --json");
      outcome = await reconcileAdminJobs({ workspaceRoot });
    } else if (action === "cancel") {
      if (positional.length !== 1) throw new Error("jobs cancel requires an explicit job id");
      if (hasListOnlyOptions(options)) throw new Error("jobs cancel only accepts --workspace and --json");
      const cancelled = await cancelAdminJob({ workspaceRoot, jobId: positional[0] });
      outcome = { kind: "jobs", jobs: [cancelled], hasMore: false, nextCursor: null };
    } else throw new Error("jobs action must be list, reconcile, or cancel");
    const payload = { ok: true, jobs: outcome.jobs, has_more: outcome.hasMore, next_cursor: outcome.nextCursor };
    process.stdout.write(options.json ? `${JSON.stringify(payload, null, 2)}\n` : `${renderJobs(outcome.jobs)}\n`);
    process.exit(0);
  }
  if (command === "artifact") {
    const [action, jobId, ...tail] = args, { positional, options } = parseAdminOptions(tail);
    if (!jobId || positional.length) throw new Error("artifact requires an explicit job id");
    if (hasListOnlyOptions(options)) throw new Error("artifact only accepts --workspace and --json");
    const workspaceRoot = options.workspace ?? process.cwd();
    let artifact;
    if (action === "inspect") artifact = await inspectAdminArtifact({ workspaceRoot, jobId });
    else if (action === "discard") artifact = await discardAdminArtifact({ workspaceRoot, jobId });
    else throw new Error("artifact action must be inspect or discard");
    process.stdout.write(options.json ? `${JSON.stringify({ ok: true, artifact }, null, 2)}\n` : `${renderArtifact(artifact)}\n`);
    process.exit(0);
  }
  throw new Error(`${command} is not implemented`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

function renderDoctor(report) {
  return [
    `Claude CLI: ${report.claude.installed ? report.claude.version : "not found"}`,
    `Authentication: ${report.claude.authentication_state}`,
    `MCP config readable: ${report.mcp.config_readable ? "yes" : "no"}`,
    `MCP server readable: ${report.mcp.server_readable ? "yes" : "no"}`,
    `Review gate: ${report.review_gate.enabled ? "enabled" : "disabled"}`,
    `State root readable/writable: ${report.state.readable ? "yes" : "no"}/${report.state.writable ? "yes" : "no"}`
  ].join("\n");
}

function parseAdminOptions(args) {
  const options = { json: false, global: false, includeTest: false, workspace: null, status: null, purpose: null, updatedAfter: null, cursor: null, limit: 20 }, positional = [];
  const values = new Map([["--workspace", "workspace"], ["--status", "status"], ["--purpose", "purpose"], ["--updated-after", "updatedAfter"], ["--cursor", "cursor"], ["--limit", "limit"]]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--json") options.json = true;
    else if (value === "--global") options.global = true;
    else if (value === "--include-test") options.includeTest = true;
    else if (values.has(value)) {
      const next = args[index + 1]; if (next == null) throw new Error(`${value} requires a value`);
      options[values.get(value)] = value === "--limit" ? Number(next) : next; index += 1;
    } else if (value.startsWith("--")) throw new Error(`Unknown admin option: ${value}`);
    else positional.push(value);
  }
  return { positional, options };
}

function hasListOnlyOptions(options) {
  return options.global || options.includeTest || options.status != null || options.purpose != null || options.updatedAfter != null || options.cursor != null || options.limit !== 20;
}

function renderJobs(jobs) { return jobs.length ? jobs.map(job => `${job.id}\t${job.status}\t${job.phase ?? ""}`).join("\n") : "No jobs"; }
function renderArtifact(artifact) { return [`Artifact: ${artifact.id}`, `Status: ${artifact.artifact_status}`, `Recovery required: ${artifact.recovery_required ? "yes" : "no"}`, `Changed paths: ${artifact.changed_paths.join(", ") || "none"}`].join("\n"); }
