/** Repairs consume their own fixed allowance; resume never replenishes it. */
import type { AttemptState, TeamState, TeamTask } from "./schema.ts";
export function repairFor(state: TeamState, task: TeamTask): AttemptState | undefined {
  if (state.version < 3 || (state.policy.maxRepairs ?? 1) === 0) return undefined;
  const attempts = state.attempts.filter(a => a.taskId === task.id);
  const last = attempts.at(-1); if (!last) return undefined;
  const origin = last.repairOf && last.status === "interrupted" ? attempts.find(a => a.id === last.repairOf)
    : !last.repairOf && last.status === "failed" && last.failureStage === "integration" ? last : undefined;
  if (!origin || attempts.some(a => a.repairOf === origin.id && a.status !== "interrupted")) return undefined;
  return origin;
}
export function repairExhausted(state: TeamState, task: TeamTask): boolean {
  const last = state.attempts.findLast(a => a.taskId === task.id);
  return Boolean(last?.repairOf && !["integrated", "interrupted"].includes(last.status));
}
