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

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RunRecord } from "../record/record.ts";
import { threeWayMerge } from "./merge.ts";

const read = async (file: string): Promise<string | undefined> => {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
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
): Promise<{ outcomes: FileOutcome[]; writes: Map<string, string | undefined> }> {
  const outcomes: FileOutcome[] = [];
  const writes = new Map<string, string | undefined>();

  for (const change of run.changes) {
    const live = path.join(project, change.file);
    const current = await read(live);
    const before = await read(path.join(snapshot, "before", change.file));
    const after = await read(path.join(snapshot, "after", change.file));

    if (change.kind === "added") {
      if (current === undefined) {
        outcomes.push({ file: change.file, action: "already-gone" });
      } else if (current === after) {
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
      if (current === before) {
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
    if (current === after) {
      writes.set(change.file, before);
      outcomes.push({ file: change.file, action: "restored" });
      continue;
    }

    const merged = threeWayMerge(after.split("\n"), current.split("\n"), before.split("\n"));
    if (!merged.ok) {
      outcomes.push({ file: change.file, action: "conflicted", detail: merged.conflicts.join("; ") });
      continue;
    }
    writes.set(change.file, merged.lines.join("\n"));
    outcomes.push({ file: change.file, action: "merged", detail: `${String(merged.kept)} later edits kept` });
  }

  return { outcomes, writes };
}

