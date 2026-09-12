import { assertExecutionCompatible } from "../project/execution.ts";
import { requireChecks, verifyAcceptance, type AcceptanceResult } from "../acceptance/checks.ts";
import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { ConfigError, loadConfig, setting } from "../config.ts";
import { readFeatures } from "../features.ts";
import { harnessDirectory } from "../record/record.ts";
import { canonicalProject, withWriter } from "../workspace/writer-lock.ts";
import { createTeam, driveTeam, recoverTeam, resumeTeam } from "../team/controller.ts";
import { parseTeamPlan, checkPolicy, identifier, type Policy } from "../team/schema.ts";
import { readState } from "../team/state.ts";
import { resolveTeamModel } from "../team/checks.ts";
import { applyTeam, recoverApplication, undoTeam, applicationPath } from "../team/apply.ts";
import { TeamControl, sendControl } from "../team/control.ts";
import { assertRpcVersion } from "../agent/rpc.ts";
import { processWorker } from "../team/worker.ts";
import { OperatorError, say } from "./io.ts";

const USAGE = "harness team run [--profile path] [--max-workers 1|2] [--max-attempts 2] [--max-repairs 1] [--max-dispatches 20] [--max-ms 3600000] [--max-cost-usd 10]\nharness team steer <attempt-id> \"message\"\nharness team abort <run-id>\nharness team inspect <run-id>\nharness team resume <run-id>\nharness team apply <run-id>\nharness team undo <run-id>\nharness team recover <run-id> [--rollback]";
export async function team(project: string, argv: readonly string[]): Promise<void> {
  const canonical = await canonicalProject(project);
  if (argv[0] === "steer" || argv[0] === "abort") {
    if (!identifier(argv[1]) || (argv[0] === "steer" ? argv.length !== 3 : argv.length !== 2)) throw new OperatorError("harness team steer <attempt-id> \"message\" | harness team abort <run-id>");
    const root = path.join(harnessDirectory(canonical), "teams");
    let runId = argv[1];
    if (argv[0] === "steer") {
      const matches: string[] = [];
      for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory() && identifier(entry.name)) {
        const state = await readState(path.join(root, entry.name), false);
        if (state.attempts.some(a => a.id === argv[1])) matches.push(entry.name);
      }
      if (matches.length !== 1) throw new OperatorError("Attempt does not identify exactly one team run.");
      runId = matches[0]!;
    }
    const result = await sendControl(path.join(root, runId), argv[0] === "abort" ? { type: "abort" } : { type: "steer", attemptId: argv[1], message: argv[2]! });
    say(JSON.stringify(result, null, 2)); return;
  }
  if (argv[0] === "inspect") {
    if (argv.length !== 2 || !identifier(argv[1])) throw new OperatorError(USAGE);
    const state = await readState(path.join(harnessDirectory(canonical), "teams", argv[1]), false);
    say(JSON.stringify(state, null, 2)); return;
  }
  return withWriter(canonical, "team", async () => {
    if (["apply", "undo", "resume", "recover"].includes(argv[0] ?? "")) {
      if (!identifier(argv[1]) || (argv.length !== 2 && !(argv[0] === "recover" && argv.length === 3 && argv[2] === "--rollback"))) throw new OperatorError(USAGE);
      const directory = path.join(harnessDirectory(canonical), "teams", argv[1]);
      if (argv[0] === "apply" || argv[0] === "undo") {
        let acceptance: AcceptanceResult | undefined;
        if (argv[0] === "apply") {
          const staged = await readState(directory, false);
          if (staged.status !== "applied") {
            const approved = await requireChecks(canonical, staged.integrated);
            let config = loadConfig(); config = { ...config, ...await resolveTeamModel(config) };
            if (!staged.execution) throw new OperatorError("This older team has no pinned execution environment.", "Inspect/recover/undo remain available. Start a new team to verify under the adapter contract.");
            await assertExecutionCompatible(staged.execution, canonical, config, (setting(process.env, "HARNESS_TEST_COMMAND") ?? "npm test").split(" ").filter(Boolean), true);
            acceptance = await verifyAcceptance(canonical, staged.baseline, staged.integrated, config, approved, staged.execution);
            for (const summary of acceptance.summaries) say(summary);
          }
        }
        const state = await (argv[0] === "apply" ? applyTeam : undoTeam)(canonical, directory, acceptance ? { acceptance } : {});
        say(`${state.runId}: ${state.status}. Record: ${state.application?.recordId ?? state.appliedRecordId ?? "none"}.`); return;
      }
      const pending = await readFile(applicationPath(canonical)).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; });
      if (pending) {
        const state = await recoverApplication(canonical, directory, { rollback: argv[2] === "--rollback" });
        say(`${state.runId}: ${state.status}. Application recovery completed.`); return;
      }
      if (argv[2] === "--rollback") throw new OperatorError("No pending application to roll back.");
    }
    let config;
    try { config = loadConfig(); } catch (error) { if (error instanceof ConfigError) throw new OperatorError(error.message, error.remedy); throw error; }
    const testCommand = (setting(process.env, "HARNESS_TEST_COMMAND") ?? "npm test").split(" ").filter(Boolean);
    if (argv[0] === "recover") {
      if (argv.length !== 2 || !identifier(argv[1])) throw new OperatorError(USAGE);
      const directory = path.join(harnessDirectory(canonical), "teams", argv[1]);
      const state = await recoverTeam(directory, processWorker(config, directory, testCommand));
      say(`${state.runId}: ${state.status}. Owned resources reconciled. Retained staging: ${state.baseline.directory}.`); return;
    }
    if (argv[0] === "resume") {
      const directory = path.join(harnessDirectory(canonical), "teams", argv[1]!);
      config = { ...config, ...await resolveTeamModel(config) };
      const existing = await readState(directory, false);
      if (["applied", "undone"].includes(existing.status)) { say(`${existing.runId}: ${existing.status}. No new dispatch.`); return; }
      if (!existing.execution) throw new OperatorError("This older team has no pinned execution environment.", "Inspect/recover/undo remain available; start a new team for further builds.");
      await assertExecutionCompatible(existing.execution, canonical, config, testCommand, true);
      const pendingTasks = existing.plan.tasks.filter(t => !existing.integrated.includes(t.id) && t.status !== "done" && t.priority !== "wont").map(t => t.id);
      if (pendingTasks.length) await requireChecks(canonical, pendingTasks);
      await assertRpcVersion(config.piPackageDirectory);
      const control = await TeamControl.start(directory);
      let state;
      try { state = await resumeTeam(canonical, directory, processWorker(config, directory, testCommand, undefined, control), control); }
      finally { await control.close(); }
      say(`${state.runId}: ${state.status}. ${state.integrated.length} assignments staged. No new application requested.`);
      if (["stopped", "aborted"].includes(state.status)) throw new OperatorError(state.reason ?? "Team stopped.");
      return;
    }
    if (argv[0] !== "run") throw new OperatorError(USAGE);
    let profile = path.resolve(import.meta.dirname, "../../profiles/team.json");
    const policy: Policy = { maxAttempts: 2, maxDispatches: 20, maxMs: 3600000, maxCostUsd: 10 };
    const limits = { "--max-repairs": "maxRepairs", "--max-attempts": "maxAttempts", "--max-dispatches": "maxDispatches", "--max-ms": "maxMs", "--max-cost-usd": "maxCostUsd" } as const;
    for (let i = 1; i < argv.length; i += 2) {
      const flag = argv[i]!; const value = argv[i + 1];
      if (value === undefined) throw new OperatorError(`Missing value for ${flag}.`, USAGE);
      if (flag === "--profile") profile = path.resolve(value);
      else if (flag === "--max-workers") policy.maxWorkers = Number(value);
      else if (flag in limits) policy[limits[flag as keyof typeof limits]] = Number(value);
      else throw new OperatorError(`Unknown team option ${flag}.`, USAGE);
    }
    checkPolicy(policy);
    const features = await readFeatures(canonical);
    if (!features?.ok) throw new OperatorError(features ? features.reason : "Team execution requires accepted features.json tasks.");
    config = { ...config, ...await resolveTeamModel(config) };
    const plan = parseTeamPlan(JSON.parse(await readFile(profile, "utf8")), features.features);
    for (const role of plan.roles) {
      if (role.provider === undefined && config.provider !== undefined) role.provider = config.provider;
      if (role.model === undefined && config.model !== undefined) role.model = config.model;
    }
    await assertRpcVersion(config.piPackageDirectory);
    const pendingTasks = plan.tasks.filter(t => t.status !== "done" && t.priority !== "wont").map(t => t.id);
    if (!pendingTasks.length) { say("Nothing left to work on. No team dispatch."); return; }
    await requireChecks(canonical, pendingTasks);
    const directory = await createTeam(canonical, plan, path.dirname(profile), policy, testCommand, config);
    say(`team: ${path.basename(directory)}\nstate: ${directory}\nconcurrency: ${policy.maxWorkers ?? 1}; results stay in staging`);
    const control = await TeamControl.start(directory);
    let state;
    try { state = await driveTeam(directory, processWorker(config, directory, testCommand, undefined, control), control); }
    catch (error) { throw new OperatorError(`Team execution interrupted: ${(error as Error).message}`, `Reconcile owned resources with: harness team recover ${path.basename(directory)}`); }
    finally { await control.close(); }
    say(`${state.runId}: ${state.status}. ${state.integrated.length} assignments staged. Nothing applied.`);
    say(`staging: ${state.baseline.directory}`);
    say(`reported usage estimate: ${state.usage.tokens} tokens, $${state.usage.costUsd.toFixed(4)}; provider reporting may be incomplete`);
    if (["stopped", "aborted"].includes(state.status)) throw new OperatorError(state.reason ?? "Team stopped.", `Inspect with: harness team inspect ${state.runId}`);
  }, argv[0] === "recover" || argv[0] === "resume");
}
