import { createHash } from "node:crypto";
import { parseFeatures, type Feature } from "../features.ts";
import type { Snapshot } from "../workspace/candidate.ts";

export interface Role { id: string; instructions: string; skills: string[]; provider?: string; model?: string; timeoutMs?: number; limits?: { maxFiles: number; maxLines: number }; }
export interface SkillDefinition { id: string; path: string; interaction: "unattended" | "interactive"; requires: string[]; dependencies: string[]; resources: string[]; }
export interface TeamTask extends Feature { assignedRole: string; changeScope: string[]; contracts: string[]; }
export interface ContractCheck { id: string; path: string; files: string[]; command: string[]; after: string[]; }
export interface TeamPlan { checks?: ContractCheck[]; version: 1; roles: Role[]; skills: SkillDefinition[]; contracts: Record<string, string>; tasks: TeamTask[]; }
export interface Policy { maxWorkers?: number; maxAttempts: number; maxDispatches: number; maxMs: number; maxCostUsd: number; }
export interface SkillVersion { id: string; digest: string; files: Record<string, string>; }
export interface Attempt {
  id: string; taskId: string; roleId: string; containerName: string; directory: string;
  baseline: Snapshot; skills: SkillVersion[]; contracts: Record<string, string>; instructionsDigest: string; dependencyDigest?: string; feedback?: string;
}
export interface Usage { tokens: number; costUsd: number; complete: boolean; }
export type EventPayload =
  | { type: "created"; runId: string; plan: TeamPlan; planDigest: string; baseline: Snapshot; policy: Policy; verificationDigest?: string }
  | { type: "dispatched"; attempt: Attempt }
  | { type: "submitted"; attemptId: string; candidate: Snapshot; usage: Usage; observedReads: string[]; workflowEvidence: string[] }
  | { type: "verified"; attemptId: string; gates: string[]; review: "pass"; environmentKey?: string }
  | { type: "integration-verified"; attemptId: string; fromDigest: string; candidateDigest: string; proposal: Snapshot; gates: string[] }
  | { type: "integrated"; attemptId: string; baseline: Snapshot }
  | { type: "failed" | "blocked" | "interrupted"; attemptId: string; reason: string; usage?: Usage }
  | { type: "stopped"; reason: string }
  | { type: "staged" };
export type TeamEvent = EventPayload & { version: 1 | 2; seq: number; at: string; runId: string };
export interface AttemptState extends Attempt { status: "running" | "submitted" | "verified" | "integrated" | "failed" | "blocked" | "interrupted"; candidate?: Snapshot; integration?: { fromDigest: string; proposal: Snapshot }; reason?: string; }
export interface TeamState {
  version: 1 | 2; runId: string; seq: number; startedAt: string; plan: TeamPlan; planDigest: string; policy: Policy;
  verificationDigest?: string; original: Snapshot; baseline: Snapshot; attempts: AttemptState[]; integrated: string[]; invalidated: string[];
  status: "running" | "stopped" | "staged"; reason?: string; usage: Usage;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)]));
  return value;
}
export const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/u.test(value);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object in team plan.");
  return value as Record<string, unknown>;
};
const strings = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.some(v => typeof v !== "string" || !v.trim())) throw new Error("Expected non-empty strings in team plan.");
  return value as string[];
};
export function safeRelative(value: string): boolean {
  return value.length > 0 && !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") && value.split("/").every(p => p !== "" && p !== "." && p !== "..");
}
export function validScope(value: string): boolean { return safeRelative(value) && !/[?\[\]{}]/u.test(value) && value.split("/").every(p => !p.includes("**") || p === "**"); }
export function inScope(file: string, scopes: readonly string[]): boolean {
  if (!safeRelative(file)) return false;
  return scopes.some(scope => {
    if (!validScope(scope)) throw new Error("Invalid change scope.");
    const parts = scope.split("/");
    const match = (i: number, j: number): boolean => {
      const segments = file.split("/");
      if (i === parts.length) return j === segments.length;
      if (parts[i] === "**") return match(i + 1, j) || (j < segments.length && match(i, j + 1));
      const pattern = parts[i]!.split("*").map(p => p.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("[^/]*");
      return j < segments.length && new RegExp(`^${pattern}$`, "u").test(segments[j]!) && match(i + 1, j + 1);
    };
    return match(0, 0);
  });
}
export function parseTeamPlan(raw: unknown, features: readonly Feature[]): TeamPlan {
  const input = object(raw);
  if (input.version !== 1) throw new Error("Unsupported team plan version.");
  const parsed = parseFeatures(JSON.stringify(features));
  if (!parsed.ok) throw new Error(parsed.reason);
  if (!Array.isArray(input.roles) || input.roles.length === 0) throw new Error("At least one role is required.");
  const roles: Role[] = input.roles.map(value => {
    const role = object(value);
    if (!identifier(role.id) || typeof role.instructions !== "string" || !role.instructions.trim()) throw new Error("Invalid role id or instructions.");
    for (const field of ["provider", "model"]) if (role[field] !== undefined && (typeof role[field] !== "string" || !String(role[field]).trim())) throw new Error(`Invalid role ${field}.`);
    if (role.timeoutMs !== undefined && (!Number.isSafeInteger(role.timeoutMs) || Number(role.timeoutMs) <= 0)) throw new Error("Invalid role timeout.");
    let limits: Role["limits"];
    if (role.limits !== undefined) {
      const values = object(role.limits);
      if (![values.maxFiles, values.maxLines].every(n => Number.isSafeInteger(n) && Number(n) > 0)) throw new Error("Role limits require positive integer maxFiles and maxLines.");
      limits = { maxFiles: values.maxFiles as number, maxLines: values.maxLines as number };
    }
    return { ...(limits === undefined ? {} : { limits }), id: role.id, instructions: role.instructions, skills: strings(role.skills ?? []), ...(role.provider === undefined ? {} : { provider: role.provider as string }), ...(role.model === undefined ? {} : { model: role.model as string }), ...(role.timeoutMs === undefined ? {} : { timeoutMs: role.timeoutMs as number }) };
  });
  if (new Set(roles.map(r => r.id)).size !== roles.length) throw new Error("Duplicate role id.");
  if (!Array.isArray(input.skills)) throw new Error("skills must be an explicit array.");
  const skills: SkillDefinition[] = input.skills.map(value => {
    const skill = object(value);
    if (!identifier(skill.id) || typeof skill.path !== "string" || !safeRelative(skill.path) || !["unattended", "interactive"].includes(String(skill.interaction))) throw new Error("Invalid skill manifest.");
    const resources = strings(skill.resources ?? []);
    if (resources.some(p => !safeRelative(p))) throw new Error("Unsafe skill resource path.");
    return { id: skill.id, path: skill.path, interaction: skill.interaction as SkillDefinition["interaction"], requires: strings(skill.requires ?? []), dependencies: strings(skill.dependencies ?? []), resources };
  });
  if (new Set(skills.map(s => s.id)).size !== skills.length) throw new Error("Duplicate skill id.");
  const contracts = object(input.contracts ?? {}) as Record<string, string>;
  if (Object.entries(contracts).some(([id, file]) => !identifier(id) || typeof file !== "string" || !safeRelative(file))) throw new Error("Invalid contract reference.");
  const tasks: TeamTask[] = parsed.features.map(feature => {
    const rawFeature = features.find(f => f.id === feature.id) as Feature & Partial<TeamTask>;
    const assignedRole = rawFeature.assignedRole ?? (roles.length === 1 ? roles[0]!.id : undefined);
    if (!roles.some(r => r.id === assignedRole)) throw new Error(`Task ${feature.id} requires an accepted role assignment.`);
    const changeScope = strings(rawFeature.changeScope ?? ["**"]);
    if (changeScope.length === 0 || changeScope.some(p => !validScope(p))) throw new Error(`Invalid change scope for ${feature.id}.`);
    const refs = strings(rawFeature.contracts ?? []);
    if (refs.some(id => !Object.hasOwn(contracts, id))) throw new Error(`Unknown contract for ${feature.id}.`);
    return { ...feature, assignedRole: assignedRole!, changeScope, contracts: refs };
  });
  let checks: ContractCheck[] | undefined;
  if (input.checks !== undefined) {
    if (!Array.isArray(input.checks)) throw new Error("checks must be an array.");
    checks = input.checks.map(value => {
      const c = object(value);
      const files = strings(c.files), command = strings(c.command), after = strings(c.after ?? []);
      if (!identifier(c.id) || typeof c.path !== "string" || !safeRelative(c.path) || !files.length || files.some(f => !safeRelative(f)) || !command.length || after.some(id => !tasks.some(t => t.id === id))) throw new Error("Invalid contract check.");
      return { id: c.id, path: c.path, files, command, after };
    });
    if (new Set(checks.map(c => c.id)).size !== checks.length) throw new Error("Duplicate contract check.");
  }
  const result: TeamPlan = { version: 1, roles, skills, contracts, tasks, ...(checks === undefined ? {} : { checks }) };
  for (const role of roles) resolveSkills(result, role);
  return result;
}
export function resolveSkills(plan: TeamPlan, role: Role): SkillDefinition[] {
  const selected = new Map<string, SkillDefinition>();
  const stack: string[] = [];
  const visit = (id: string): void => {
    if (stack.includes(id)) throw new Error(`Skill dependency cycle: ${[...stack, id].join(" -> ")}.`);
    if (selected.has(id)) return;
    const skill = plan.skills.find(s => s.id === id);
    if (!skill) throw new Error(`Missing skill dependency ${id}.`);
    if (skill.interaction !== "unattended" || ["grilling", "grill-me"].includes(skill.id)) throw new Error(`Interactive skill ${id} cannot run unattended.`);
    if (skill.requires.some(capability => !["read", "bash", "edit", "write"].includes(capability))) throw new Error(`Unsupported capability required by ${id}.`);
    stack.push(id); for (const dependency of skill.dependencies) visit(dependency); stack.pop(); selected.set(id, skill);
  };
  for (const id of role.skills) visit(id);
  return [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
}
export function checkPolicy(policy: Policy): void {
  if (policy.maxWorkers !== undefined && ![1, 2].includes(policy.maxWorkers)) throw new Error("maxWorkers must be 1 or 2.");
  if (![policy.maxAttempts, policy.maxDispatches, policy.maxMs].every(n => Number.isSafeInteger(n) && n > 0) || !Number.isFinite(policy.maxCostUsd) || policy.maxCostUsd <= 0) throw new Error("Team limits must be positive finite numbers (counts and milliseconds must be integers).");
}
