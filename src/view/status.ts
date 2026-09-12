import type { Telemetry } from "../team/control.ts";
/**
 * What a run is doing, while it is doing it.
 *
 * The record is written once, when a run ends. That is right for a record
 * -- it says what happened -- and useless for watching, because until the
 * run finishes there is nothing to read. This is the other file: rewritten
 * as events arrive, and meaningless the moment the run is over.
 *
 * Written atomically. A reader polling every second will otherwise catch a
 * half-written file, and half a JSON document is not a smaller truth, it
 * is a parse error at the worst moment.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { harnessDirectory } from "../record/record.ts";

export const STATUS_FILE = "status.json";
/**
 * A status older than this is not believed.
 *
 * If the harness is killed mid-run nothing rewrites the file, and it would
 * otherwise say "building" for ever. A page that shows a run as running
 * long after it died is worse than one that shows nothing.
 *
 * The run writes every four seconds regardless of what it is doing, so
 * this only has to outlast a scheduling hiccup rather than a model turn.
 * It was originally set against turn completions, and a single slow turn
 * -- routinely longer than this -- reported a healthy run as stopped.
 */
export const STALE_AFTER_MS = 15_000;

export type Phase = "building" | "gating" | "reviewing" | "applying" | "idle";

export interface Status {
  readonly at: string;
  readonly pid: number;
  readonly item: string;
  readonly attempt: number;
  readonly phase: Phase;
  readonly startedAt: string;
  readonly turns: number;
  readonly tool?: string;
  readonly tokens?: number;
  readonly costUsd?: number;
  readonly gates: readonly string[];
}

export const statusPath = (project: string): string =>
  path.join(harnessDirectory(project), STATUS_FILE);

export async function writeStatus(project: string, status: Status): Promise<void> {
  // The harness directory is created by the first record append, which
  // happens when a run *ends*. This writes while it is still going, so on
  // a project's first run there is nowhere to write yet -- and the
  // failure took the run with it.
  await mkdir(harnessDirectory(project), { recursive: true });
  const destination = statusPath(project);
  const temporary = `${destination}.${String(process.pid)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
}

/** Clears the run marker. Called on every ending, including a crash. */
export async function clearStatus(project: string): Promise<void> {
  await writeStatus(project, {
    at: new Date().toISOString(),
    pid: process.pid,
    item: "",
    attempt: 0,
    phase: "idle",
    startedAt: new Date().toISOString(),
    turns: 0,
    gates: [],
  });
}

export interface LiveStatus {
  readonly status: Status | undefined;
  /** False when the file is too old to believe, or the process is gone. */
  readonly live: boolean;
  readonly reason: string | undefined;
}

/**
 * Decides whether a status is worth showing. Two independent checks,
 * because each catches a case the other misses: a stopped clock catches a
 * killed process, and a missing process catches a status written moments
 * before the crash.
 */
export function assess(status: Status | undefined, now: number, alive: (pid: number) => boolean): LiveStatus {
  if (status === undefined) return { status: undefined, live: false, reason: undefined };
  if (status.phase === "idle") return { status, live: false, reason: undefined };
  const age = now - Date.parse(status.at);
  if (Number.isNaN(age)) return { status, live: false, reason: "the status has no readable timestamp" };
  if (age > STALE_AFTER_MS) {
    return { status, live: false, reason: `no update for ${String(Math.round(age / 1000))}s — the run has stopped` };
  }
  if (!alive(status.pid)) {
    return { status, live: false, reason: "the process that was running this has gone" };
  }
  return { status, live: true, reason: undefined };
}

/** Whether a process exists, without signalling it. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else, which still
    // counts as alive; ESRCH means it is gone.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Team projections read immutable acceptance events and host telemetry only. */
export interface TeamView {
  runId: string; status: string; live: boolean; reason?: string; elapsedMs: number; costUsd: number; tokens: number;
  tasks: { id: string; role: string; waitingFor: string[]; criteria?: readonly string[] }[];
  attempts: { id: string; task: string; role: string; phase: string; repairOf?: string; skills?: string[]; observedReads?: string[]; workflowEvidence?: string[]; activity?: string[]; findings?: string[]; integrationGates?:string[]; elapsedMs: number; gates: string[]; review: string; integration: string; models: { role: string; tokens: number; costUsd: number; provider?: string; model?: string }[] }[];
  reviewHandoffs?: { id: string; at: string; attemptId: string }[];
  steering: { id: string; attemptId: string; message: string; state: string }[];
}
/** A review phase follows builder output; it is not a peer-chat receipt. */
export function reviewHandoffEvents(events: readonly Telemetry[]): NonNullable<TeamView['reviewHandoffs']> {
  const built = new Set<string>(), result: NonNullable<TeamView['reviewHandoffs']> = [];
  for (const e of events) {
    if (!e.attemptId || e.type !== 'phase') continue;
    if (e.phase === 'building') built.add(e.attemptId);
    if (e.phase === 'reviewing' && built.has(e.attemptId)) result.push({id:String(e.seq), at:e.at, attemptId:e.attemptId});
  }
  return result;
}

export async function readTeams(project: string, now = Date.now()): Promise<TeamView[]> {
  const { readdir, readFile } = await import("node:fs/promises");
  const { hostname } = await import("node:os");
  const { readState } = await import("../team/state.ts");
  const { readTelemetry, abortRequested } = await import("../team/control.ts");
  const { acceptedTasks } = await import("../team/scheduler.ts");
  const root = path.join(harnessDirectory(project), "teams");
  const entries = await readdir(root, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });
  const optional = async (file: string) => { try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } };
  const result: TeamView[] = [];
  for (const entry of entries.filter(e => e.isDirectory() && /^team-[a-zA-Z0-9_-]+$/u.test(e.name)).sort((a,b) => a.name.localeCompare(b.name))) {
    const directory = path.join(root, entry.name), state = await readState(directory, false), telemetry = await readTelemetry(directory);
    const owner = await optional(path.join(directory, "controller.json"));
    const live = Boolean(owner?.active && owner.host === hostname() && Number.isSafeInteger(owner.pid) && owner.pid > 0 && processAlive(owner.pid));
    const accepted = acceptedTasks(state);
    const steering = new Map<string, TeamView["steering"][number]>();
    for (const event of telemetry) if (event.steeringId && event.attemptId) {
      if (event.type === "steer-requested") steering.set(event.steeringId, { id: event.steeringId, attemptId: event.attemptId, message: event.message ?? "", state: "requested" });
      const item = steering.get(event.steeringId);
      if (item && item.state !== "delivered" && ["steer-delivered", "steer-acknowledged", "steer-failed"].includes(event.type)) item.state = event.type.slice(6);
    }
    const attempts: TeamView["attempts"] = [];
    const eventNames=(await readdir(path.join(directory,'events'))).filter(n=>/^\d{8}\.json$/.test(n)).sort().slice(-500);
    const submissions=await Promise.all(eventNames.map(n=>optional(path.join(directory,'events',n))));
    const strings=(v:unknown):string[]=>Array.isArray(v)?v.filter((s):s is string=>typeof s==='string'):[];
    for (const attempt of state.attempts) {
      const history = telemetry.filter(e => e.attemptId === attempt.id), models = new Map<string, TeamView["attempts"][number]["models"][number]>();
      for (const event of history) if (event.type === "usage" && event.usage && event.modelRole) models.set(event.modelRole, { role: event.modelRole, tokens: event.usage.totalTokens, costUsd: event.usage.costUsd, ...(event.usage.provider ? { provider: event.usage.provider } : {}), ...(event.usage.model ? { model: event.usage.model } : {}) });
      // Old runs have finite-process artifacts rather than live telemetry.
      for (const [role, filename] of [["builder", "builder.json"], ["reviewer", "reviewer.json"]]) if (!models.has(role!)) {
        const artifact = await optional(path.join(attempt.directory, filename!));
        if (artifact?.usage) models.set(role!, { role: role!, tokens: artifact.usage.totalTokens ?? 0, costUsd: artifact.usage.costUsd ?? 0, ...(artifact.usage.provider ? { provider: artifact.usage.provider } : {}), ...(artifact.usage.model ? { model: artifact.usage.model } : {}) });
      }
      const review = await optional(path.join(attempt.directory,"review.json"));
      const verification = await optional(path.join(attempt.directory,"verification.json"));
      const integration = await optional(path.join(attempt.directory,"integration-verification.json"));
      const submission=submissions.findLast(e=>e?.type==='submitted'&&e.attemptId===attempt.id);
      const terminal = ["integrated", "failed", "blocked", "interrupted"].includes(attempt.status);
      attempts.push({ id: attempt.id, task: attempt.taskId, role: attempt.roleId, phase: terminal ? attempt.status : history.findLast(e => e.type === "phase")?.phase ?? attempt.status,
        ...(attempt.repairOf ? { repairOf: attempt.repairOf } : {}), elapsedMs: Math.max(0, (attempt.finishedAt ? Date.parse(attempt.finishedAt) : now) - Date.parse(attempt.startedAt ?? state.startedAt)),
        skills:attempt.skills.map(s=>s.id),observedReads:strings(submission?.observedReads),workflowEvidence:strings(submission?.workflowEvidence),
        activity:history.filter(e=>e.type==='phase'||e.reason).slice(-6).map(e=>`${e.at} · ${e.phase??e.type}${e.reason?`: ${e.reason}`:''}`),findings:[...strings(review?.notes),...strings(review?.unmet),...strings(review?.unaccounted)],integrationGates:strings(integration?.run?.verdicts?.map((v:{summary:string})=>v.summary)),
        gates: verification?.run?.verdicts?.map((v: { summary: string }) => v.summary) ?? [], review: review?.verdict ?? "pending", integration: integration ? integration.run?.passed ? "passed" : "failed" : attempt.integration ? "passed" : "pending", models: [...models.values()] });
    }
    const measured = attempts.flatMap(a => a.models);
    result.push({ runId: state.runId, status: await abortRequested(directory) && state.status !== "aborted" ? live ? "aborting" : "abort needs recovery" : state.status === "running" && !live ? "interrupted" : state.status, live,
      ...(state.reason ? { reason: state.reason } : {}), elapsedMs: Math.max(0, (state.finishedAt ? Date.parse(state.finishedAt) : now) - Date.parse(state.startedAt)), costUsd: Math.max(state.usage.costUsd, measured.reduce((sum,m) => sum+m.costUsd,0)), tokens: Math.max(state.usage.tokens, measured.reduce((sum,m) => sum+m.tokens,0)),
      reviewHandoffs: reviewHandoffEvents(telemetry),
      tasks: state.plan.tasks.map(t => ({ id:t.id, role:t.assignedRole, criteria:t.criteria, waitingFor:t.dependsOn.filter(id => !accepted.has(id)) })), attempts, steering: [...steering.values()] });
  }
  return result;
}
export function formatTeams(teams: readonly TeamView[]): string {
  return teams.map(team => [
    `${team.runId} · ${team.status} · ${Math.round(team.elapsedMs/1000)}s · ${team.tokens} reported tokens · $${team.costUsd.toFixed(4)} estimate`,
    ...(team.reason ? [team.reason] : []),
    ...team.tasks.map(t => `  ${t.id} (${t.role})${t.waitingFor.length ? ` · waiting for ${t.waitingFor.join(", ")}` : ""}`),
    ...team.attempts.flatMap(a => [`  ${a.id} · ${a.task} / ${a.role} · ${a.phase} · ${Math.round(a.elapsedMs/1000)}s${a.repairOf ? ` · repair of ${a.repairOf}` : ""}`,
      `    review: ${a.review}; integration: ${a.integration}${a.gates.length ? `; ${a.gates.join("; ")}` : ""}`,
      ...a.models.map(m => `    ${m.role}: ${m.provider ?? "unknown"}/${m.model ?? "unknown"} · ${m.tokens} tokens · $${m.costUsd.toFixed(4)} reported`)]),
    ...team.steering.map(s => `  steering ${s.id} · ${s.attemptId} · ${s.state}: ${s.message}`),
  ].join("\n")).join("\n\n");
}
