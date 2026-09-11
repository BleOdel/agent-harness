import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureBaseline, captureCandidate, copySource } from "../src/workspace/candidate.ts";
import { integrateCandidate } from "../src/team/integrate.ts";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "team-merge-")); const source = path.join(root, "source"); await mkdir(source);
  await writeFile(path.join(source, "shared.txt"), "one\ntwo\nthree\n");
  await writeFile(path.join(source, "contract.json"), '{"version":1}');
  const baseline = await captureBaseline(source, path.join(root, "baseline"));
  await copySource(source, path.join(root, "worker")); await copySource(source, path.join(root, "staging"));
  return { root, baseline, worker: path.join(root, "worker"), staging: path.join(root, "staging"), close: () => rm(root, { recursive: true, force: true }) };
}
test("three-way integration preserves both independent edits and candidate ancestry", async () => {
  const f = await fixture(); try {
    await writeFile(path.join(f.worker, "shared.txt"), "ONE\ntwo\nthree\n");
    await writeFile(path.join(f.staging, "shared.txt"), "one\ntwo\nTHREE\n");
    await writeFile(path.join(f.staging, "accepted.txt"), "other worker");
    const candidate = await captureCandidate(f.baseline, f.worker, path.join(f.root, "candidate"));
    const current = await captureBaseline(f.staging, path.join(f.root, "current"));
    const merged = await integrateCandidate(f.baseline, candidate, current, path.join(f.root, "proposal"), ["contract.json"]);
    assert.ok(merged.ok, JSON.stringify(merged));
    assert.equal(await readFile(path.join(merged.proposal.directory, "shared.txt"), "utf8"), "ONE\ntwo\nTHREE\n");
    assert.equal(await readFile(path.join(merged.proposal.directory, "accepted.txt"), "utf8"), "other worker");
    assert.equal(await readFile(path.join(current.directory, "shared.txt"), "utf8"), "one\ntwo\nTHREE\n");
    assert.equal(await readFile(path.join(candidate.directory, "shared.txt"), "utf8"), "ONE\ntwo\nthree\n");
  } finally { await f.close(); }
});

test("conflicts, delete/modify, binary collisions and stale contracts leave staging intact", async () => {
  for (const mode of ["conflict", "delete-modify", "binary", "stale", "dependency"] as const) {
    const f = await fixture(); try {
      if (mode === "delete-modify") await rm(path.join(f.worker, "shared.txt"));
      else await writeFile(path.join(f.worker, "shared.txt"), mode === "binary" ? Buffer.from([0,1,3]) : "worker change\n");
      await writeFile(path.join(f.staging, "shared.txt"), mode === "binary" ? Buffer.from([0,2,3]) : "staging change\n");
      if (mode === "stale") await writeFile(path.join(f.staging, "contract.json"), '{"version":2}');
      if (mode === "dependency") await writeFile(path.join(f.staging, "package.json"), '{}');
      const candidate = await captureCandidate(f.baseline, f.worker, path.join(f.root, "candidate"));
      const current = await captureBaseline(f.staging, path.join(f.root, "current"));
      const merged = await integrateCandidate(f.baseline, candidate, current, path.join(f.root, "proposal"), ["contract.json"]);
      assert.equal(merged.ok, false, mode);
      if (!merged.ok) assert.match(merged.reason, mode === "stale" || mode === "dependency" ? /stale/u : /conflict|binary|delete/u);
      assert.deepEqual(await readFile(path.join(current.directory, "shared.txt")), await readFile(path.join(f.staging, "shared.txt")));
    } finally { await f.close(); }
  }
});

test("identical edits are not applied twice; independent additions and deletions merge", async () => {
  const f = await fixture(); try {
    for (const dir of [f.worker, f.staging]) await writeFile(path.join(dir, "shared.txt"), "same\ntwo\nthree\n");
    await writeFile(path.join(f.worker, "new.txt"), "new"); await rm(path.join(f.worker, "contract.json"));
    const candidate = await captureCandidate(f.baseline, f.worker, path.join(f.root, "candidate"));
    const current = await captureBaseline(f.staging, path.join(f.root, "current"));
    const merged = await integrateCandidate(f.baseline, candidate, current, path.join(f.root, "proposal"), []);
    assert.ok(merged.ok); assert.equal(await readFile(path.join(merged.proposal.directory, "shared.txt"), "utf8"), "same\ntwo\nthree\n");
    assert.equal(await readFile(path.join(merged.proposal.directory, "new.txt"), "utf8"), "new");
    await assert.rejects(readFile(path.join(merged.proposal.directory, "contract.json")), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("file/directory collisions and nested dependency drift are explicit integration failures", async () => {
  for (const nested of [false, true]) {
    const f = await fixture(); try {
      await writeFile(path.join(f.worker, "node"), "incoming file");
      if (nested) { await mkdir(path.join(f.staging, "packages/a"), { recursive: true }); await writeFile(path.join(f.staging, "packages/a/package.json"), '{}'); }
      else { await mkdir(path.join(f.staging, "node")); await writeFile(path.join(f.staging, "node/child"), "accepted"); }
      const candidate = await captureCandidate(f.baseline, f.worker, path.join(f.root, "candidate"));
      const current = await captureBaseline(f.staging, path.join(f.root, "current"));
      const merged = await integrateCandidate(f.baseline, candidate, current, path.join(f.root, "proposal"), []);
      assert.equal(merged.ok, false);
      if (!merged.ok) assert.match(merged.reason, nested ? /stale/u : /directory conflict/u);
      await assert.rejects(readFile(path.join(f.root, "proposal.json")), { code: "ENOENT" });
    } finally { await f.close(); }
  }
});
