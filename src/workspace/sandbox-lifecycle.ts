/**
 * Create a disposable copy, apply what the gates proved, destroy the copy.
 *
 * The sandbox is destroyed on every path -- success, gate failure, crash.
 * Its path is printed first so a failure can be reproduced by re-running
 * against a fresh copy, rather than by keeping a stale one around and
 * slowly accumulating the operator's disk.
 */

import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { safePath } from "./safe-path.ts";
import { captureBaseline, type Snapshot } from "./candidate.ts";
import { type Change, EXCLUDED_FROM_COPY, NEVER_APPLIED } from "./changes.ts";

export interface Sandbox {
  /** The disposable copy. The only writable mount the model gets. */
  readonly workDirectory: string;
  /** Removed by `destroy`, whatever happened. */
  readonly root: string;
  /** Top-level entries kept out of the copy. Reported, never silent. */
  readonly withheld: readonly string[];
}

export async function createSandbox(project: string): Promise<Sandbox> {
  // realpath because the Docker mount and every later path comparison
  // must agree on one spelling; on macOS os.tmpdir() is a symlink.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "harness-work-")));
  const workDirectory = path.join(root, "work");
  const withheld: string[] = [];
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
      const head = relative.split(path.sep)[0] ?? "";
      if (!EXCLUDED_FROM_COPY.has(head)) return true;
      if (!withheld.includes(head)) withheld.push(head);
      return false;
    },
  });
  return { workDirectory, root, withheld: withheld.sort() };
}

export async function destroySandbox(sandbox: Sandbox): Promise<void> {
  await rm(sandbox.root, { recursive: true, force: true });
}

export interface Recovery {
  readonly directory: string;
  readonly files: readonly string[];
}

/**
 * Copies every file the change set touches -- as it is now, and as the
 * change would leave it -- to a directory outside the project.
 *
 * Both sides, not just the original. Restoring the original is enough to
 * undo a change nothing has built on; undoing a change that later work
 * sits on top of needs a base to merge against, and that base is what
 * this run left behind. Deletions are snapshotted too: they are the
 * changes that most need it.
 *
 * Written before anything is applied, so an apply that fails halfway is
 * still recoverable.
 */
export async function snapshotForRecovery(
  project: string,
  copy: string,
  changes: readonly Change[],
  directory: string,
): Promise<Recovery> {
  const files: string[] = [];
  for (const change of changes) {
    if (change.kind !== "added") {
      const destination = path.join(directory, "before", change.file);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, await readFile(path.join(project, change.file)));
    }
    if (change.kind !== "deleted") {
      const destination = path.join(directory, "after", change.file);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, await readFile(path.join(copy, change.file)));
    }
    files.push(change.file);
  }
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
    await safePath(project, change.file);
    if (change.kind !== "deleted") await safePath(copy, change.file);
  }
  for (const change of changes) {
    const destination = await safePath(project, change.file);
    if (change.kind === "deleted") {
      await rm(destination, { force: true });
      continue;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(path.join(copy, change.file)));
  }
}

export interface RunWorkspace { readonly root: string; readonly baseline: Snapshot; readonly sandbox: Sandbox; }
export async function createRunWorkspace(project: string): Promise<RunWorkspace> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "harness-controller-")));
  try {
    const baseline = await captureBaseline(project, path.join(root, "baseline"));
    const sandbox = await createSandbox(baseline.directory);
    const withheld = (await readdir(project)).filter(name => EXCLUDED_FROM_COPY.has(name) || NEVER_APPLIED.has(name));
    return { root, baseline, sandbox: { ...sandbox, withheld } };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
export async function destroyRunWorkspace(workspace: RunWorkspace): Promise<void> {
  await destroySandbox(workspace.sandbox);
  await rm(workspace.root, { recursive: true, force: true });
}
