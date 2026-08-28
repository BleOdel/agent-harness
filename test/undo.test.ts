import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendRun,
  appendUndo,
  nextRunId,
  readRecord,
  recoveryPath,
  reverserOf,
  type RunRecord,
  undoableRuns,
} from "../src/record/record.ts";
import { planUndo } from "../src/recovery/plan-undo.ts";
import { snapshotForRecovery } from "../src/workspace/sandbox-lifecycle.ts";
import type { Change } from "../src/workspace/changes.ts";

/**
 * The plan's M4 verification: undo any change at any point, including
 * after later changes touched the same files.
 */

async function scratch(): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), "harness-undo-test-")));
}

const change = (file: string, kind: Change["kind"]): Change => ({ file, kind, symlink: false });

/** Applies a change set and snapshots it the way `work` does. */
async function applyRun(
  project: string,
  id: string,
  files: Record<string, string | null>,
): Promise<RunRecord> {
  const changes: Change[] = [];
  const staging = path.join(path.dirname(project), `staging-${id}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  for (const [file, content] of Object.entries(files)) {
    const existed = existsSync(path.join(project, file));
    changes.push(change(file, content === null ? "deleted" : existed ? "modified" : "added"));
    if (content !== null) {
      await mkdir(path.dirname(path.join(staging, file)), { recursive: true });
      await writeFile(path.join(staging, file), content, "utf8");
    }
  }
  await snapshotForRecovery(project, staging, changes, recoveryPath(project, id));
  for (const [file, content] of Object.entries(files)) {
    if (content === null) await rm(path.join(project, file), { force: true });
    else {
      await mkdir(path.dirname(path.join(project, file)), { recursive: true });
      await writeFile(path.join(project, file), content, "utf8");
    }
  }
  const run: RunRecord = {
    id,
    at: new Date().toISOString(),
    project,
    goal: `run ${id}`,
    attempts: 1,
    outcome: "applied",
    gates: [],
    changes,
  };
  await appendRun(project, run);
  await rm(staging, { recursive: true, force: true });
  return run;
}

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratch();
  const directory = path.join(root, "project");
  await mkdir(directory, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), content, "utf8");
  }
  return directory;
}

test("undoing a run nothing has touched since restores it exactly", async () => {
  const directory = await project({ "app.js": "const version = 1;\n" });
  try {
    const run = await applyRun(directory, "r1", { "app.js": "const version = 2;\n" });
    const { outcomes, writes } = await planUndo(directory, run, recoveryPath(directory, "r1"));
    assert.deepEqual(outcomes.map((o) => o.action), ["restored"]);
    assert.equal(writes.get("app.js"), "const version = 1;\n");
  } finally {
    await rm(path.dirname(directory), { recursive: true, force: true });
  }
});

test("undoing a run whose file a later run also changed keeps the later work", async () => {
  // The requirement the plan singles out. Restoring the snapshot outright
  // here would silently delete r2's line.
  const directory = await project({ "app.js": "header\nold\nfooter\n" });
  try {
    const r1 = await applyRun(directory, "r1", { "app.js": "header\nNEW\nfooter\n" });
    await applyRun(directory, "r2", { "app.js": "header\nNEW\nfooter\nADDED BY R2\n" });

    const { outcomes, writes } = await planUndo(directory, r1, recoveryPath(directory, "r1"));
    assert.deepEqual(outcomes.map((o) => o.action), ["merged"]);
    assert.equal(writes.get("app.js"), "header\nold\nfooter\nADDED BY R2\n");
  } finally {
    await rm(path.dirname(directory), { recursive: true, force: true });
  }
});

test("undoing a run whose exact lines a later run rewrote conflicts rather than guessing", async () => {
  const directory = await project({ "app.js": "a\nold\nc\n" });
  try {
    const r1 = await applyRun(directory, "r1", { "app.js": "a\nNEW\nc\n" });
    await applyRun(directory, "r2", { "app.js": "a\nREWRITTEN BY R2\nc\n" });

    const { outcomes, writes } = await planUndo(directory, r1, recoveryPath(directory, "r1"));
    assert.deepEqual(outcomes.map((o) => o.action), ["conflicted"]);
    assert.equal(writes.size, 0, "a conflicting undo must write nothing at all");
  } finally {
    await rm(path.dirname(directory), { recursive: true, force: true });
  }
});

test("undoing a run that created a file removes it", async () => {
  const directory = await project({});
  try {
    const run = await applyRun(directory, "r1", { "new.js": "export const a = 1;\n" });
    const { outcomes, writes } = await planUndo(directory, run, recoveryPath(directory, "r1"));
    assert.deepEqual(outcomes.map((o) => o.action), ["removed"]);
    assert.equal(writes.get("new.js"), undefined);
    assert.ok(writes.has("new.js"));
  } finally {
    await rm(path.dirname(directory), { recursive: true, force: true });
  }
});

test("a created file edited since is not deleted out from under the later work", async () => {
  const directory = await project({});
  try {
    const run = await applyRun(directory, "r1", { "new.js": "export const a = 1;\n" });
    await writeFile(path.join(directory, "new.js"), "export const a = 1;\nexport const b = 2;\n");
    const { outcomes } = await planUndo(directory, run, recoveryPath(directory, "r1"));
    assert.deepEqual(outcomes.map((o) => o.action), ["conflicted"]);
    assert.match(outcomes[0]!.detail ?? "", /would discard that work/u);
  } finally {
    await rm(path.dirname(directory), { recursive: true, force: true });
  }
});

test("undoing a run that deleted a file puts it back", async () => {
  const directory = await project({ "gone.js": "export const gone = true;\n" });
  try {
    const run = await applyRun(directory, "r1", { "gone.js": null });
    assert.equal(existsSync(path.join(directory, "gone.js")), false);
    const { outcomes, writes } = await planUndo(directory, run, recoveryPath(directory, "r1"));
    assert.deepEqual(outcomes.map((o) => o.action), ["restored"]);
    assert.equal(writes.get("gone.js"), "export const gone = true;\n");
  } finally {
    await rm(path.dirname(directory), { recursive: true, force: true });
  }
});

test("an undone run stops being undoable, and the undo itself is", async () => {
  // The name of this test claimed two things and the first version
  // asserted only that the list was empty -- which is what a bug that
  // makes nothing undoable also produces. The undo must appear.
  const directory = await project({ "app.js": "one\n" });
  try {
    const r1 = await applyRun(directory, "r1", { "app.js": "two\n" });
    await appendUndo(directory, "r2", r1, r1.changes);
    const { runs } = await readRecord(directory);
    assert.deepEqual(undoableRuns(runs).map((r) => r.id), ["r2"]);
    assert.equal(reverserOf(runs, "r1"), "r2");
    assert.equal(await nextRunId(directory), "r3");
  } finally {
    await rm(path.dirname(directory), { recursive: true, force: true });
  }
});

test("undoing an undo puts the original back in play", async () => {
  // Reversal is a stack, not a flag. r3 undoes r1; r4 undoes r3; r1 is
  // standing again and must be undoable again.
  const directory = await project({ "app.js": "one\n" });
  try {
    const r1 = await applyRun(directory, "r1", { "app.js": "two\n" });
    await appendUndo(directory, "r2", r1, r1.changes);
    let { runs } = await readRecord(directory);
    const r2 = runs.find((r) => r.id === "r2")!;
    await appendUndo(directory, "r3", r2, r2.changes);
    ({ runs } = await readRecord(directory));
    assert.deepEqual(undoableRuns(runs).map((r) => r.id), ["r1", "r3"]);
    assert.equal(reverserOf(runs, "r1"), undefined, "r1 was reversed and then unreversed");
  } finally {
    await rm(path.dirname(directory), { recursive: true, force: true });
  }
});

test("run ids account for unreadable lines rather than reusing one", async () => {
  // Two runs sharing an id means two runs sharing a recovery directory,
  // and the second one silently overwrites the first one's snapshot.
  const directory = await project({});
  try {
    await applyRun(directory, "r1", { "a.js": "1\n" });
    const { appendFile } = await import("node:fs/promises");
    const { recordPath } = await import("../src/record/record.ts");
    await appendFile(recordPath(directory), "{ this is not json\n", "utf8");
    const { malformed } = await readRecord(directory);
    assert.deepEqual(malformed, [2]);
    assert.equal(await nextRunId(directory), "r3");
  } finally {
    await rm(path.dirname(directory), { recursive: true, force: true });
  }
});

test("undoing the run that completed an item puts the item back on the list", async () => {
  // Otherwise `look` reports an item as done while the code implementing
  // it has just been removed, which is the one thing the record exists to
  // prevent.
  const { markDone, parseFeatures } = await import("../src/features.ts");
  const { markStatus } = await import("../src/features.ts");
  const directory = await project({ "app.js": "one\n" });
  try {
    await writeFile(
      path.join(directory, "features.json"),
      JSON.stringify([{ id: "thing", title: "T", priority: "must", status: "todo", criteria: ["c"], dependsOn: [] }]),
      "utf8",
    );
    await markDone(directory, "thing");
    assert.equal(await markStatus(directory, "thing", "todo"), true);

    const list = parseFeatures(await readFile(path.join(directory, "features.json"), "utf8"));
    assert.equal(list.ok, true);
    if (list.ok) assert.equal(list.features[0]!.status, "todo");
  } finally {
    await rm(path.dirname(directory), { recursive: true, force: true });
  }
});

test("marking a status reports whether it actually happened", async () => {
  // A silent no-op would make undo announce a reopening that never
  // occurred.
  const { markStatus } = await import("../src/features.ts");
  const directory = await project({});
  try {
    assert.equal(await markStatus(directory, "absent", "todo"), false, "no feature list at all");
    await writeFile(path.join(directory, "features.json"), "[]", "utf8");
    assert.equal(await markStatus(directory, "absent", "todo"), false, "no such item");
  } finally {
    await rm(path.dirname(directory), { recursive: true, force: true });
  }
});
