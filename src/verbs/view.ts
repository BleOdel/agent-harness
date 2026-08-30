/**
 *   harness view [--open]
 *
 * Writes the record out as a page and tells you where it is.
 *
 * Everything it shows is already on disk: `record.jsonl` for what
 * happened, and `recovery/<id>/{before,after}` for the bytes. It reads
 * those and writes one self-contained HTML file. No server, no container,
 * no model, no credentials -- which is why it needs no permission and
 * there is nothing here to trust.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readFeatures } from "../features.ts";
import { harnessDirectory, readRecord, recoveryPath, undoableRuns } from "../record/record.ts";
import { diffLines, isBinary } from "../review/diff.ts";
import { type FileDiff, renderPage, type RunView } from "../view/render.ts";
import { OperatorError, say } from "./io.ts";

/** Kept small on purpose: an unreadably long diff is what this verb exists to fix. */
const MAX_LINES_PER_FILE = 600;

async function read(file: string): Promise<string | undefined> {
  return readFile(file, "utf8").catch(() => undefined);
}

async function fileDiff(snapshot: string, file: string, kind: string): Promise<FileDiff> {
  const [before, after] = await Promise.all([
    read(path.join(snapshot, "before", file)),
    read(path.join(snapshot, "after", file)),
  ]);
  if ((before !== undefined && isBinary(before)) || (after !== undefined && isBinary(after))) {
    return { file, kind, lines: [], note: "Binary file, not shown." };
  }
  const lines = diffLines((before ?? "").split("\n"), (after ?? "").split("\n"))
    .filter((line) => line.startsWith("+") || line.startsWith("-"));
  if (lines.length <= MAX_LINES_PER_FILE) return { file, kind, lines };
  // Said, not silently cut. Being shown part of a diff and not told is
  // how a reader concludes a change was smaller than it was.
  return {
    file,
    kind,
    lines: lines.slice(0, MAX_LINES_PER_FILE),
    note: `Showing the first ${String(MAX_LINES_PER_FILE)} of ${String(lines.length)} changed lines.`,
  };
}

export async function view(project: string, argv: readonly string[]): Promise<void> {
  const { runs, malformed } = await readRecord(project);
  if (runs.length === 0) {
    throw new OperatorError(
      "Nothing has run in this project yet.",
      "There is no record to look at. Start with:  harness work",
    );
  }
  if (malformed.length > 0) say(`warning: ${String(malformed.length)} unreadable lines in the record`);

  const list = await readFeatures(project);
  const features = list !== undefined && list.ok ? list.features : [];
  const standing = new Set(undoableRuns(runs).map((run) => run.id));

  const views: RunView[] = [];
  for (const run of [...runs].reverse()) {
    const snapshot = recoveryPath(project, run.id);
    const feature = features.find((entry) => entry.id === run.goal);
    views.push({
      run,
      title: feature?.title,
      criteria: feature?.criteria ?? [],
      standing: standing.has(run.id),
      files: existsSync(snapshot)
        ? await Promise.all(run.changes.map((change) => fileDiff(snapshot, change.file, change.kind)))
        // Said rather than silently empty: a run whose snapshot is gone
        // still happened, and showing it with no files would read as a
        // run that changed nothing.
        : run.changes.map((change) => ({
          file: change.file,
          kind: change.kind,
          lines: [],
          note: "The recovery snapshot for this run is gone, so its diff cannot be shown.",
        })),
    });
  }

  const destination = path.join(harnessDirectory(project), "view.html");
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, renderPage(path.basename(project), views), "utf8");

  say(`${String(views.length)} runs written to:`);
  say(`  ${destination}`);
  if (argv.includes("--open")) {
    spawn("open", [destination], { stdio: "ignore", detached: true }).unref();
    return;
  }
  say("");
  say(`Open it with:  harness view --open`);
}
