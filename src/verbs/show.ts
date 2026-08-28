/**
 *   show <run-id>
 *
 * The exact diff a run applied, reconstructed from its recovery snapshot
 * rather than from the project as it stands now. Later runs may have
 * changed the same files; this shows what *this* run did.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readRecord, recoveryPath } from "../record/record.ts";
import { diffLines } from "../review/diff.ts";
import { OperatorError, say } from "./io.ts";

const read = async (file: string): Promise<string[] | undefined> => {
  try {
    return (await readFile(file, "utf8")).split("\n");
  } catch {
    return undefined;
  }
};

export async function show(project: string, argv: readonly string[]): Promise<void> {
  const wanted = argv[0];
  if (wanted === undefined) {
    throw new OperatorError("Which run?", "Use: npm run show -- <run-id>. `npm run look` lists them.");
  }
  const { runs } = await readRecord(project);
  const run = runs.find((entry) => entry.id === wanted);
  if (run === undefined) {
    throw new OperatorError(`No run ${wanted} in this project.`, "Run `npm run look` to see what there is.");
  }

  say(`${run.id}  ${run.at.slice(0, 19).replace("T", " ")}  ${run.outcome}`);
  say(`goal: ${run.goal}`);
  if (run.attempts > 1) say(`attempts: ${String(run.attempts)}`);
  say();
  for (const gate of run.gates) say(`  ${gate}`);
  if (run.review !== undefined) {
    say(`  review: ${run.review.verdict}`);
    for (const finding of run.review.findings) say(`    - ${finding}`);
  }
  if (run.reason !== undefined) say(`  ${run.reason}`);
  say();

  if (run.changes.length === 0) {
    say("(no files changed)");
    return;
  }

  const snapshot = recoveryPath(project, run.id);
  if (!existsSync(snapshot)) {
    // Says so rather than showing the project's current state and letting
    // the operator believe it is this run's diff.
    say(`The recovery snapshot for ${run.id} is gone, so the exact diff cannot be shown.`);
    say("Files it changed:");
    for (const change of run.changes) say(`  ${change.kind.padEnd(8)} ${change.file}`);
    return;
  }

  for (const change of run.changes) {
    say(`--- ${change.kind}: ${change.file}`);
    const before = await read(path.join(snapshot, "before", change.file)) ?? [];
    const after = await read(path.join(snapshot, "after", change.file)) ?? [];
    for (const line of diffLines(before, after)) {
      if (line.startsWith("+") || line.startsWith("-")) say(line);
    }
    say();
  }
}
