import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTeam, driveTeam, resumeTeam, type Worker } from "../src/team/controller.ts";
import { parseTeamPlan, type Policy } from "../src/team/schema.ts";
import { captureCandidate, copySource } from "../src/workspace/candidate.ts";
import { readState } from "../src/team/state.ts";

async function fixture(repairs = 1, limits: Partial<Policy> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "team-resume-")), project = path.join(root, "project"); await mkdir(project);
  const tasks = ["api", "client"].map((id, i) => ({ id, title: id, priority: "must" as const, status: "todo" as const, criteria: ["works"], dependsOn: i ? ["api"] : [], changeScope: [`${id}.txt`] }));
  await writeFile(path.join(project, "features.json"), JSON.stringify(tasks));
  const plan = parseTeamPlan({ version: 1, roles: [{ id: "b", instructions: "build", skills: [] }], skills: [] }, tasks);
  const directory = await createTeam(project, plan, root, { maxAttempts: 1, maxRepairs: repairs, maxDispatches: 8, maxMs: 60000, maxCostUsd: 1, ...limits });
  const worker: Worker = {
    async execute(a) { const work = path.join(a.directory, "worker"); await copySource(a.baseline.directory, work); await writeFile(path.join(work, `${a.taskId}.txt`), a.repairOf ? "repaired" : "built"); return { outcome: "submitted", candidate: await captureCandidate(a.baseline, work, path.join(a.directory, "candidate")), usage: { tokens: 1, costUsd: 0, complete: true }, observedReads: [], workflowEvidence: [] }; },
    async verify() { return { passed: true, gates: ["component passes"], review: "pass" }; },
    async verifyIntegration() { return { passed: true, gates: ["combined passes"], review: "pass" }; }, async cleanup() {},
  };
  return { root, project, directory, worker, close: () => rm(root, { recursive: true, force: true }) };
}

test("resume reconciles unfinished workers, retains accepted staging, and never reruns accepted tasks", async () => {
  const f = await fixture(); try {
    const calls: string[] = [], cleaned: string[] = [];
    await assert.rejects(driveTeam(f.directory, { ...f.worker, async execute(a, t, r) { calls.push(a.taskId); if (a.taskId === "client") throw Error("transport interrupted"); return f.worker.execute(a, t, r); } }), /transport interrupted/u);
    const before = await readState(f.directory); assert.deepEqual(before.integrated, ["api"]);
    const result = await resumeTeam(f.project, f.directory, { ...f.worker, async cleanup(a) { cleaned.push(a.id); }, async execute(a, t, r) { calls.push(a.taskId); assert.equal(await readFile(path.join(a.baseline.directory, "api.txt"), "utf8"), "built"); return f.worker.execute(a, t, r); } });
    assert.equal(result.status, "staged"); assert.deepEqual(calls, ["api", "client", "client"]); assert.equal(cleaned.includes(before.attempts[1]!.id), true);
    assert.equal(result.attempts[1]!.status, "interrupted"); assert.notEqual(result.attempts[1]!.id, result.attempts[2]!.id);
    const again = await resumeTeam(f.project, f.directory, { ...f.worker, async execute() { throw Error("must not launch"); } }); assert.equal(again.seq, result.seq);
  } finally { await f.close(); }
});

test("integration repair uses current staging, a failure report, original scope, and all gates", async () => {
  const f = await fixture(); try {
    let repaired = false, verifiedRepair = false;
    const state = await driveTeam(f.directory, { ...f.worker,
      async execute(a, t, r) { if (a.repairOf) { repaired = true; assert.equal(a.taskId, "api"); assert.deepEqual(t.changeScope, ["api.txt"]); assert.match(a.feedback ?? "", /response shape/u); assert.ok(a.repairCandidate); } return f.worker.execute(a, t, r); },
      async verify(a, r, t) { if (a.repairOf) verifiedRepair = true; return f.worker.verify(a, r, t); },
      async verifyIntegration(a) { return a.taskId === "api" && !a.repairOf ? { passed: false, gates: ["response shape mismatch"], review: "pass", reason: "response shape mismatch" } : { passed: true, gates: ["combined passes"], review: "pass" }; },
    });
    assert.equal(state.status, "staged"); assert.equal(repaired, true); assert.equal(verifiedRepair, true); assert.equal(state.attempts.length, 3); assert.equal(await readFile(path.join(state.baseline.directory, "api.txt"), "utf8"), "repaired");
  } finally { await f.close(); }
});

test("a second integration failure blocks dependents and resume does not reset the repair allowance", async () => {
  const f = await fixture(); try {
    const fail: Worker = { ...f.worker, async verifyIntegration() { return { passed: false, gates: ["incompatible"], review: "pass", reason: "incompatible" }; } };
    const state = await driveTeam(f.directory, fail); assert.equal(state.status, "stopped"); assert.equal(state.attempts.length, 2); assert.deepEqual(state.integrated, []); assert.equal(state.attempts[1]!.status, "blocked");
    const resumed = await resumeTeam(f.project, f.directory, { ...fail, async execute() { throw Error("exhausted repair must not relaunch"); } }); assert.equal(resumed.attempts.length, 2); assert.equal(resumed.status, "stopped");
  } finally { await f.close(); }
});

test("resume refuses live drift and corrupt retained staging before new dispatch", async () => {
  for (const tamper of ["live", "staging"] as const) {
    const f = await fixture(); try {
      await assert.rejects(driveTeam(f.directory, { ...f.worker, async execute(a, t, r) { if (a.taskId === "client") throw Error("crash"); return f.worker.execute(a, t, r); } }), /crash/u);
      const state = await readState(f.directory);
      await writeFile(path.join(tamper === "live" ? f.project : state.baseline.directory, "api.txt"), "external");
      await assert.rejects(resumeTeam(f.project, f.directory, f.worker), /changed/u);
      assert.equal((await readState(f.directory)).attempts.length, 2);
    } finally { await f.close(); }
  }
});


test("resume retains the original dispatch, cost and wall-clock ceilings", async () => {
  for (const limit of ["dispatch", "cost", "time"]) {
    const f = await fixture(1, limit === "dispatch" ? { maxDispatches: 1 } : limit === "time" ? { maxMs: 1 } : {}); try {
      const before = await driveTeam(f.directory, { ...f.worker, async execute(a, t, r) { const result = await f.worker.execute(a, t, r); return { ...result, usage: { tokens: 1, costUsd: limit === "cost" ? 1 : 0, complete: true } }; } });
      assert.equal(before.status, "stopped"); assert.match(before.reason ?? "", /limit reached/u);
      const after = await resumeTeam(f.project, f.directory, { ...f.worker, async execute() { throw Error("budget must not reset"); } });
      assert.equal(after.status, "stopped"); assert.equal(after.attempts.length, before.attempts.length);
      assert.equal(after.startedAt, before.startedAt); assert.deepEqual(after.usage, before.usage); assert.deepEqual(after.policy, before.policy);
    } finally { await f.close(); }
  }
});

test("an interrupted repair resumes the same failure with a fresh attempt identity", async () => {
  const f = await fixture(); try {
    const first: Worker = { ...f.worker,
      async execute(a, t, r) { if (a.repairOf) throw Error("repair transport lost"); return f.worker.execute(a, t, r); },
      async verifyIntegration() { return { passed: false, gates: ["contract mismatch"], review: "pass", reason: "contract mismatch" }; },
    };
    await assert.rejects(driveTeam(f.directory, first), /repair transport lost/u);
    const before = await readState(f.directory); assert.equal(before.attempts.length, 2);
    const after = await resumeTeam(f.project, f.directory, { ...f.worker, async execute(a, t, r) {
      if (a.taskId === "api") { assert.equal(a.repairOf, before.attempts[0]!.id); assert.notEqual(a.id, before.attempts[1]!.id); }
      return f.worker.execute(a, t, r);
    } });
    assert.equal(after.status, "staged"); assert.equal(after.attempts.length, 4);
    assert.equal(after.attempts[1]!.status, "interrupted");
  } finally { await f.close(); }
});
