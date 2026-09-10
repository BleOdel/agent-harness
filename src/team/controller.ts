import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_LIMITS } from "../gates/limits.ts";
import { harnessDirectory } from "../record/record.ts";
import { assertSnapshot, captureBaseline, captureCandidate, type Candidate } from "../workspace/candidate.ts";
import { nextBaseline } from "../workspace/baseline.ts";
import { atomicJson, appendEvent, createState, readState } from "./state.ts";
import { acceptedTasks, budgetReason, schedule } from "./scheduler.ts";
import { digest, inScope, resolveSkills, type Attempt, type Policy, type Role, type TeamPlan, type TeamState, type TeamTask, type Usage } from "./schema.ts";
import { snapshotSkills } from "./inputs.ts";

export type WorkerResult =
  | { outcome: "submitted"; candidate: Candidate; usage: Usage; observedReads: string[]; workflowEvidence: string[] }
  | { outcome: "failed" | "blocked"; reason: string; usage: Usage };
export interface Verification { passed: boolean; gates: string[]; review: string; reason?: string; blocked?: boolean; environmentKey?: string; }
/** Implementations execute and verify in disposable workspaces; never apply. */
export interface Worker {
  execute(attempt: Attempt, task: TeamTask, role: Role): Promise<WorkerResult>;
  verify(attempt: Attempt, result: Extract<WorkerResult, { outcome: "submitted" }>, task: TeamTask): Promise<Verification>;
  cleanup(attempt: Attempt): Promise<void>;
}
export async function createTeam(project: string, plan: TeamPlan, inputsRoot: string, policy: Policy): Promise<string> {
  const directory = path.join(harnessDirectory(project), "teams", `team-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const baseline = await captureBaseline(project, path.join(directory, "baselines", "original"));
  const selected = [...new Map(plan.roles.flatMap(role => resolveSkills(plan, role)).map(skill => [skill.id, skill])).values()];
  const skills = await snapshotSkills(inputsRoot, path.join(directory, "inputs", "skills"), selected);
  await atomicJson(path.join(directory, "inputs", "skills.json"), skills);
  for (const [id, file] of Object.entries(plan.contracts)) if (baseline.files[file] === undefined) throw new Error(`Contract ${id} is missing from source: ${file}.`);
  await createState(directory, plan, baseline, policy, path.basename(directory));
  return directory;
}
export async function driveTeam(directory: string, worker: Worker): Promise<TeamState> {
  let state = await readState(directory);
  if (state.attempts.some(a => ["running", "submitted", "verified"].includes(a.status))) throw new Error("Unfinished attempt requires explicit team recovery; it is not evidence of success.");
  while (state.status === "running") {
    const accepted = acceptedTasks(state);
    if (state.plan.tasks.filter(t => t.priority !== "wont").every(t => accepted.has(t.id))) return appendEvent(directory, { type: "staged" });
    const reason = budgetReason(state);
    if (reason) return appendEvent(directory, { type: "stopped", reason });
    const next = schedule(state);
    if (!next) {
      const done = acceptedTasks(state);
      return appendEvent(directory, state.plan.tasks.filter(t => t.priority !== "wont").every(t => done.has(t.id)) ? { type: "staged" } : { type: "stopped", reason: "Assignments are blocked, waiting on prerequisites, or exhausted their retries." });
    }
    const { task, role } = next;
    await assertSnapshot(state.baseline);
    const id = `attempt-${randomUUID()}`;
    const attemptDirectory = path.join(directory, "attempts", id);
    // Snapshot from the run's frozen inputs, never the operator's changing folder.
    const definitions = resolveSkills(state.plan, role).map(skill => ({ ...skill, path: skill.id }));
    const skills = await snapshotSkills(path.join(directory, "inputs", "skills"), path.join(attemptDirectory, "skills"), definitions);
    const expected = JSON.parse(await readFile(path.join(directory, "inputs", "skills.json"), "utf8")) as { id: string; digest: string }[];
    if (skills.some(skill => expected.find(s => s.id === skill.id)?.digest !== skill.digest)) throw new Error("Frozen role skills changed before dispatch.");
    const contracts = Object.fromEntries(task.contracts.map(id => [id, state.baseline.files[state.plan.contracts[id]!]!]));
    const feedback = state.attempts.findLast(a => a.taskId === task.id)?.reason;
    const attempt: Attempt = { id, taskId: task.id, roleId: role.id, containerName: `harness-${id}`, directory: attemptDirectory, baseline: state.baseline, skills, contracts, instructionsDigest: digest(role), dependencyDigest: digest({ manifest: state.baseline.files["package.json"], lock: state.baseline.files["package-lock.json"] }), ...(feedback === undefined ? {} : { feedback }) };
    await mkdir(attemptDirectory, { recursive: true, mode: 0o700 });
    const expired = budgetReason(state);
    if (expired) return appendEvent(directory, { type: "stopped", reason: expired });
    state = await appendEvent(directory, { type: "dispatched", attempt });
    // The closure binds this process result to the host-issued attempt. No ID
    // in worker text is ever used for routing or for updating another task.
    const result = await worker.execute(attempt, task, role);
    if (result.outcome !== "submitted") {
      state = await appendEvent(directory, { type: result.outcome, attemptId: id, reason: result.reason, usage: result.usage });
      await worker.cleanup(attempt); continue;
    }
    try {
      const relative = path.relative(attemptDirectory, result.candidate.directory);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Candidate is outside its host-issued attempt directory.");
      await assertSnapshot(result.candidate);
      const intake = await captureCandidate(attempt.baseline, result.candidate.directory, path.join(attemptDirectory, "intake"), { sharedInputs: task.kind === "shared-inputs", limits: role.limits ?? DEFAULT_LIMITS, contractPaths: Object.values(state.plan.contracts) });
      for (const change of intake.changes) if (!inScope(change.file, task.changeScope)) throw new Error(`Candidate changed ${change.file} outside the assigned scope.`);
      result.candidate = intake;
    } catch (error) {
      state = await appendEvent(directory, { type: "failed", attemptId: id, reason: (error as Error).message, usage: result.usage });
      await worker.cleanup(attempt); continue;
    }
    state = await appendEvent(directory, { type: "submitted", attemptId: id, candidate: result.candidate, usage: result.usage, observedReads: result.observedReads, workflowEvidence: result.workflowEvidence });
    const verification = await worker.verify(attempt, result, task);
    if (!verification.passed || verification.review !== "pass") {
      state = await appendEvent(directory, { type: verification.blocked ? "blocked" : "failed", attemptId: id, reason: verification.reason ?? "Candidate gates or review failed." });
      await worker.cleanup(attempt); continue;
    }
    state = await appendEvent(directory, { type: "verified", attemptId: id, gates: verification.gates, review: "pass", ...(verification.environmentKey === undefined ? {} : { environmentKey: verification.environmentKey }) });
    const baseline = await nextBaseline(directory, result.candidate);
    state = await appendEvent(directory, { type: "integrated", attemptId: id, baseline });
    await worker.cleanup(attempt);
  }
  return state;
}
export async function recoverTeam(directory: string, worker: Pick<Worker, "cleanup">): Promise<TeamState> {
  let state = await readState(directory);
  for (const attempt of state.attempts) {
    // Cleanup must succeed before recording the worker as interrupted.
    await worker.cleanup(attempt);
    if (!["running", "submitted", "verified"].includes(attempt.status)) continue;
    state = await appendEvent(directory, { type: "interrupted", attemptId: attempt.id, reason: "Controller terminated before durable integration; no success inferred." });
  }
  await assertSnapshot(state.baseline);
  if (state.status === "running") state = await appendEvent(directory, { type: "stopped", reason: "Recovered interrupted controller. Accepted staging retained; M3 recovery does not resume or apply." });
  return state;
}
