import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectChanges } from "../src/workspace/changes.ts";
import {
  applyChanges,
  createSandbox,
  destroySandbox,
  snapshotForRecovery,
} from "../src/workspace/sandbox-lifecycle.ts";

async function project(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "harness-lifecycle-test-")));
  const directory = path.join(root, "project");
  await mkdir(path.join(directory, "src"), { recursive: true });
  await mkdir(path.join(directory, ".git"), { recursive: true });
  await writeFile(path.join(directory, "src", "app.ts"), "export const version = 1;\n");
  await writeFile(path.join(directory, "README.md"), "# project\n");
  await writeFile(path.join(directory, ".git", "HEAD"), "ref: refs/heads/main\n");
  return directory;
}

test("the copy carries the project but never .git", async () => {
  const directory = await project();
  const sandbox = await createSandbox(directory);
  try {
    assert.deepEqual((await readdir(sandbox.workDirectory)).sort(), ["README.md", "src"]);
    assert.equal(
      await readFile(path.join(sandbox.workDirectory, "src", "app.ts"), "utf8"),
      "export const version = 1;\n",
    );
  } finally {
    await destroySandbox(sandbox);
    await rm(path.dirname(directory), { recursive: true, force: true });
  }
});

test("a symlink in the project stays a symlink in the copy", async () => {
  // If cp dereferenced, a link pointing outside the project would become
  // a real copy of whatever it pointed at -- carrying that content into
  // the sandbox the boundary exists to keep it out of.
  const directory = await project();
  await writeFile(path.join(path.dirname(directory), "outside.txt"), "private");
  await symlink(path.join(path.dirname(directory), "outside.txt"), path.join(directory, "link.txt"));
  const sandbox = await createSandbox(directory);
  try {
    const { lstat } = await import("node:fs/promises");
    assert.ok((await lstat(path.join(sandbox.workDirectory, "link.txt"))).isSymbolicLink());
  } finally {
    await destroySandbox(sandbox);
    await rm(path.dirname(directory), { recursive: true, force: true });
  }
});

test("destroying the sandbox removes it entirely", async () => {
  const directory = await project();
  const sandbox = await createSandbox(directory);
  await destroySandbox(sandbox);
  assert.equal(existsSync(sandbox.root), false);
  await rm(path.dirname(directory), { recursive: true, force: true });
});

test("a snapshot restores every kind of change", async () => {
  // The guarantee is that nothing reaching the repository is
  // irreversible. Asserted by actually reversing it, not by checking
  // that a snapshot directory exists.
  const directory = await project();
  const sandbox = await createSandbox(directory);
  try {
    await writeFile(path.join(sandbox.workDirectory, "src", "app.ts"), "export const version = 2;\n");
    await writeFile(path.join(sandbox.workDirectory, "src", "new.ts"), "export const added = true;\n");
    await rm(path.join(sandbox.workDirectory, "README.md"));

    const changes = await collectChanges(directory, sandbox.workDirectory);
    assert.deepEqual(changes.map((change) => `${change.kind} ${change.file}`), [
      "deleted README.md",
      "modified src/app.ts",
      "added src/new.ts",
    ]);

    const recovery = await snapshotForRecovery(directory, changes);
    await applyChanges(directory, sandbox.workDirectory, changes);
    assert.equal(await readFile(path.join(directory, "src", "app.ts"), "utf8"), "export const version = 2;\n");
    assert.equal(existsSync(path.join(directory, "README.md")), false);

    // Reverse it using only what the snapshot holds.
    const record = JSON.parse(await readFile(path.join(recovery.directory, "CHANGES.json"), "utf8")) as {
      changes: { file: string; kind: string }[];
    };
    for (const change of record.changes) {
      if (change.kind === "added") await rm(path.join(directory, change.file), { force: true });
      else await writeFile(path.join(directory, change.file), await readFile(path.join(recovery.directory, change.file)));
    }
    assert.equal(await readFile(path.join(directory, "src", "app.ts"), "utf8"), "export const version = 1;\n");
    assert.equal(await readFile(path.join(directory, "README.md"), "utf8"), "# project\n");
    assert.equal(existsSync(path.join(directory, "src", "new.ts")), false);
  } finally {
    await destroySandbox(sandbox);
    await rm(path.dirname(directory), { recursive: true, force: true });
    await rm(`${directory}-recovery`, { recursive: true, force: true });
  }
});
