import { PRIORITIES } from "../features.ts";
import type { Role, TeamState, TeamTask } from "./schema.ts";
export const acceptedTasks = (state: TeamState): Set<string> => new Set([...state.integrated, ...state.plan.tasks.filter(t => t.status === "done" && !state.invalidated.includes(t.id)).map(t => t.id)]);
export function schedule(state: TeamState): { task: TeamTask; role: Role } | undefined {
  if (state.status !== "running" || state.attempts.some(a => ["running", "submitted", "verified"].includes(a.status))) return undefined;
  const accepted = acceptedTasks(state);
  const queue = state.plan.tasks.filter(t => !accepted.has(t.id) && t.status !== "blocked" && t.priority !== "wont")
    .filter(t => t.dependsOn.every(id => accepted.has(id)))
    .filter(t => !state.attempts.some(a => a.taskId === t.id && a.status === "blocked"))
    .filter(t => {
      const attempts = state.attempts.filter(a => a.taskId === t.id);
      const lastAccepted = attempts.findLastIndex(a => a.status === "integrated");
      return attempts.length - lastAccepted - 1 < state.policy.maxAttempts;
    })
    .sort((a, b) => Number(b.kind === "shared-inputs") - Number(a.kind === "shared-inputs") || PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority));
  const task = queue[0];
  return task ? { task, role: state.plan.roles.find(r => r.id === task.assignedRole)! } : undefined;
}
export function budgetReason(state: TeamState, now = Date.now()): string | undefined {
  if (now - Date.parse(state.startedAt) >= state.policy.maxMs) return "Run wall-clock limit reached; no new dispatch.";
  if (state.attempts.length >= state.policy.maxDispatches) return "Dispatch limit reached; no new dispatch.";
  if (state.usage.costUsd >= state.policy.maxCostUsd) return "Reported cost limit reached; no new dispatch. Usage is an estimate.";
  return undefined;
}
