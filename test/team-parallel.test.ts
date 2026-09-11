import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createTeam, driveTeam, type Worker } from "../src/team/controller.ts";
import { captureCandidate, copySource } from "../src/workspace/candidate.ts";
import { parseTeamPlan } from "../src/team/schema.ts";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "team-parallel-")); const project = path.join(root, "project"); await mkdir(project);
  await writeFile(path.join(project, "base.txt"), "original");
  const plan = parseTeamPlan({ version: 1, roles: [{ id: "builder", instructions: "build", skills: [] }], skills: [], contracts: {} }, [
    { id: "a", title: "a", priority: "must", status: "todo", criteria: ["a works"], dependsOn: [] },
    { id: "b", title: "b", priority: "must", status: "todo", criteria: ["b works"], dependsOn: [] },
    { id: "final", title: "final", priority: "must", status: "todo", criteria: ["both work"], dependsOn: ["a", "b"] },
  ]);
  const directory = await createTeam(project, plan, root, { maxWorkers: 2, maxRepairs: 0, maxAttempts: 1, maxDispatches: 10, maxMs: 100000, maxCostUsd: 10 });
  return { root, project, directory, close: () => rm(root, { recursive: true, force: true }) };
}

test("two builders overlap on one baseline; integrations serialize and the final task sees both", { timeout: 10000 }, async () => {
  const f = await fixture();
  let active = 0, peak = 0, checking = 0;
  const bases: string[] = [], calls: string[] = [];
  let releaseB!: () => void;
  const integratedB = new Promise<void>(resolve => { releaseB = resolve; });
  try {
    const worker: Worker = {
      async execute(a, t) {
        active++; peak = Math.max(peak, active); if (t.id !== "final") bases.push(a.baseline.digest);
        const work = path.join(a.directory, "worker"); await copySource(a.baseline.directory, work);
        if (t.id === "final") for (const id of ["a", "b"]) assert.equal(await readFile(path.join(work, `${id}.txt`), "utf8"), id);
        if (t.id === "a") await integratedB;
        await writeFile(path.join(work, `${t.id}.txt`), t.id);
        const candidate = await captureCandidate(a.baseline, work, path.join(a.directory, "candidate")); active--;
        return { outcome: "submitted", candidate, usage: { tokens: 1, costUsd: 0, complete: true }, observedReads: [], workflowEvidence: [] };
      },
      async verify() { return { passed: true, gates: ["component tests pass"], review: "pass" }; },
      async verifyIntegration(a, proposal) {
        checking++; assert.equal(checking, 1); calls.push(a.taskId);
        if (a.taskId === "a") assert.equal(await readFile(path.join(proposal.directory, "b.txt"), "utf8"), "b");
        await delay(10); checking--; return { passed: true, gates: ["combined contract passes"], review: "pass" };
      },
      async cleanup(a) { if (a.taskId === "b") releaseB(); },
    };
    const result = await driveTeam(f.directory, worker);
    assert.equal(peak, 2); assert.equal(new Set(bases).size, 1); assert.deepEqual(calls, ["b", "a", "final"]);
    assert.equal(result.status, "staged"); assert.deepEqual(result.integrated, ["b", "a", "final"]);
    await assert.rejects(readFile(path.join(f.project, "a.txt")), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("component passes cannot advance staging after failed combined verification", async () => {
  const f = await fixture(); try {
    const worker: Worker = {
      async execute(a, t) {
        const work = path.join(a.directory, "worker"); await copySource(a.baseline.directory, work);
        await delay(t.id === "a" ? 5 : 100); await writeFile(path.join(work, `${t.id}.txt`), t.id);
        return { outcome: "submitted", candidate: await captureCandidate(a.baseline, work, path.join(a.directory, "candidate")), usage: { tokens: 1, costUsd: 0, complete: true }, observedReads: [], workflowEvidence: [] };
      },
      async verify() { return { passed: true, gates: ["component tests pass"], review: "pass" }; },
      async verifyIntegration(a) { return a.taskId === "b" ? { passed: false, gates: ["response shape incompatible"], review: "not-run", reason: "contract mismatch" } : { passed: true, gates: ["combined pass"], review: "pass" }; },
      async cleanup() {},
    };
    const state = await driveTeam(f.directory, worker);
    assert.equal(state.status, "stopped"); assert.deepEqual(state.integrated, ["a"]);
    assert.equal(state.attempts.find(a => a.taskId === "b")?.status, "failed");
    assert.equal(state.attempts.some(a => a.taskId === "final"), false);
    assert.equal(await readFile(path.join(state.baseline.directory, "a.txt"), "utf8"), "a");
    await assert.rejects(readFile(path.join(state.baseline.directory, "b.txt")), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("dispatch ceiling drains both running builders and controller failure cleans every owned attempt", async () => {
  for (const crash of [false, true]) {
    const f = await fixture();
    try {
      const { readState, createState } = await import("../src/team/state.ts");
      const initial = await readState(f.directory);
      // Create a separate journal with an intentionally tight dispatch budget.
      const dir = path.join(f.root, "bounded"); await mkdir(path.join(dir, "inputs"), { recursive: true });
      await writeFile(path.join(dir, "inputs/skills.json"), "[]");
      await createState(dir, initial.plan, initial.baseline, { ...initial.policy, maxDispatches: 2 });
      const cleaned = new Set<string>();
      let releaseA!: () => void;
      const finishedA = new Promise<void>(resolve => { releaseA = resolve; });
      const worker: Worker = {
        async execute(a) {
          if (a.taskId === "b") await finishedA;
          const work = path.join(a.directory, "worker"); await copySource(a.baseline.directory, work);
          await writeFile(path.join(work, `${a.taskId}.txt`), "works");
          return { outcome: "submitted", candidate: await captureCandidate(a.baseline, work, path.join(a.directory, "candidate")), usage: { tokens: 1, costUsd: 0, complete: true }, observedReads: [], workflowEvidence: [] };
        },
        async verify() { if (crash) throw Error("transport broke"); return { passed: true, gates: ["component passes"], review: "pass" }; },
        async verifyIntegration() { return { passed: true, gates: ["combined passes"], review: "pass" }; },
        async cleanup(a) { cleaned.add(a.id); if (a.taskId === "a") releaseA(); },
      };
      if (crash) await assert.rejects(driveTeam(dir, worker), /transport broke/u);
      else { const state = await driveTeam(dir, worker); assert.equal(state.status, "stopped"); assert.deepEqual(state.integrated, ["a", "b"]); assert.match(state.reason ?? "", /Dispatch limit/u); }
      const state = await readState(dir); assert.equal(state.attempts.length, 2); assert.equal(cleaned.size, 2);
      if (crash) assert.deepEqual(state.integrated, []);
    } finally { await f.close(); }
  }
});

test("shared-input assignments are exclusive and accepted before ordinary dispatch", async () => {
  const f = await fixture(); try {
    const { createState } = await import("../src/team/state.ts");
    const { captureBaseline } = await import("../src/workspace/candidate.ts");
    const dir = path.join(f.root, "exclusive"); await mkdir(path.join(dir, "inputs"), { recursive: true }); await writeFile(path.join(dir, "inputs/skills.json"), "[]");
    const plan = parseTeamPlan({ version: 1, roles: [{ id: "b", instructions: "build", skills: [] }], skills: [] }, [
      { id: "ordinary", title: "ordinary", priority: "must", status: "todo", criteria: ["works"], dependsOn: [] },
      { id: "inputs", title: "inputs", priority: "should", status: "todo", kind: "shared-inputs", criteria: ["works"], dependsOn: [] },
    ]);
    await createState(dir, plan, await captureBaseline(f.project, path.join(f.root, "exclusive-base")), { maxWorkers: 2, maxRepairs: 0, maxAttempts: 1, maxDispatches: 2, maxMs: 60000, maxCostUsd: 1 });
    let active = 0; const calls: string[] = [];
    const state = await driveTeam(dir, {
      async execute(a, t) {
        active++; assert.equal(active, 1); calls.push(t.id);
        const work = path.join(a.directory, "worker"); await copySource(a.baseline.directory, work);
        if (t.id === "ordinary") assert.equal(await readFile(path.join(work, "package.json"), "utf8"), '{}');
        await writeFile(path.join(work, t.id === "inputs" ? "package.json" : "ordinary.txt"), '{}'); await delay(10);
        const candidate = await captureCandidate(a.baseline, work, path.join(a.directory, "candidate"), { sharedInputs: t.kind === "shared-inputs" }); active--;
        return { outcome: "submitted", candidate, usage: { tokens: 0, costUsd: 0, complete: true }, observedReads: [], workflowEvidence: [] };
      },
      async verify() { return { passed: true, gates: ["component pass"], review: "pass" }; },
      async verifyIntegration() { return { passed: true, gates: ["combined pass"], review: "pass" }; },
      async cleanup() {},
    });
    assert.equal(state.status, "staged"); assert.deepEqual(calls, ["inputs", "ordinary"]);
  } finally { await f.close(); }
});
