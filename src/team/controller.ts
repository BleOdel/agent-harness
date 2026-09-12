import type { Config } from "../config.ts";
import { getAdapter } from "../adapters/registry.ts";
import { nodeNpm } from "../adapters/node-npm.ts";
import { pinExecution } from "../project/execution.ts";
import { abortRequested, recoverControl, type TeamControl } from "./control.ts";
import { withContainmentSignal } from "../containment/process.ts";
import { readFeatures } from "../features.ts";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_LIMITS } from "../gates/limits.ts";
import { harnessDirectory } from "../record/record.ts";
import { assertSnapshot, captureBaseline, captureCandidate, assertLiveBaseline, type Candidate, type Snapshot } from "../workspace/candidate.ts";
import { integrateCandidate } from "./integrate.ts";
import { atomicJson, appendEvent, createState, readState } from "./state.ts";
import { acceptedTasks, budgetReason, schedule } from "./scheduler.ts";
import { digest, inScope, parseTeamPlan, resolveSkills, type Attempt, type Policy, type Role, type TeamPlan, type TeamState, type TeamTask, type Usage } from "./schema.ts";
import { canonicalProject, withWriter } from "../workspace/writer-lock.ts";
import { recoverApplication, applicationPath, assertTeamDirectory } from "./apply.ts";
import { freezeChecks, readChecks } from "./checks.ts";
import { snapshotSkills } from "./inputs.ts";

export type WorkerResult =
  | { outcome: "submitted"; candidate: Candidate; usage: Usage; observedReads: string[]; workflowEvidence: string[] }
  | { outcome: "failed" | "blocked"; reason: string; usage: Usage };
export interface Verification { usage?: Usage; passed: boolean; gates: string[]; review: string; reason?: string; blocked?: boolean; environmentKey?: string; executionDigest?: string; }
/** Implementations execute and verify in disposable workspaces; never apply. */
export interface Worker {
  preflight?(): Promise<void>;
  execute(attempt: Attempt, task: TeamTask, role: Role): Promise<WorkerResult>;
  verify(attempt: Attempt, result: Extract<WorkerResult, { outcome: "submitted" }>, task: TeamTask): Promise<Verification>;
  verifyIntegration(attempt: Attempt, proposal: Snapshot, task: TeamTask, accepted: ReadonlySet<string>): Promise<Verification>;
  cleanup(attempt: Attempt): Promise<void>;
}
export async function createTeam(project: string, plan: TeamPlan, inputsRoot: string, policy: Policy, testCommand: readonly string[] = ["npm", "test"], config?: Config): Promise<string> {
  const directory = path.join(harnessDirectory(project), "teams", `team-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const execution = config ? await pinExecution(project, config, testCommand, path.join(directory, "inputs"), "team") : undefined;
  const adapter = execution ? getAdapter(execution.settings.profile.adapter) : nodeNpm;
  const baseline = await captureBaseline(project, path.join(directory, "baselines", "original"), adapter.source.generatedDirectories, execution?.digest);
  const features = await readFeatures(project);
  if (features && (!features.ok || digest(parseTeamPlan(plan, features.features).tasks) !== digest(plan.tasks))) throw new Error("Accepted feature assignments changed before team creation.");
  await assertLiveBaseline(project, baseline);
  const selected = [...new Map(plan.roles.flatMap(role => resolveSkills(plan, role)).map(skill => [skill.id, skill])).values()];
  const skills = await snapshotSkills(inputsRoot, path.join(directory, "inputs", "skills"), selected);
  await atomicJson(path.join(directory, "inputs", "skills.json"), skills);
  for (const [id, file] of Object.entries(plan.contracts)) if (baseline.files[file] === undefined) throw new Error(`Contract ${id} is missing from source: ${file}.`);
  const checks = await freezeChecks(baseline.directory, inputsRoot, directory, plan, testCommand, adapter);
  await createState(directory, plan, baseline, policy, path.basename(directory), checks.digest, execution);
  return directory;
}
export async function driveTeam(directory: string, worker: Worker, control?: TeamControl): Promise<TeamState> {
  await worker.preflight?.();
  const result = control ? await withContainmentSignal(control.signal, () => drive(directory, worker, control)) : await drive(directory, worker);
  if (control?.aborting && result.status !== "aborted") { await control.settleAbort(); return recoverTeam(directory, worker, true); }
  return result;
}
async function drive(directory: string, worker: Worker, control?: TeamControl): Promise<TeamState> {
  if (await abortRequested(directory)) throw new Error("Team was aborted; start a new run.");
  const checkAbort = () => { if (control?.aborting) throw new Error("Team aborted."); };
  let state = await readState(directory);
  const limitReason = () => budgetReason(control ? { ...state, usage: { ...state.usage, costUsd: Math.max(state.usage.costUsd, control.reportedCost(state)) } } : state);
  if (state.attempts.some(a => ["running", "submitted", "verified"].includes(a.status))) throw new Error("Unfinished attempt requires explicit team recovery; it is not evidence of success.");
  if (state.version < 2) throw new Error("Version 1 runs are inspect/recover only; start a new team for M4.");
  type Completion = { attempt: Attempt; task: TeamTask; role: Role; result: WorkerResult } | { error: unknown };
  const active = new Map<string, { attempt: Attempt; promise: Promise<Completion> }>();
  try {
    while (state.status === "running") {
      checkAbort();
      while (!limitReason()) {
        const next = schedule(state); if (!next) break;
        const { task, role, repair } = next;
        await assertSnapshot(state.baseline);
        const id = `attempt-${randomUUID()}`;
        const attemptDirectory = path.join(directory, "attempts", id);
        // Snapshot from the run's frozen inputs, never the operator's changing folder.
        const definitions = resolveSkills(state.plan, role).map(skill => ({ ...skill, path: skill.id }));
        const skills = await snapshotSkills(path.join(directory, "inputs", "skills"), path.join(attemptDirectory, "skills"), definitions);
        const expected = JSON.parse(await readFile(path.join(directory, "inputs", "skills.json"), "utf8")) as { id: string; digest: string }[];
        if (skills.some(skill => expected.find(s => s.id === skill.id)?.digest !== skill.digest)) throw new Error("Frozen role skills changed before dispatch.");
        const contracts = Object.fromEntries(task.contracts.map(id => [id, state.baseline.files[state.plan.contracts[id]!]!]));
        const feedback = repair ? `Integration repair of ${repair.id}. Work from current accepted staging and stay inside the original scope. Failure: ${repair.reason}` : state.attempts.findLast(a => a.taskId === task.id)?.reason;
        const attempt: Attempt = { ...(state.execution ? { executionDigest: state.execution.digest } : {}), ...(repair ? { repairOf: repair.id, ...(repair.candidate ? { repairCandidate: repair.candidate } : {}) } : {}), id, taskId: task.id, roleId: role.id, containerName: `harness-${id}`, directory: attemptDirectory, baseline: state.baseline, skills, contracts, instructionsDigest: digest(role), dependencyDigest: digest(Object.fromEntries((state.execution ? getAdapter(state.execution.settings.profile.adapter) : nodeNpm).source.sharedInputs.map(file => [file, state.baseline.files[file]]))), ...(feedback === undefined ? {} : { feedback }) };
        await mkdir(attemptDirectory, { recursive: true, mode: 0o700 });
        checkAbort();
        state = await appendEvent(directory, { type: "dispatched", attempt });
        checkAbort();
        const promise: Promise<Completion> = worker.execute(attempt, task, role).then(result => ({ attempt, task, role, result }), error => ({ error }));
        active.set(id, { attempt, promise });
      }
      checkAbort();
      if (active.size === 0) {
        const accepted = acceptedTasks(state);
        return appendEvent(directory, state.plan.tasks.filter(t => t.priority !== "wont").every(t => accepted.has(t.id)) ? { type: "staged" } : { type: "stopped", reason: limitReason() ?? "Assignments are blocked, waiting on prerequisites, or exhausted their retries." });
      }
      // Only builders overlap. Intake, review, merge and gates share this serial
      // controller path, so each integration sees the last accepted staging.
      const completion = await Promise.race([...active.values()].map(a => a.promise));
      checkAbort();
      if ("error" in completion) throw completion.error;
      const { attempt, task, role, result } = completion;
      const id = attempt.id, attemptDirectory = attempt.directory;
      const cleanup = async (): Promise<void> => { await worker.cleanup(attempt); active.delete(id); };
      if (result.outcome !== "submitted") {
        state = await appendEvent(directory, { type: attempt.repairOf ? "blocked" : result.outcome, attemptId: id, reason: result.reason, usage: result.usage });
        await cleanup(); continue;
      }
      try {
        const relative = path.relative(attemptDirectory, result.candidate.directory);
        if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Candidate is outside its host-issued attempt directory.");
        await assertSnapshot(result.candidate);
        const intake = await captureCandidate(attempt.baseline, result.candidate.directory, path.join(attemptDirectory, "intake"), { sharedInputs: task.kind === "shared-inputs", limits: role.limits ?? DEFAULT_LIMITS, contractPaths: Object.values(state.plan.contracts), sharedInputFiles: (state.execution ? getAdapter(state.execution.settings.profile.adapter) : nodeNpm).source.sharedInputs });
        for (const change of intake.changes) if (!inScope(change.file, task.changeScope)) throw new Error(`Candidate changed ${change.file} outside the assigned scope.`);
        result.candidate = intake;
      } catch (error) {
        state = await appendEvent(directory, { type: attempt.repairOf ? "blocked" : "failed", attemptId: id, reason: (error as Error).message, usage: result.usage });
        await cleanup(); continue;
      }
      state = await appendEvent(directory, { type: "submitted", attemptId: id, candidate: result.candidate, usage: result.usage, observedReads: result.observedReads, workflowEvidence: result.workflowEvidence });
      checkAbort();
      const verification = await worker.verify(attempt, result, task);
      checkAbort();
      if (verification.usage) state = await appendEvent(directory, { type: "review-usage", attemptId: id, usage: verification.usage });
      if (!verification.passed || verification.review !== "pass") {
        state = await appendEvent(directory, { type: verification.blocked || attempt.repairOf ? "blocked" : "failed", attemptId: id, reason: verification.reason || "Candidate gates or review failed." });
        await cleanup(); continue;
      }
      state = await appendEvent(directory, { type: "verified", attemptId: id, gates: verification.gates, review: "pass", ...(verification.environmentKey === undefined ? {} : { environmentKey: verification.environmentKey }), ...(verification.executionDigest ? { executionDigest: verification.executionDigest } : {}) });
      const merged = await integrateCandidate(attempt.baseline, result.candidate, state.baseline, path.join(attemptDirectory, "integration"), Object.values(state.plan.contracts), (state.execution ? getAdapter(state.execution.settings.profile.adapter) : nodeNpm).source.sharedInputs);
      if (!merged.ok) {
        state = await appendEvent(directory, { type: attempt.repairOf ? "blocked" : "failed", attemptId: id, failureStage: "integration", reason: merged.reason });
        await cleanup(); continue;
      }
      const fromDigest = state.baseline.digest;
      checkAbort();
      const integration = await worker.verifyIntegration(attempt, merged.proposal, task, new Set([...acceptedTasks(state), task.id]));
      checkAbort();
      await assertSnapshot(merged.proposal);
      if (!integration.passed) {
        state = await appendEvent(directory, { type: integration.blocked || attempt.repairOf ? "blocked" : "failed", attemptId: id, failureStage: "integration", reason: integration.reason || "Combined project verification failed." });
        await cleanup(); continue;
      }
      checkAbort();
      state = await appendEvent(directory, { type: "integration-verified", attemptId: id, fromDigest, candidateDigest: result.candidate.digest, proposal: merged.proposal, gates: integration.gates, ...(integration.environmentKey ? { environmentKey: integration.environmentKey } : {}), ...(integration.executionDigest ? { executionDigest: integration.executionDigest } : {}) });
      checkAbort();
      state = await appendEvent(directory, { type: "integrated", attemptId: id, baseline: merged.proposal });
      await cleanup();
    }
  } catch (error) {
    // Stop other owned processes before returning control to the operator.
    // Their durable unfinished attempts still require explicit recovery.
    await Promise.allSettled([...active.values()].map(a => worker.cleanup(a.attempt)));
    await Promise.allSettled([...active.values()].map(a => a.promise));
    await Promise.allSettled([...active.values()].map(a => worker.cleanup(a.attempt)));
    if (control?.aborting) {
      // A final successful reconciliation is required before reporting aborted.
      await control.settleAbort();
      return recoverTeam(directory, worker, true);
    }
    throw error;
  }
  return state;
}
export async function recoverTeam(directory: string, worker: Pick<Worker, "cleanup">, ownController = false): Promise<TeamState> {
  if (!ownController) await recoverControl(directory);
  let state = await readState(directory);
  for (const attempt of state.attempts) {
    // Cleanup must succeed before recording the worker as interrupted.
    await worker.cleanup(attempt);
    if (!["running", "submitted", "verified"].includes(attempt.status)) continue;
    state = await appendEvent(directory, { type: "interrupted", attemptId: attempt.id, reason: "Controller terminated before durable integration; no success inferred." });
  }
  await assertSnapshot(state.baseline);
  if (await abortRequested(directory) && ["running", "stopped", "staged"].includes(state.status)) return appendEvent(directory, { type: "aborted", reason: "Operator aborted; owned resources reconciled. Accepted staging retained." });
  if (state.status === "running") state = await appendEvent(directory, { type: "stopped", reason: "Recovered interrupted controller. Accepted staging retained; Recovery does not resume or apply." });
  return state;
}

/** Explicit continuation retains journal identity, accepted baselines and budgets. */
export async function resumeTeam(project: string, directory: string, worker: Worker, control?: TeamControl): Promise<TeamState> {
  project = await canonicalProject(project); directory = await canonicalProject(directory);
  return withWriter(project, "team resume", async () => {
    await assertTeamDirectory(project, directory);
    const pending = await readFile(applicationPath(project)).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; });
    if (pending) return recoverApplication(project, directory);
    if (await abortRequested(directory)) throw new Error("Team was aborted; recover owned resources, then start a new run.");
    if (!control) await recoverControl(directory);
    let state = await readState(directory);
    if (["applied", "undone"].includes(state.status)) return state;
    if (state.version < 2) throw new Error("Version 1 runs are inspect/recover only.");
    for (const attempt of state.attempts) {
      await worker.cleanup(attempt);
      if (["running", "submitted", "verified"].includes(attempt.status)) state = await appendEvent(directory, { type: "interrupted", attemptId: attempt.id, reason: "Resume reconciled an unfinished attempt; it was not accepted." });
    }
    await assertLiveBaseline(project, state.original); await assertSnapshot(state.baseline);
    await readChecks(directory, state.verificationDigest);
    if (state.status === "staged") return state;
    await appendEvent(directory, { type: "resumed", resumeId: randomUUID() });
    return driveTeam(directory, worker, control);
  }, true);
}
