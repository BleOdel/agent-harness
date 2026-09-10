/**
 *   harness run [--max N]
 *
 * Works items until the queue empties or something needs a person.
 *
 * This sequential workflow applies each item separately. It can do so because
 * every guarantee holds per item: each one is copied, gated,
 * reviewed, snapshotted and applied on its own. Running ten items is ten
 * of those, not one big one.
 *
 * It stops on the first thing a person has to decide. An escalation left
 * unread while the next item builds on top of it is how a queue of
 * unexamined work accumulates, which is the failure the reviewer exists
 * to prevent -- automating past it would undo the point.
 */

import { withWriter } from "../workspace/writer-lock.ts";

import path from "node:path";

import { OperatorError, say } from "./io.ts";
import { work } from "./work.ts";

const DEFAULT_MAX = 10;

async function runUnlocked(argv: readonly string[]): Promise<void> {
  const flag = argv.indexOf("--max");
  const max = flag >= 0 ? Number(argv[flag + 1]) : DEFAULT_MAX;
  if (!Number.isInteger(max) || max <= 0) {
    throw new OperatorError(`--max needs a positive whole number, got ${String(argv[flag + 1])}.`, "");
  }

  for (let done = 0; done < max; done += 1) {
    say(`\n─── item ${String(done + 1)} of at most ${String(max)} ───\n`);
    try {
      await work([]);
    } catch (error) {
      if (error instanceof OperatorError) {
        // Everything that stops a run reaches here: an escalation, a gate
        // that failed twice, an empty queue. All of them mean the same
        // thing to this loop -- a person is needed, so stop rather than
        // start the next item on top of an unexamined one.
        //
        // The count goes in the error, not before it. Printed first it
        // appeared above the reason, so the run read as having stopped
        // for no stated cause.
        throw new OperatorError(
          error.message,
          `${error.remedy}\n\nStopped after ${String(done)} ${done === 1 ? "item" : "items"}.`,
        );
      }
      throw error;
    }
  }
  say("");
  say(`Stopped at the limit of ${String(max)} items. Run again to continue.`);
}

export async function run(argv: readonly string[]): Promise<void> {
  return withWriter(path.resolve(process.env.HARNESS_PROJECT ?? process.cwd()), "run", () => runUnlocked(argv));
}
