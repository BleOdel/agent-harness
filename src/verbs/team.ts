import path from "node:path";
import { readFile } from "node:fs/promises";
import { ConfigError, loadConfig, setting } from "../config.ts";
import { readFeatures } from "../features.ts";
import { harnessDirectory } from "../record/record.ts";
import { canonicalProject, withWriter } from "../workspace/writer-lock.ts";
import { createTeam, driveTeam, recoverTeam } from "../team/controller.ts";
import { parseTeamPlan, checkPolicy, identifier, type Policy } from "../team/schema.ts";
import { readState } from "../team/state.ts";
import { processWorker } from "../team/worker.ts";
import { OperatorError, say } from "./io.ts";

const USAGE = "harness team run [--profile path] [--max-workers 1] [--max-attempts 2] [--max-dispatches 20] [--max-ms 3600000] [--max-cost-usd 10]\nharness team inspect <run-id>\nharness team recover <run-id>";
export async function team(project: string, argv: readonly string[]): Promise<void> {
  const canonical = await canonicalProject(project);
  if (argv[0] === "inspect") {
    if (argv.length !== 2 || !identifier(argv[1])) throw new OperatorError(USAGE);
    const state = await readState(path.join(harnessDirectory(canonical), "teams", argv[1]), false);
    say(JSON.stringify(state, null, 2)); return;
  }
  return withWriter(canonical, "team", async () => {
    let config;
    try { config = loadConfig(); } catch (error) { if (error instanceof ConfigError) throw new OperatorError(error.message, error.remedy); throw error; }
    const testCommand = (setting(process.env, "HARNESS_TEST_COMMAND") ?? "npm test").split(" ").filter(Boolean);
    if (argv[0] === "recover") {
      if (argv.length !== 2 || !identifier(argv[1])) throw new OperatorError(USAGE);
      const directory = path.join(harnessDirectory(canonical), "teams", argv[1]);
      const state = await recoverTeam(directory, processWorker(config, directory, testCommand));
      say(`${state.runId}: ${state.status}. Accepted staging retained at ${state.baseline.directory}. Nothing applied.`); return;
    }
    if (argv[0] !== "run") throw new OperatorError(USAGE);
    let profile = path.resolve(import.meta.dirname, "../../profiles/team.json");
    const policy: Policy = { maxAttempts: 2, maxDispatches: 20, maxMs: 3600000, maxCostUsd: 10 };
    const limits = { "--max-attempts": "maxAttempts", "--max-dispatches": "maxDispatches", "--max-ms": "maxMs", "--max-cost-usd": "maxCostUsd" } as const;
    for (let i = 1; i < argv.length; i += 2) {
      const flag = argv[i]!; const value = argv[i + 1];
      if (value === undefined) throw new OperatorError(`Missing value for ${flag}.`, USAGE);
      if (flag === "--profile") profile = path.resolve(value);
      else if (flag === "--max-workers") { if (value !== "1") throw new OperatorError("M3 supports concurrency one. Two-worker integration belongs to M4."); }
      else if (flag in limits) policy[limits[flag as keyof typeof limits]] = Number(value);
      else throw new OperatorError(`Unknown team option ${flag}.`, USAGE);
    }
    checkPolicy(policy);
    const features = await readFeatures(canonical);
    if (!features?.ok) throw new OperatorError(features ? features.reason : "Team execution requires accepted features.json tasks.");
    const plan = parseTeamPlan(JSON.parse(await readFile(profile, "utf8")), features.features);
    for (const role of plan.roles) {
      if (role.provider === undefined && config.provider !== undefined) role.provider = config.provider;
      if (role.model === undefined && config.model !== undefined) role.model = config.model;
    }
    const directory = await createTeam(canonical, plan, path.dirname(profile), policy);
    say(`team: ${path.basename(directory)}\nstate: ${directory}\nconcurrency: 1; results stay in staging`);
    const state = await driveTeam(directory, processWorker(config, directory, testCommand)).catch((error: unknown) => {
      throw new OperatorError(`Team execution interrupted: ${(error as Error).message}`, `The durable state is retained. Reconcile owned resources with: harness team recover ${path.basename(directory)}`);
    });
    say(`${state.runId}: ${state.status}. ${state.integrated.length} assignments staged. Nothing applied.`);
    say(`staging: ${state.baseline.directory}`);
    say(`reported usage estimate: ${state.usage.tokens} tokens, $${state.usage.costUsd.toFixed(4)}; reviewer/provider reporting may be incomplete`);
    if (state.status === "stopped") throw new OperatorError(state.reason ?? "Team stopped.", `Inspect with: harness team inspect ${state.runId}`);
  });
}
