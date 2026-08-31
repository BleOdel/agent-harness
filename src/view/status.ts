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
