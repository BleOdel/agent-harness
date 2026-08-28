/**
 * Create a disposable copy, apply what the gates proved, destroy the copy.
 *
 * The sandbox is destroyed on every path -- success, gate failure, crash.
 * Its path is printed first so a failure can be reproduced by re-running
 * against a fresh copy, rather than by keeping a stale one around and
 * slowly accumulating the operator's disk.
 */

import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type Change, EXCLUDED_FROM_COPY } from "./changes.ts";

export interface Sandbox {
  /** The disposable copy. The only writable mount the model gets. */
  readonly workDirectory: string;
  /** Removed by `destroy`, whatever happened. */
  readonly root: string;
}

export async function createSandbox(project: string): Promise<Sandbox> {
  // realpath because the Docker mount and every later path comparison
  // must agree on one spelling; on macOS os.tmpdir() is a symlink.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "harness-work-")));
  const workDirectory = path.join(root, "work");
  await cp(project, workDirectory, {
    recursive: true,
    // Never dereference: a symlink in the operator's project stays a
    // symlink in the copy rather than becoming a copy of whatever it
    // pointed at, which could be outside the project entirely.
    dereference: false,
    verbatimSymlinks: true,
    filter: (source) => {
      const relative = path.relative(project, source);
      if (relative === "") return true;
      return !EXCLUDED_FROM_COPY.has(relative.split(path.sep)[0] ?? "");
    },
  });
  return { workDirectory, root };
}

export async function destroySandbox(sandbox: Sandbox): Promise<void> {
  await rm(sandbox.root, { recursive: true, force: true });
}

export interface Recovery {
  readonly directory: string;
  readonly files: readonly string[];
}

/**
 * Copies every file the change set will touch, as it is now, to a
 * directory outside the project. Written before anything is applied, so
 * an apply that fails halfway is still recoverable.
 *
 * Deletions are snapshotted too -- they are the changes that most need it.
 */
export async function snapshotForRecovery(
  project: string,
  changes: readonly Change[],
): Promise<Recovery> {
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const directory = path.join(path.dirname(project), `${path.basename(project)}-recovery`, stamp);
  const files: string[] = [];
  for (const change of changes) {
    if (change.kind === "added") continue;
    const source = path.join(project, change.file);
    const destination = path.join(directory, change.file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(source));
    files.push(change.file);
  }
  // Records the additions too, so recovery knows what to remove. A
  // snapshot that can restore edits but not undo new files leaves the
  // repository in a state that never existed.
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "CHANGES.json"),
    `${JSON.stringify({ project, changes }, null, 2)}\n`,
    "utf8",
  );
  return { directory, files };
}

export async function applyChanges(
  project: string,
  copy: string,
  changes: readonly Change[],
): Promise<void> {
  for (const change of changes) {
    const destination = path.join(project, change.file);
    if (change.kind === "deleted") {
      await rm(destination, { force: true });
      continue;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(path.join(copy, change.file)));
  }
}
