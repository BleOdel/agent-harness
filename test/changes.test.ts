import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertChangesAreApplicable,
  BoundaryViolation,
  type Change,
  collectChanges,
} from "../src/workspace/changes.ts";

async function scratch(): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), "harness-changes-test-")));
}

const change = (file: string, kind: Change["kind"], symlinked = false): Change =>
  ({ file, kind, symlink: symlinked });

test("collects additions, modifications and deletions", async () => {
  const root = await scratch();
  try {
    const before = path.join(root, "before");
    const after = path.join(root, "after");
    await mkdir(path.join(before, "src"), { recursive: true });
    await mkdir(path.join(after, "src"), { recursive: true });
    await writeFile(path.join(before, "kept.txt"), "same");
    await writeFile(path.join(after, "kept.txt"), "same");
    await writeFile(path.join(before, "src/edited.ts"), "old");
    await writeFile(path.join(after, "src/edited.ts"), "new");
    await writeFile(path.join(before, "gone.md"), "bye");
    await writeFile(path.join(after, "src/fresh.ts"), "hello");

    assert.deepEqual(await collectChanges(before, after), [
      change("gone.md", "deleted"),
      change("src/edited.ts", "modified"),
      change("src/fresh.ts", "added"),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file whose bytes are unchanged is not a change", async () => {
  // Guards the whole set. If content comparison broke, every file would
  // report as modified and the gate would still pass -- the harness would
  // just rewrite the entire project on every run.
  const root = await scratch();
  try {
    const before = path.join(root, "before");
    const after = path.join(root, "after");
    await mkdir(before, { recursive: true });
    await mkdir(after, { recursive: true });
    await writeFile(path.join(before, "a.txt"), "identical");
    await writeFile(path.join(after, "a.txt"), "identical");
    assert.deepEqual(await collectChanges(before, after), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(".git is invisible to the diff, so the model cannot rewrite history", async () => {
  const root = await scratch();
  try {
    const before = path.join(root, "before");
    const after = path.join(root, "after");
    await mkdir(path.join(before, ".git"), { recursive: true });
    await mkdir(path.join(after, ".git"), { recursive: true });
    await writeFile(path.join(before, ".git/HEAD"), "ref: refs/heads/main\n");
    await writeFile(path.join(after, ".git/HEAD"), "ref: refs/heads/attacker\n");
    assert.deepEqual(await collectChanges(before, after), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a symlink is refused rather than followed", async () => {
  // The one place something from inside the sandbox is written outside
  // it. Applying contents through a link the model created turns "write
  // a file in the project" into "write anywhere the operator can write".
  const root = await scratch();
  try {
    const copy = path.join(root, "copy");
    await mkdir(copy, { recursive: true });
    await writeFile(path.join(root, "secret"), "outside the project");
    await symlink(path.join(root, "secret"), path.join(copy, "notes.txt"));

    const changes = await collectChanges(path.join(root, "empty"), copy);
    assert.deepEqual(changes, [change("notes.txt", "added", true)]);
    assert.throws(
      () => { assertChangesAreApplicable(changes, copy); },
      (error: unknown) => error instanceof BoundaryViolation && error.file === "notes.txt",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a path escaping the project is refused", () => {
  assert.throws(
    () => { assertChangesAreApplicable([change("../outside.txt", "added")], "/tmp/copy"); },
    BoundaryViolation,
  );
  assert.throws(
    () => { assertChangesAreApplicable([change("/etc/passwd", "modified")], "/tmp/copy"); },
    BoundaryViolation,
  );
  assert.throws(
    () => { assertChangesAreApplicable([change(".git/config", "modified")], "/tmp/copy"); },
    BoundaryViolation,
  );
});

test("an ordinary change set is applicable", () => {
  // Keeps the refusals above honest: a check that refused everything
  // would pass all five of them.
  assert.doesNotThrow(() => {
    assertChangesAreApplicable(
      [change("src/a.ts", "added"), change("test/a.test.ts", "modified"), change("old.ts", "deleted")],
      "/tmp/copy",
    );
  });
});
