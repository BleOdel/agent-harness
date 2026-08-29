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
 * Two different reasons, deliberately in one list because the mechanism
 * is the same and a second list is a second thing to forget.
 *
 * `.git` is excluded so the model cannot rewrite history, move a branch,
 * or leave a commit that looks like the operator's. The operator commits;
 * the harness never does.
 *
 * The rest are secret-bearing by convention. The container keeps the
 * model away from the host filesystem, but the copy is made *by* the
 * host, so anything sitting inside the project walks in through the front
 * door. Found the first time this ran against a real project: it still
 * held the previous harness's `.secure-harness` directory, with a
 * provider credential and an audit signing key in it.
 *
 * Exclusion is announced rather than silent -- a project whose tests need
 * a `.env` will fail the gate, and the operator has to be able to see
 * why.
 */
export const EXCLUDED_FROM_COPY = new Set([
  ".git",
  ".harness",
  // The feature list. The model is given the item and its acceptance
  // criteria in its instructions; it has no business reading the rest of
  // the backlog and no business writing any of it. Nothing being judged
  // may edit what it is judged against.
  //
  // Added after watching it happen: on a real project the model helpfully
  // flipped its own item from todo to done. Only the status, and nothing
  // refused it -- the same access would have let it rewrite a criterion
  // it could not meet.
  "features.json",
  ".secure-harness",
  ".env",
  ".env.local",
  ".ssh",
  ".aws",
  ".gnupg",
  ".npmrc",
  ".netrc",
]);

/**
 * Copied into the sandbox, because the tests need them, but never diffed
 * and never applied back.
 *
 * These are generated: nobody edits `node_modules` by hand, and whatever
 * the model does to it dies with the sandbox. Diffing them is not merely
 * wasteful -- it is wrong. `npm` touches files under `node_modules` as a
 * side effect of running, so a project with dependencies reported
 * hundreds of "changes" it had not made, blew the size ceiling, and
 * failed every run. Measured on a project with one dev dependency: 671 of
 * the 676 files walked.
 *
 * Distinct from EXCLUDED_FROM_COPY, which is about what must never enter
 * the container at all. The two questions are different and were
 * conflated in one list.
 */
export const NEVER_APPLIED = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache",
  ".turbo",
  ".venv",
  "__pycache__",
]);

/** Stands in for content that is never read, so a symlink can differ from a file. */
const SYMLINK = "\u0000symlink";

/**
 * Every file under `root` mapped to a fingerprint of its content.
 *
 * Exported because the build-determinism gate needs the same notion of
 * "did anything change" as the apply step, and two notions of that would
 * eventually disagree.
 */
export async function fingerprintTree(root: string, prefix = ""): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let entries;
  try {
    entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (prefix === "" && EXCLUDED_FROM_COPY.has(entry.name)) continue;
    // At any depth, not only the top: a monorepo has a node_modules under
    // every package.
    if (NEVER_APPLIED.has(entry.name)) continue;
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const [key, value] of await fingerprintTree(root, relative)) found.set(key, value);
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
  const [before, after] = await Promise.all([fingerprintTree(original), fingerprintTree(copy)]);
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
    const segments = change.file.split("/");
    const head = segments[0] ?? "";
    if (EXCLUDED_FROM_COPY.has(head)) {
      throw new BoundaryViolation(`${change.file} is inside ${head}, which the harness never applies.`, change.file);
    }
    const generated = segments.find((segment) => NEVER_APPLIED.has(segment));
    if (generated !== undefined) {
      throw new BoundaryViolation(
        `${change.file} is inside ${generated}, which is generated and never applied.`,
        change.file,
      );
    }
  }
}
