import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { changedPaths, commitMessage, git, isRepository } from "../src/git.ts";
import { assertLooksLikeProject } from "../src/verbs/remove.ts";
import { OperatorError } from "../src/verbs/io.ts";

async function scratch(): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), "harness-verbs-extra-")));
}

test("a commit message says what was asked and what proved it", () => {
  // Six months later the useful question about a commit is not what
  // changed -- the diff says that -- but what it was meant to satisfy.
  const message = commitMessage(
    { id: "r3", goal: "slug", gates: ["tests: passed, 12 assertions executed"], review: { verdict: "pass" } },
    "Slugify titles",
  );
  assert.match(message, /^Slugify titles\n/u);
  assert.match(message, /Applied by the harness as r3/u);
  assert.match(message, /12 assertions executed/u);
  assert.match(message, /review: pass/u);
});

test("a run with no feature title falls back to the goal", () => {
  const message = commitMessage({ id: "r1", goal: "add a --json flag", gates: [] }, undefined);
  assert.match(message, /^add a --json flag\n/u);
});

test("a directory that is not a repository is recognised as such", async () => {
  const root = await scratch();
  try {
    assert.equal(await isRepository(root), false);
    await git(root, ["init", "--quiet"]);
    assert.equal(await isRepository(root), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changed paths include untracked files and survive renames", async () => {
  // `git add --all` will stage untracked files, so a commit that reported
  // only tracked changes would understate what it was about to include.
  const root = await scratch();
  try {
    await git(root, ["init", "--quiet"]);
    await git(root, ["config", "user.email", "t@example.com"]);
    await git(root, ["config", "user.name", "T"]);
    await writeFile(path.join(root, "kept.txt"), "one");
    await git(root, ["add", "--all"]);
    await git(root, ["commit", "--quiet", "--message", "first"]);

    await writeFile(path.join(root, "fresh.txt"), "new");
    await writeFile(path.join(root, "kept.txt"), "two");
    const changed = await changedPaths(root);
    assert.deepEqual(changed.sort(), ["fresh.txt", "kept.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remove refuses anything that is not recognisably a project", () => {
  // Deleting the wrong directory is the one mistake this verb could make
  // that no snapshot anywhere would undo.
  assert.throws(
    () => { assertLooksLikeProject("/tmp/some-folder", ["notes.txt", "photos"]); },
    (error: unknown) => error instanceof OperatorError && /does not look like a project/u.test(error.message),
  );
  assert.throws(() => { assertLooksLikeProject("/", ["package.json"]); }, OperatorError);
  assert.throws(
    () => { assertLooksLikeProject(process.env.HOME ?? "/home/x", ["package.json"]); },
    OperatorError,
  );
});

test("remove accepts a directory the harness has plainly worked on", () => {
  for (const mark of ["package.json", "features.json", "AGENTS.md"]) {
    assert.doesNotThrow(() => { assertLooksLikeProject("/tmp/calc", [mark, "src"]); });
  }
});
