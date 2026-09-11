import { PRIORITIES } from "../features.ts";
import { repairFor, repairExhausted } from "./repair.ts";
import type { AttemptState, Role, TeamState, TeamTask } from "./schema.ts";
export const acceptedTasks = (state: TeamState): Set<string> => new Set([...state.integrated, ...state.plan.tasks.filter(t => t.status === "done" && !state.invalidated.includes(t.id)).map(t => t.id)]);
export function schedule(state: TeamState): { task: TeamTask; role: Role; repair?: AttemptState } | undefined {
  const active = state.attempts.filter(a => ["running", "submitted", "verified"].includes(a.status));
  if (state.status !== "running" || active.length >= (state.version === 1 ? 1 : state.policy.maxWorkers ?? 1) || active.some(a => state.plan.tasks.find(t => t.id === a.taskId)?.kind === "shared-inputs")) return undefined;
  const accepted = acceptedTasks(state);
  const queue = state.plan.tasks.filter(t => !accepted.has(t.id) && t.status !== "blocked" && t.priority !== "wont")
    .filter(t => !active.some(a => a.taskId === t.id))
    .filter(t => t.dependsOn.every(id => accepted.has(id)))
    .filter(t => !state.attempts.some(a => a.taskId === t.id && a.status === "blocked" && (a.terminalSeq ?? 0) >= (state.resumeSeq ?? 0)))
    .filter(t => {
      if (repairExhausted(state, t)) return false;
      if (repairFor(state, t)) return true;
      const last = state.attempts.findLast(a => a.taskId === t.id);
      if (state.version >= 3 && last?.failureStage === "integration") return false;
      const attempts = state.attempts.filter(a => a.taskId === t.id && !a.repairOf && a.status !== "interrupted");
      const lastAccepted = attempts.findLastIndex(a => a.status === "integrated");
      return attempts.length - lastAccepted - 1 < state.policy.maxAttempts;
    })
    .sort((a, b) => Number(b.kind === "shared-inputs") - Number(a.kind === "shared-inputs") || PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority));
  const task = queue[0];
  if (task?.kind === "shared-inputs" && active.length > 0) return undefined;
  const repair = task ? repairFor(state, task) : undefined;
  return task ? { task, role: state.plan.roles.find(r => r.id === task.assignedRole)!, ...(repair ? { repair } : {}) } : undefined;
}
export function budgetReason(state: TeamState, now = Date.now()): string | undefined {
  if (now - Date.parse(state.startedAt) >= state.policy.maxMs) return "Run wall-clock limit reached; no new dispatch.";
  if (state.attempts.length >= state.policy.maxDispatches) return "Dispatch limit reached; no new dispatch.";
  if (state.usage.costUsd >= state.policy.maxCostUsd) return "Reported cost limit reached; no new dispatch. Usage is an estimate.";
  return undefined;
}
