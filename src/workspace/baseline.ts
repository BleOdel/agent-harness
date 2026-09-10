import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertSnapshot, captureBaseline, type Snapshot } from "./candidate.ts";

/** New versions are new directories, never in-place edits of accepted staging. */
export async function nextBaseline(runDirectory: string, candidate: Snapshot): Promise<Snapshot> {
  await assertSnapshot(candidate);
  const next = await captureBaseline(candidate.directory, path.join(runDirectory, "baselines", randomUUID()));
  if (next.digest !== candidate.digest) throw new Error("Staging copy differs from verified candidate.");
  return next;
}
