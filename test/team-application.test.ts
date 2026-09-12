import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { createTeam, driveTeam, type Worker } from "../src/team/controller.ts";
import { parseTeamPlan } from "../src/team/schema.ts";
import { copySource, captureCandidate } from "../src/workspace/candidate.ts";
import { readState } from "../src/team/state.ts";
import { readRecord } from "../src/record/record.ts";
import { applyTeam } from "./acceptance-fixture.ts";
import { recoverApplication, undoTeam } from "../src/team/apply.ts";
import { withWriter } from "../src/workspace/writer-lock.ts";

async function fixture(executables = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "team-apply-")), project = path.join(root, "project"); await mkdir(project);
  const features = [{ id: "feature", title: "Feature", criteria: ["new content works"], priority: "must" as const, status: "todo" as const, dependsOn: [] }];
  await writeFile(path.join(project, "features.json"), JSON.stringify(features));
  await writeFile(path.join(project, "old.txt"), "before"); await writeFile(path.join(project, ".env"), "private fixture");
  if (executables) { await writeFile(path.join(project, "removed.sh"), "#!/bin/sh\necho before\n"); await chmod(path.join(project, "removed.sh"), 0o755); }
  const plan = parseTeamPlan({ version: 1, roles: [{ id: "builder", instructions: "build", skills: [] }], skills: [] }, features);
  const directory = await createTeam(project, plan, root, { maxAttempts: 1, maxDispatches: 4, maxMs: 60000, maxCostUsd: 1 });
  const worker: Worker = {
    async execute(a) { const work = path.join(a.directory, "worker"); await copySource(a.baseline.directory, work); await writeFile(path.join(work, "old.txt"), "after"); await writeFile(path.join(work, "added.bin"), Buffer.from([0,255,1])); if (executables) { await rm(path.join(work, "removed.sh")); await writeFile(path.join(work, "new.sh"), "#!/bin/sh\necho after\n"); await chmod(path.join(work, "new.sh"), 0o755); } return { outcome: "submitted", candidate: await captureCandidate(a.baseline, work, path.join(a.directory, "candidate")), usage: { tokens: 0, costUsd: 0, complete: true }, observedReads: [], workflowEvidence: [] }; },
    async verify() { return { passed: true, gates: ["candidate passes"], review: "pass" }; },
    async verifyIntegration() { return { passed: true, gates: ["combined passes"], review: "pass" }; }, async cleanup() {},
  };
  await driveTeam(directory, worker);
  return { root, project, directory, features, close: () => rm(root, { recursive: true, force: true }) };
}
const featureStatus = async (project: string) => JSON.parse(await readFile(path.join(project, "features.json"), "utf8"))[0].status;

test("team application records the full batch once, applies binary bytes, and journals undo with downstream invalidation", async () => {
  const f = await fixture(); try {
    const state = await applyTeam(f.project, f.directory); assert.equal(state.status, "applied");
    assert.equal(await readFile(path.join(f.project, "old.txt"), "utf8"), "after"); assert.deepEqual(await readFile(path.join(f.project, "added.bin")), Buffer.from([0,255,1])); assert.equal(await featureStatus(f.project), "done");
    await applyTeam(f.project, f.directory); assert.equal((await readRecord(f.project)).runs.length, 1);
    const features = JSON.parse(await readFile(path.join(f.project, "features.json"), "utf8")); features.push({ id: "later", title: "Later", criteria: ["works"], priority: "must", status: "done", dependsOn: ["feature"] });
    await writeFile(path.join(f.project, "features.json"), JSON.stringify(features));
    await undoTeam(f.project, f.directory);
    assert.equal((await readState(f.directory)).status, "undone"); assert.equal(await readFile(path.join(f.project, "old.txt"), "utf8"), "before"); await assert.rejects(readFile(path.join(f.project, "added.bin")), { code: "ENOENT" });
    const undone = JSON.parse(await readFile(path.join(f.project, "features.json"), "utf8")); assert.equal(undone[0].status, "todo"); assert.equal(undone[1].status, "needs-revalidation");
    assert.equal((await readRecord(f.project)).runs.length, 2); assert.equal(await readFile(path.join(f.project, ".env"), "utf8"), "private fixture");
  } finally { await f.close(); }
});

test("interruption before, during and after source writes recovers without duplicate application or premature done", async () => {
  for (const point of ["intent", "write:added.bin", "sources", "features", "record", "event"] as const) {
    const f = await fixture(); try {
      await assert.rejects(applyTeam(f.project, f.directory, { checkpoint(name) { if (name === point) throw Error("injected crash"); } }), /injected crash/u);
      assert.notEqual((await readState(f.directory)).status, point === "event" ? "staged" : "applied");
      if (["intent", "write:added.bin", "sources"].includes(point)) assert.equal(await featureStatus(f.project), "todo");
      await assert.rejects(withWriter(f.project, "ordinary-work", async () => {}), /application.*recovery/iu);
      const state = await recoverApplication(f.project, f.directory); assert.equal(state.status, "applied");
      await recoverApplication(f.project, f.directory); assert.equal((await readRecord(f.project)).runs.length, 1);
      assert.equal(await readFile(path.join(f.project, "old.txt"), "utf8"), "after"); assert.equal(await featureStatus(f.project), "done");
      await withWriter(f.project, "ordinary-work", async () => {});
    } finally { await f.close(); }
  }
});

test("external source, feature and symlink changes refuse initial apply without overwriting anything", async () => {
  for (const mode of ["source", "features", "symlink"]) {
    const f = await fixture(); try {
      if (mode === "source") await writeFile(path.join(f.project, "old.txt"), "external");
      if (mode === "features") await writeFile(path.join(f.project, "features.json"), "[]");
      if (mode === "symlink") { await rm(path.join(f.project, "old.txt")); await symlink(path.join(f.project, ".env"), path.join(f.project, "old.txt")); }
      await assert.rejects(applyTeam(f.project, f.directory), /changed|symlink/u);
      assert.equal((await readRecord(f.project)).runs.length, 0); assert.equal((await readState(f.directory)).status, "staged");
      assert.equal(await readFile(path.join(f.project, ".env"), "utf8"), "private fixture");
    } finally { await f.close(); }
  }
});

test("rollback restores an interrupted batch but refuses a concurrent external edit", async () => {
  for (const edit of [false, true]) {
    const f = await fixture(); try {
      await assert.rejects(applyTeam(f.project, f.directory, { checkpoint(name) { if (name === "sources") throw Error("crash"); } }), /crash/u);
      if (edit) {
        await writeFile(path.join(f.project, "old.txt"), "external");
        await assert.rejects(recoverApplication(f.project, f.directory, { rollback: true }), /external|fingerprint|changed/u);
        assert.equal(await readFile(path.join(f.project, "old.txt"), "utf8"), "external");
        await assert.rejects(withWriter(f.project, "other", async () => {}), /recovery/iu);
      } else {
        assert.equal((await recoverApplication(f.project, f.directory, { rollback: true })).status, "staged");
        assert.equal(await readFile(path.join(f.project, "old.txt"), "utf8"), "before"); await assert.rejects(readFile(path.join(f.project, "added.bin")), { code: "ENOENT" });
        assert.equal(await featureStatus(f.project), "todo"); assert.equal((await readRecord(f.project)).runs.length, 0);
        await applyTeam(f.project, f.directory); assert.equal((await readRecord(f.project)).runs.length, 1);
      }
    } finally { await f.close(); }
  }
});

test("rollback direction survives another interruption, and rolled-back undo can be retried", async () => {
  const f = await fixture(); try {
    await assert.rejects(applyTeam(f.project, f.directory, { checkpoint(point) { if (point === "sources") throw Error("first crash"); } }), /first crash/u);
    await assert.rejects(recoverApplication(f.project, f.directory, { rollback: true, checkpoint(point) { if (point === "write:added.bin") throw Error("rollback crash"); } }), /rollback crash/u);
    assert.equal((await recoverApplication(f.project, f.directory)).status, "staged");
    assert.equal(await readFile(path.join(f.project, "old.txt"), "utf8"), "before"); assert.equal(await featureStatus(f.project), "todo");
    await applyTeam(f.project, f.directory);
    await assert.rejects(undoTeam(f.project, f.directory, { checkpoint(point) { if (point === "write:added.bin") throw Error("undo crash"); } }), /undo crash/u);
    assert.equal(await featureStatus(f.project), "todo");
    await recoverApplication(f.project, f.directory, { rollback: true });
    assert.equal(await featureStatus(f.project), "done");
    assert.equal((await undoTeam(f.project, f.directory)).status, "undone");
  } finally { await f.close(); }
});

test("an external edit during application preparation is refused before intent publication", async () => {
  const f = await fixture(); try {
    await assert.rejects(applyTeam(f.project, f.directory, { async checkpoint(point) { if (point === "prepared-intent") await writeFile(path.join(f.project, "old.txt"), "external during preparation"); } }), /changed/u);
    assert.equal(await readFile(path.join(f.project, "old.txt"), "utf8"), "external during preparation");
    assert.equal((await readRecord(f.project)).runs.length, 0);
    await withWriter(f.project, "another writer", async () => {});
  } finally { await f.close(); }
});

test("real process SIGKILL at preparation, rename, metadata and record boundaries recovers once", async () => {
  const { execFile } = await import("node:child_process"), { promisify } = await import("node:util");
  const { recoverWriter, writerPath } = await import("../src/workspace/writer-lock.ts");
  const exec = promisify(execFile), module = new URL("./acceptance-fixture.ts", import.meta.url).href;
  for (const point of ["intent", "prepared:added.bin", "replaced:added.bin", "sources", "features", "record", "event"]) {
    const f = await fixture(); try {
      const program = `import {applyTeam} from ${JSON.stringify(module)};await applyTeam(${JSON.stringify(f.project)},${JSON.stringify(f.directory)},{checkpoint(point){if(point===${JSON.stringify(point)})process.kill(process.pid,'SIGKILL')}});`;
      await assert.rejects(exec(process.execPath, ["--input-type=module", "-e", program]), (e: unknown) => (e as { signal: string }).signal === "SIGKILL", point);
      const owner = JSON.parse(await readFile(await writerPath(f.project), "utf8"));
      await recoverWriter(f.project, owner.token);
      assert.equal((await recoverApplication(f.project, f.directory)).status, "applied", point);
      assert.equal((await readRecord(f.project)).runs.length, 1); assert.equal(await featureStatus(f.project), "done");
      await recoverApplication(f.project, f.directory); assert.equal((await readRecord(f.project)).runs.length, 1);
    } finally { await f.close(); }
  }
});

test("a file edited while its replacement is prepared is preserved", async () => {
  const f = await fixture(); try {
    await assert.rejects(applyTeam(f.project, f.directory, { async checkpoint(point) { if (point === "prepared:old.txt") await writeFile(path.join(f.project, "old.txt"), "external at replacement"); } }), /External change/u);
    assert.equal(await readFile(path.join(f.project, "old.txt"), "utf8"), "external at replacement");
    assert.equal(await featureStatus(f.project), "todo"); assert.equal((await readRecord(f.project)).runs.length, 0);
  } finally { await f.close(); }
});


test("a feature manifest edited during replacement is preserved", async () => {
  const f = await fixture(); try {
    await assert.rejects(applyTeam(f.project, f.directory, { async checkpoint(point) { if (point === "prepared:features.json") await writeFile(path.join(f.project, "features.json"), "[]"); } }), /External feature change/u);
    assert.equal(await readFile(path.join(f.project, "features.json"), "utf8"), "[]");
    assert.equal((await readRecord(f.project)).runs.length, 0);
  } finally { await f.close(); }
});

test("new executable files and deleted executable restoration retain permissions", async () => {
  const f = await fixture(true); try {
    await applyTeam(f.project, f.directory);
    assert.equal((await stat(path.join(f.project, "new.sh"))).mode & 0o777, 0o755);
    await assert.rejects(readFile(path.join(f.project, "removed.sh")), { code: "ENOENT" });
    await undoTeam(f.project, f.directory);
    assert.equal((await stat(path.join(f.project, "removed.sh"))).mode & 0o777, 0o755);
    assert.equal(await readFile(path.join(f.project, "removed.sh"), "utf8"), "#!/bin/sh\necho before\n");
    await assert.rejects(readFile(path.join(f.project, "new.sh")), { code: "ENOENT" });
  } finally { await f.close(); }
});


test("team application refuses staged work without approved acceptance evidence", async () => {
  const f = await fixture();
  try {
    const { applyTeam: unchecked } = await import("../src/team/apply.ts");
    await assert.rejects(unchecked(f.project, f.directory), /acceptance/i);
    assert.equal(await readFile(path.join(f.project, "old.txt"), "utf8"), "before");
    assert.equal((await readRecord(f.project)).runs.length, 0);
  } finally { await f.close(); }
});
