import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureBaseline, captureCandidate, assertSnapshot, assertLiveBaseline } from "../src/workspace/candidate.ts";
import { createSandbox, destroySandbox } from "../src/workspace/sandbox-lifecycle.ts";

test("candidate uses the starting baseline and never takes worker dependencies or later live edits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-frozen-"));
  let worker;
  try {
    const project = path.join(root, "project"); await mkdir(project);
    await writeFile(path.join(project, "a.js"), "original");
    const baseline = await captureBaseline(project, path.join(root, "baseline"));
    worker = await createSandbox(baseline.directory);
    await writeFile(path.join(project, "a.js"), "external edit");
    await writeFile(path.join(worker.workDirectory, "b.js"), "candidate");
    await mkdir(path.join(worker.workDirectory, "node_modules", "evil"), { recursive: true });
    await writeFile(path.join(worker.workDirectory, "node_modules", "evil", "index.js"), "fake success");
    const candidate = await captureCandidate(baseline, worker.workDirectory, path.join(root, "candidate"));
    assert.deepEqual(candidate.changes.map(c => c.file), ["b.js"]);
    assert.equal(await readFile(path.join(candidate.directory, "a.js"), "utf8"), "original");
    await assert.rejects(readFile(path.join(candidate.directory, "node_modules", "evil", "index.js")));
    await assert.rejects(assertLiveBaseline(project, baseline), /changed/u);
    await writeFile(path.join(worker.workDirectory, "b.js"), "late edit");
    assert.equal(await readFile(path.join(candidate.directory, "b.js"), "utf8"), "candidate");
    await assertSnapshot(candidate);
    await writeFile(path.join(candidate.directory, "b.js"), "tamper");
    await assert.rejects(assertSnapshot(candidate), /changed/u);
  } finally { if (worker) await destroySandbox(worker); await rm(root, { recursive: true, force: true }); }
});

test("symlinks and ordinary shared-input edits are refused before candidate creation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-frozen-"));
  let worker;
  try {
    const project = path.join(root, "project"); await mkdir(project);
    await writeFile(path.join(project, "package.json"), '{}');
    const baseline = await captureBaseline(project, path.join(root, "baseline"));
    worker = await createSandbox(baseline.directory);
    await symlink('/etc/passwd', path.join(worker.workDirectory, 'escape'));
    await assert.rejects(captureCandidate(baseline, worker.workDirectory, path.join(root, 'bad')), /symlink/u);
    await rm(path.join(worker.workDirectory, 'escape'));
    await writeFile(path.join(worker.workDirectory, 'package.json'), '{"dependencies":{"x":"1"}}');
    await assert.rejects(captureCandidate(baseline, worker.workDirectory, path.join(root, 'ordinary')), /dedicated/u);
    const candidate = await captureCandidate(baseline, worker.workDirectory, path.join(root, 'dedicated'), { sharedInputs: true });
    assert.equal(candidate.sharedInputsChanged, true);
  } finally { if (worker) await destroySandbox(worker); await rm(root, { recursive: true, force: true }); }
});
