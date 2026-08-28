/**
 * What the model did, expressed as a set of file changes, and whether
 * that set is safe to apply.
 *
 * The container boundary protects the host *while the model runs*. This
 * file protects it at the moment the results come back, which is the one
 * point where something from inside the sandbox is written outside it. A
 * boundary that holds for the run and not for the apply is not a boundary.
 */

import { readdir, readFile, lstat } from "node:fs/promises";
import path from "node:path";

export type ChangeKind = "added" | "modified" | "deleted";

export interface Change {
  /** Always a relative POSIX path inside the project. */
  readonly file: string;
  readonly kind: ChangeKind;
  /** Set when the copy holds a symlink at this path. Always refused. */
  readonly symlink: boolean;
}

/**
 * Never copied into the sandbox, and never applied back.
 *
 * `.git` is excluded so the model cannot rewrite history, move a branch,
 * or leave a commit that looks like the operator's. The operator commits;
 * the harness never does.
 */
export const EXCLUDED_FROM_COPY = new Set([".git", ".harness"]);

/** Stands in for content that is never read, so a symlink can differ from a file. */
const SYMLINK = "\u0000symlink";

async function walk(root: string, prefix = ""): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let entries;
  try {
    entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (prefix === "" && EXCLUDED_FROM_COPY.has(entry.name)) continue;
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const [key, value] of await walk(root, relative)) found.set(key, value);
    } else {
      // Symlinks are recorded by path but never read for content. The
      // safety check below refuses them outright, so a symlink can be
      // reported to the operator without ever being followed.
      const stats = await lstat(path.join(root, relative));
      found.set(
        relative,
        stats.isSymbolicLink() ? SYMLINK : await readFile(path.join(root, relative), "base64"),
      );
    }
  }
  return found;
}

/** Every difference between the operator's project and the copy. */
export async function collectChanges(original: string, copy: string): Promise<Change[]> {
  const [before, after] = await Promise.all([walk(original), walk(copy)]);
  const changes: Change[] = [];
  for (const [file, content] of after) {
    const previous = before.get(file);
    const symlink = content === SYMLINK;
    if (previous === undefined) changes.push({ file, kind: "added", symlink });
    else if (previous !== content) changes.push({ file, kind: "modified", symlink });
  }
  for (const file of before.keys()) {
    if (!after.has(file)) changes.push({ file, kind: "deleted", symlink: false });
  }
  return changes.sort((a, b) => a.file.localeCompare(b.file));
}

export class BoundaryViolation extends Error {
  readonly file: string;

  constructor(message: string, file: string) {
    super(message);
    this.name = "BoundaryViolation";
    this.file = file;
  }
}

/**
 * Refuses a change set that would write outside the project.
 *
 * The interesting case is the symlink. Copying file *contents* back into
 * the project would follow a symlink the model created, so a link at
 * `notes.txt` pointing at `~/.ssh/authorized_keys` turns an ordinary
 * "write a file" into a write anywhere the operator can write. Refused by
 * kind, not by target, because a target that resolves innocently today is
 * still a mechanism.
 */
export function assertChangesAreApplicable(changes: readonly Change[], copy: string): void {
  for (const change of changes) {
    if (change.symlink) {
      throw new BoundaryViolation(
        `${change.file} is a symlink. Applying one would write through it to wherever it points, `
        + "so the harness never applies a symlink.",
        change.file,
      );
    }
    if (change.file.startsWith("/") || change.file.includes("\\")) {
      throw new BoundaryViolation(`${change.file} is not a relative path inside the project.`, change.file);
    }
    const resolved = path.resolve(copy, change.file);
    const relative = path.relative(copy, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new BoundaryViolation(`${change.file} resolves outside the project.`, change.file);
    }
    const head = change.file.split("/")[0] ?? "";
    if (EXCLUDED_FROM_COPY.has(head)) {
      throw new BoundaryViolation(`${change.file} is inside ${head}, which the harness never applies.`, change.file);
    }
  }
}
