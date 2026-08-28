/**
 *   npm run undo -- <run-id>
 *   npm run undo            (lists what can be undone)
 *
 * Reverses one applied run, at any point, including after later runs
 * changed the same files.
 *
 * Nothing here guesses. A file whose current content is exactly what the
 * run left behind is restored outright. A file that later work also
 * changed is merged three ways, with the run's own result as the base.
 * Where the undo and the later work rewrote the same lines, the file is
 * left alone and named -- silently choosing a side would destroy work
 * that was never being undone.
 *
 * The undo is itself an applied run with its own recovery snapshot, so it
 * can be undone in turn.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  appendUndo,
  nextRunId,
  readRecord,
  recoveryPath,
  reverserOf,
  type RunRecord,
  undoableRuns,
} from "./record/record.ts";
import { type FileOutcome, planUndo } from "./recovery/plan-undo.ts";
import type { Change } from "./workspace/changes.ts";

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(summary: string, detail = ""): never {
  process.stderr.write(`\n${summary}\n`);
  if (detail.trim() !== "") process.stderr.write(`\n${detail.trimEnd()}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const project = path.resolve(process.env.HARNESS_PROJECT ?? process.cwd());
  const { runs, malformed } = await readRecord(project);
  if (malformed.length > 0) {
    // Reported, never skipped. A record that quietly drops what it cannot
    // parse is a record that says a run never happened.
    say(`warning: ${String(malformed.length)} unreadable lines in the record (at ${malformed.join(", ")})`);
  }

  const undoable = undoableRuns(runs);
  const wanted = process.argv[2];
  if (wanted === undefined) {
    if (undoable.length === 0) fail("nothing to undo.", "No applied run in this project is still standing.");
    say("undoable runs, newest last:\n");
    for (const run of undoable) {
      say(`  ${run.id.padEnd(5)} ${run.at.slice(0, 19).replace("T", " ")}  ${String(run.changes.length)} files  ${run.goal}`);
    }
    say("\nUndo one with: npm run undo -- <run-id>");
    return;
  }

  const run = undoable.find((entry) => entry.id === wanted);
  if (run === undefined) {
    const known = runs.find((entry) => entry.id === wanted);
    if (known === undefined) fail(`no run ${wanted} in this project.`, "Run `npm run undo` to list what can be undone.");
    const reverser = reverserOf(runs, wanted);
    fail(
      `${wanted} cannot be undone.`,
      reverser !== undefined
        ? `${reverser} already undid it. Undo ${reverser} to put it back.`
        : `It was never applied (outcome: ${known.outcome}), so there is nothing to reverse.`,
    );
  }

  const snapshot = recoveryPath(project, run.id);
  if (!existsSync(snapshot)) {
    fail(`the recovery snapshot for ${run.id} is missing.`, `Expected it at ${snapshot}.`);
  }

  const { outcomes, writes } = await planUndo(project, run, snapshot);
  const conflicts = outcomes.filter((outcome) => outcome.action === "conflicted");
  if (conflicts.length > 0) {
    // All or nothing. A half-undone change leaves the project in a state
    // that never existed and that nothing can describe.
    fail(
      `${run.id} cannot be undone cleanly: ${String(conflicts.length)} files conflict.`,
      [
        "Nothing was changed.",
        "",
        ...conflicts.map((outcome) => `  ${outcome.file}\n    ${outcome.detail ?? ""}`),
        "",
        `The previous content of each is under ${snapshot}/before, to merge by hand.`,
      ].join("\n"),
    );
  }

  // The undo is a run too, so it can be undone in turn.
  const undoId = await nextRunId(project);
  const undoSnapshot = recoveryPath(project, undoId);
  const undoChanges: Change[] = [];
  for (const [file, content] of writes) {
    const live = path.join(project, file);
    const previous = await readFile(live, "utf8").catch(() => undefined);
    if (previous !== undefined) {
      await mkdir(path.dirname(path.join(undoSnapshot, "before", file)), { recursive: true });
      await writeFile(path.join(undoSnapshot, "before", file), previous, "utf8");
    }
    if (content !== undefined) {
      await mkdir(path.dirname(path.join(undoSnapshot, "after", file)), { recursive: true });
      await writeFile(path.join(undoSnapshot, "after", file), content, "utf8");
    }
    undoChanges.push({
      file,
      kind: content === undefined ? "deleted" : previous === undefined ? "added" : "modified",
      symlink: false,
    });
  }

  for (const [file, content] of writes) {
    const live = path.join(project, file);
    if (content === undefined) {
      await rm(live, { force: true });
    } else {
      await mkdir(path.dirname(live), { recursive: true });
      await writeFile(live, content, "utf8");
    }
  }
  await appendUndo(project, undoId, run, undoChanges);

  for (const outcome of outcomes) {
    say(`  ${outcome.action.padEnd(11)} ${outcome.file}${outcome.detail === undefined ? "" : `  (${outcome.detail})`}`);
  }
  say(`\nundid ${run.id}, recorded as ${undoId}. Undo that with: npm run undo -- ${undoId}`);
}

await main();
