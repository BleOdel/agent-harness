/** Explicit, billable Pi demonstration. The destination is new and never applied. */
import assert from "node:assert/strict";
import { cp, mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { applyConfigFile, loadConfig } from "./config.ts";
import { createTeam, driveTeam } from "./team/controller.ts";
import { resolveTeamModel } from "./team/checks.ts";
import { processWorker } from "./team/worker.ts";
import { parseTeamPlan } from "./team/schema.ts";
import { atomicJson } from "./team/state.ts";
import { withWriter } from "./workspace/writer-lock.ts";

const destination = process.argv[2];
if (!destination || process.argv.length !== 3) throw new Error("Usage: npm run demo:team -- /absolute/new-directory (runs real Pi models; up to $5 reported builder cost).");
if (!path.isAbsolute(destination)) throw new Error("Use an absolute destination path.");
await mkdir(destination); // Refuse an existing directory before writing anything.
const project = path.join(destination, "project");
await cp(path.resolve(import.meta.dirname, "../examples/issue-tracker/project"), project, { recursive: true });
await rename(path.join(project, "test/smoke.test.mjs.template"), path.join(project, "test/smoke.test.mjs"));
applyConfigFile();
const loaded = loadConfig();
const config = { ...loaded, ...await resolveTeamModel(loaded) };
const profile = path.resolve(import.meta.dirname, "../profiles/issue-tracker.json");
const plan = parseTeamPlan(JSON.parse(await readFile(profile, "utf8")), JSON.parse(await readFile(path.join(project, "features.json"), "utf8")));
for (const role of plan.roles) {
  if (config.provider) role.provider = config.provider;
  if (config.model) role.model = config.model;
}
await withWriter(project, "issue-tracker demo", async () => {
  const run = await createTeam(project, plan, path.dirname(profile), { maxWorkers: 2, maxAttempts: 2, maxDispatches: 6, maxMs: 1800000, maxCostUsd: 5 });
  process.stdout.write(`team: ${run}\n`);
  const state = await driveTeam(run, processWorker(config, run, ["npm", "test"]));
  const builders = await Promise.all(state.attempts.map(async a => ({ task: a.taskId, baseline: a.baseline.digest, ...JSON.parse(await readFile(path.join(a.directory, "builder.json"), "utf8").catch(() => "{}")) })));
  const overlap = builders.some(a => a.task === "api" && builders.some(b => b.task === "client" && a.baseline === b.baseline && a.containerName !== b.containerName && a.sessionDirectory !== b.sessionDirectory && a.usage?.totalTokens > 0 && b.usage?.totalTokens > 0 && Math.max(Date.parse(a.startedAt), Date.parse(b.startedAt)) < Math.min(Date.parse(a.finishedAt), Date.parse(b.finishedAt))));
  await atomicJson(path.join(destination, "result.json"), { run, status: state.status, baseline: state.baseline, integrated: state.integrated, usage: state.usage, builders, overlap });
  assert.equal(state.status, "staged", state.reason ?? "The real demo did not complete; inspect retained team state.");
  assert.equal(overlap, true, "No overlapping real API/client builder executions were recorded.");
  process.stdout.write(`Verified issue tracker: ${state.baseline.directory}\nOverlapping real builders: yes. Live source unchanged.\n`);
});
