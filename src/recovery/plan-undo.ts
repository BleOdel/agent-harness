/**
 * What undoing one run would do to each file, decided without writing
 * anything.
 *
 * A module rather than a function inside the command, for the second time
 * in this project: `src/undo.ts` runs `main()` on import, so a test that
 * imported this from there executed the command instead of testing it.
 * The boundary probe hit exactly this in M0. Anything worth testing does
 * not live in a file that does something when you load it.
 */

import type { RunRecord } from "../record/record.ts";
import { threeWayMerge } from "./merge.ts";
import { readSafe } from "../workspace/safe-path.ts";
import path from "node:path";

const equal = (a: Buffer | undefined, b: Buffer | undefined): boolean => a === undefined ? b === undefined : b !== undefined && a.equals(b);
const text = (bytes: Buffer): string | undefined => {
  if (bytes.includes(0)) return undefined;
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return undefined; }
};

export interface FileOutcome {
  readonly file: string;
  readonly action: "restored" | "removed" | "merged" | "conflicted" | "already-gone";
  readonly detail?: string;
}

/**
 * Works out what undoing one run would do to each file, without writing
 * anything. Separated so the decision and the write are testable apart,
 * and so a conflict is discovered before any file has been touched.
 */
export async function planUndo(
  project: string,
  run: RunRecord,
  snapshot: string,
): Promise<{ outcomes: FileOutcome[]; writes: Map<string, Buffer | undefined> }> {
  const outcomes: FileOutcome[] = [];
  const writes = new Map<string, Buffer | undefined>();

  for (const change of run.changes) {
    const current = await readSafe(project, change.file);
    const before = await readSafe(path.join(snapshot, "before"), change.file);
    const after = await readSafe(path.join(snapshot, "after"), change.file);

    if (change.kind === "added") {
      if (current === undefined) {
        outcomes.push({ file: change.file, action: "already-gone" });
      } else if (equal(current, after)) {
        writes.set(change.file, undefined);
        outcomes.push({ file: change.file, action: "removed" });
      } else {
        // The file the run created has been edited since. Deleting it
        // would take the later work with it.
        outcomes.push({
          file: change.file,
          action: "conflicted",
          detail: "created by this run and edited since; removing it would discard that work",
        });
      }
      continue;
    }

    if (before === undefined) {
      outcomes.push({ file: change.file, action: "conflicted", detail: "no snapshot of its previous content" });
      continue;
    }
    if (current === undefined) {
      // Deleted since, by hand or by a later run. Putting it back is the
      // undo, and it cannot destroy anything.
      writes.set(change.file, before);
      outcomes.push({ file: change.file, action: "restored" });
      continue;
    }
    if (change.kind === "deleted" || after === undefined) {
      if (equal(current, before)) {
        outcomes.push({ file: change.file, action: "already-gone", detail: "already back to its previous content" });
      } else {
        outcomes.push({
          file: change.file,
          action: "conflicted",
          detail: "deleted by this run and re-created since with different content",
        });
      }
      continue;
    }
    if (equal(current, after)) {
      writes.set(change.file, before);
      outcomes.push({ file: change.file, action: "restored" });
      continue;
    }

    const [afterText, currentText, beforeText] = [text(after), text(current), text(before)];
    if (afterText === undefined || currentText === undefined || beforeText === undefined) {
      outcomes.push({ file: change.file, action: "conflicted", detail: "binary content changed since this run; text merging is not safe" });
      continue;
    }
    const merged = threeWayMerge(afterText.split("\n"), currentText.split("\n"), beforeText.split("\n"));
    if (!merged.ok) {
      outcomes.push({ file: change.file, action: "conflicted", detail: merged.conflicts.join("; ") });
      continue;
    }
    writes.set(change.file, Buffer.from(merged.lines.join("\n")));
    outcomes.push({ file: change.file, action: "merged", detail: `${String(merged.kept)} later edits kept` });
  }

  return { outcomes, writes };
}

