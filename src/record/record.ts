/**
 * What was attempted, what was proved, what failed and why.
 *
 * Append-only JSONL, one line per run, outside the repository. No HMAC
 * chain, no signatures, no export bundles, no receipts. v1 spent 3,470
 * lines -- 13% of its tree -- on exactly those, and in forty days the
 * only thing that ever read them was a single diagnosis.
 *
 * The point here is observability: being able to answer "what happened,
 * and can I put it back". Tamper-evidence is a different requirement with
 * a different threat model, and it will be added when something actually
 * needs it rather than in anticipation.
 */

import { atomicBytes } from "../workspace/atomic.ts";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Change } from "../workspace/changes.ts";

/** `<parent>/<name>-harness/`, beside the project and never inside it. */
export function harnessDirectory(project: string): string {
  return path.join(path.dirname(project), `${path.basename(project)}-harness`);
}

export const recordPath = (project: string): string =>
  path.join(harnessDirectory(project), "record.jsonl");

export const recoveryPath = (project: string, runId: string): string =>
  path.join(harnessDirectory(project), "recovery", runId);

export type Outcome = "applied" | "gate-failed" | "escalated" | "no-changes" | "error" | "blocked" | "environment-blocked";

export interface RunRecord {
  readonly id: string;
  readonly at: string;
  readonly project: string;
  /** The item id, or the free-form goal. */
  readonly goal: string;
  readonly attempts: number;
  readonly outcome: Outcome;
  /** One line per gate, as the operator saw them. */
  readonly gates: readonly string[];
  readonly review?: { readonly verdict: string; readonly findings: readonly string[] };
  /** What the model cost, summed across the run's turns. */
  readonly usage?: {
    readonly provider?: string;
    readonly model?: string;
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly reasoning: number;
    readonly totalTokens: number;
    readonly costUsd: number;
    readonly turns: number;
  };
  readonly changes: readonly Change[];
  /** Why it stopped, when it did. */
  readonly reason?: string;
  /** The input a blocked builder needs from the operator. */
  readonly requestedInput?: string;
  readonly baselineDigest?: string;
  readonly candidateDigest?: string;
  readonly environmentKey?: string;
  readonly acceptance?: import("../acceptance/checks.ts").AcceptanceProof;
  /** Set on an undo run, naming the run it reversed. */
  readonly reverses?: string;
  readonly teamRunId?: string;
  readonly taskIds?: readonly string[];
  readonly transactionId?: string;
}

/**
 * Reads the whole record. A malformed line is reported rather than
 * skipped: a record that quietly drops what it cannot parse is a record
 * that says a run never happened.
 */
export async function readRecord(project: string): Promise<{
  runs: RunRecord[];
  malformed: number[];
}> {
  let text;
  try {
    text = await readFile(recordPath(project), "utf8");
  } catch {
    return { runs: [], malformed: [] };
  }
  const runs: RunRecord[] = [];
  const malformed: number[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    try {
      runs.push(JSON.parse(line) as RunRecord);
    } catch {
      malformed.push(index + 1);
    }
  }
  return { runs, malformed };
}

/** `r1`, `r2`, ... Derived from the record so it survives a restart. */
export async function nextRunId(project: string): Promise<string> {
  const { runs, malformed } = await readRecord(project);
  // Counts malformed lines too. Reusing an id because a line could not be
  // parsed would make two different runs share one recovery directory.
  return `r${String(runs.length + malformed.length + 1)}`;
}

export async function appendRun(project: string, run: RunRecord): Promise<void> {
  await mkdir(harnessDirectory(project), { recursive: true });
  await appendFile(recordPath(project), `${JSON.stringify(run)}\n`, "utf8");
}

/**
 * Records an undo by appending, never by editing.
 *
 * The append-only property is the only thing making this record
 * trustworthy without cryptography. A file rewritten in place has
 * whatever history was written last, which is no history at all.
 */
export async function appendUndo(
  project: string,
  undoRunId: string,
  reversed: RunRecord,
  changes: readonly Change[],
): Promise<void> {
  await appendRun(project, {
    id: undoRunId,
    at: new Date().toISOString(),
    project,
    goal: `undo ${reversed.id}`,
    attempts: 0,
    outcome: "applied",
    gates: [],
    changes,
    reverses: reversed.id,
  });
}

/**
 * Which run currently reverses each one, if any.
 *
 * Recursive, because reversal is a stack rather than a flag. If r3 undid
 * r1 and r4 undid r3, then r1 is standing again -- its undo was itself
 * undone. Treating `reverses` as a one-way mark made r1 permanently
 * un-undoable after a single round trip, and made the undo itself
 * un-undoable despite being documented as exactly that.
 */
function reversedBy(runs: readonly RunRecord[]): Map<string, string> {
  const undone = new Map<string, string>();
  for (const run of runs) {
    if (run.reverses === undefined) continue;
    undone.set(run.reverses, run.id);
  }
  const live = new Map<string, string>();
  for (const [target, undoer] of undone) {
    // The undo counts only while it is itself still standing.
    let current: string | undefined = undoer;
    let standing = true;
    const seen = new Set<string>();
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const next: string | undefined = undone.get(current);
      if (next === undefined) break;
      standing = !standing;
      current = next;
    }
    if (standing) live.set(target, undoer);
  }
  return live;
}

/** The runs still standing: applied, and not currently reversed. */
export function undoableRuns(runs: readonly RunRecord[]): RunRecord[] {
  const reversed = reversedBy(runs);
  return runs.filter((run) => run.outcome === "applied" && !reversed.has(run.id));
}

/** The run that currently reverses `id`, for an accurate refusal. */
export function reverserOf(runs: readonly RunRecord[], id: string): string | undefined {
  return reversedBy(runs).get(id);
}

/** Idempotent journal completion: preserve the exact history prefix across retries. */
export async function appendRunOnce(project: string, run: RunRecord): Promise<void> {
  const file = recordPath(project);
  const raw = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return ""; throw e; });
  const lines = raw.split("\n").filter(line => line.trim());
  const records = lines.map(line => JSON.parse(line) as RunRecord);
  const existing = records.filter(r => r.id === run.id);
  if (existing.length) {
    if (existing.length !== 1 || JSON.stringify(existing[0]) !== JSON.stringify(run)) throw new Error("Conflicting application record; manual recovery required.");
    return;
  }
  await atomicBytes(file, Buffer.from(raw + (raw && !raw.endsWith("\n") ? "\n" : "") + JSON.stringify(run) + "\n"), 0o600);
}

/** Team journals and ordinary recovery snapshots retain the same before/after layout. */
export function runSnapshotPath(project: string, run: RunRecord): string {
  if (!run.transactionId) return recoveryPath(project, run.id);
  if (!/^application-[a-f0-9-]+$/u.test(run.transactionId)) throw new Error("Invalid application record identity.");
  return path.join(harnessDirectory(project), "applications", run.transactionId);
}
