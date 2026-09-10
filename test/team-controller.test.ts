import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { createTeam, driveTeam, recoverTeam, type Worker } from "../src/team/controller.ts";
import { readState } from "../src/team/state.ts";
import { parseTeamPlan } from "../src/team/schema.ts";
import { captureCandidate, copySource } from "../src/workspace/candidate.ts";

const definition = { version: 1, roles: [{ id: "server", instructions: "Server", skills: [] }, { id: "client", instructions: "Client", skills: [] }], skills: [], contracts: {} };
const tasks = [
  { id: "ui", title: "UI", priority: "must" as const, status: "todo" as const, criteria: ["client uses server"], dependsOn: ["api"], assignedRole: "client", changeScope: ["ui.txt"] },
  { id: "api", title: "API", priority: "should" as const, status: "todo" as const, criteria: ["server works"], dependsOn: [], assignedRole: "server", changeScope: ["api.txt"] },
];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "team-controller-")); const project = path.join(root, "project"); await mkdir(project);
  await writeFile(path.join(project, "features.json"), JSON.stringify(tasks));
  await writeFile(path.join(project, "base.txt"), "original");
  const plan = parseTeamPlan(definition, tasks);
  const directory = await createTeam(project, plan, root, { maxAttempts: 2, maxDispatches: 10, maxMs: 100000, maxCostUsd: 5 });
  return { root, project, directory, close: () => rm(root, { recursive: true, force: true }) };
}
const usage = { tokens: 10, costUsd: 0.1, complete: true };
const successful: Worker = {
  async execute(attempt, task) {
    const source = path.join(attempt.directory, "worker"); await copySource(attempt.baseline.directory, source);
    if (task.id === "ui") assert.equal(await readFile(path.join(source, "api.txt"), "utf8"), "accepted api");
    await writeFile(path.join(source, `${task.id}.txt`), `accepted ${task.id}`);
    const candidate = await captureCandidate(attempt.baseline, source, path.join(attempt.directory, "candidate"));
    return { outcome: "submitted", candidate, usage, observedReads: [], workflowEvidence: [] };
  },
  async verify() { return { passed: true, gates: ["real adapter owns gates"], review: "pass" }; },
  async cleanup() {},
};

test("controller retries with distinct identities, stages prerequisite order, and never writes live features", async () => {
  const f = await fixture();
  try {
    const dispatched: string[] = [];
    const worker: Worker = { ...successful, async execute(attempt, task, role) {
      const persisted = await readState(f.directory);
      assert.equal(persisted.attempts.at(-1)?.id, attempt.id);
      assert.equal(role.id, task.id === "api" ? "server" : "client");
      dispatched.push(attempt.id);
      if (dispatched.length === 1) return { outcome: "failed", reason: "red test", usage };
      return { ...await successful.execute(attempt, task, role), attemptId: "forged-other-worker" };
    } };
    const state = await driveTeam(f.directory, worker);
    assert.equal(state.status, "staged"); assert.deepEqual(state.integrated, ["api", "ui"]);
    assert.equal(new Set(dispatched).size, 3); assert.equal(new Set(state.attempts.map(a => a.directory)).size, 3);
    assert.equal(new Set(state.attempts.map(a => a.containerName)).size, 3);
    assert.equal(state.attempts[0]?.status, "failed"); assert.equal(state.usage.tokens, 30);
    assert.equal(await readFile(path.join(f.project, "features.json"), "utf8"), JSON.stringify(tasks));
    await assert.rejects(readFile(path.join(f.project, "api.txt")), { code: "ENOENT" });
    assert.equal(await readFile(path.join(state.baseline.directory, "ui.txt"), "utf8"), "accepted ui");
  } finally { await f.close(); }
});

test("recovery kills owned unfinished resources and never assumes a submitted worker succeeded", async () => {
  const f = await fixture();
  try {
    let interrupted = false;
    const worker: Worker = { ...successful, async verify() { interrupted = true; throw new Error("controller terminated"); } };
    await assert.rejects(driveTeam(f.directory, worker), /controller terminated/u);
    assert.ok(interrupted);
    const before = await readState(f.directory); assert.equal(before.attempts[0]?.status, "submitted");
    const cleaned: string[] = [];
    const state = await recoverTeam(f.directory, { ...successful, async cleanup(a) { cleaned.push(a.id); } });
    assert.deepEqual(cleaned, [before.attempts[0]!.id]); assert.equal(state.attempts[0]!.status, "interrupted");
    assert.deepEqual(state.integrated, []); assert.equal(state.baseline.digest, state.original.digest); assert.equal(state.status, "stopped");
    const again = await recoverTeam(f.directory, successful); assert.equal(again.seq, state.seq);
  } finally { await f.close(); }
});

test("scope violations, failed review, and budgets stop dispatch without touching live source", async () => {
  for (const mode of ["scope", "review", "budget"] as const) {
    const f = await fixture();
    try {
      let count = 0;
      const worker: Worker = { ...successful,
        async execute(a, t, r) {
          count++;
          if (mode === "scope") {
            const source = path.join(a.directory, "worker"); await copySource(a.baseline.directory, source);
            await writeFile(path.join(source, "base.txt"), "out of scope");
            return { outcome: "submitted", candidate: await captureCandidate(a.baseline, source, path.join(a.directory, "candidate")), usage, observedReads: [], workflowEvidence: [] };
          }
          const result = await successful.execute(a, t, r);
          return { ...result, usage: mode === "budget" ? { ...usage, costUsd: 6 } : usage };
        },
        async verify() { return mode === "review" ? { passed: false, gates: ["tests pass"], review: "escalate", reason: "Missing behavior" } : Promise.resolve({ passed: true, gates: ["tests pass"], review: "pass" }); },
      };
      const state = await driveTeam(f.directory, worker);
      assert.equal(state.status, "stopped"); assert.equal(count, mode === "budget" ? 1 : 2);
      assert.equal(await readFile(path.join(f.project, "base.txt"), "utf8"), "original");
      if (mode !== "budget") assert.deepEqual(state.integrated, []);
      else assert.match(state.reason ?? "", /cost/u);
    } finally { await f.close(); }
  }
});

test("blocked verification does not retry, and a dedicated input change revalidates accepted consumers", async () => {
  const f = await fixture();
  try {
    const blocked = await driveTeam(f.directory, { ...successful, async verify() { return { passed: false, gates: ["environment-blocked"], review: "not-run", blocked: true, reason: "missing artifact" }; } });
    assert.equal(blocked.attempts.length, 1); assert.equal(blocked.attempts[0]!.status, "blocked");
  } finally { await f.close(); }
  const root = await mkdtemp(path.join(os.tmpdir(), "team-input-change-"));
  const project = path.join(root, "project"); await mkdir(project);
  try {
    await writeFile(path.join(project, "package.json"), '{"name":"before"}');
    const tasks = [
      { id: "consumer", title: "Consumer", priority: "must" as const, status: "done" as const, criteria: ["works"], dependsOn: [] },
      { id: "inputs", title: "Inputs", priority: "must" as const, status: "todo" as const, criteria: ["works"], dependsOn: [], kind: "shared-inputs" as const },
    ];
    const plan = parseTeamPlan({ version: 1, roles: [{ id: "builder", instructions: "build", skills: [] }], skills: [], contracts: {} }, tasks);
    const directory = await createTeam(project, plan, root, { maxAttempts: 2, maxDispatches: 10, maxMs: 60000, maxCostUsd: 10 });
    const seen: string[] = [];
    const state = await driveTeam(directory, { ...successful, async execute(a, t) {
      seen.push(t.id); const source = path.join(a.directory, "worker"); await copySource(a.baseline.directory, source);
      if (t.id === "inputs") await writeFile(path.join(source, "package.json"), '{"name":"after"}');
      return { outcome: "submitted", candidate: await captureCandidate(a.baseline, source, path.join(a.directory, "candidate"), { sharedInputs: t.kind === "shared-inputs" }), usage, observedReads: [], workflowEvidence: [] };
    } });
    assert.deepEqual(seen, ["inputs", "consumer"]); assert.equal(state.status, "staged");
    assert.equal(await readFile(path.join(project, "package.json"), "utf8"), '{"name":"before"}');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("finishing at the dispatch ceiling is staged, and recovery verifies retained source", async () => {
  const f = await fixture();
  try {
    const { createState } = await import("../src/team/state.ts");
    const { captureBaseline } = await import("../src/workspace/candidate.ts");
    const directory = path.join(f.root, "exact-limit");
    const baseline = await captureBaseline(f.project, path.join(f.root, "exact-baseline"));
    // A plan without skills needs only its empty input manifest.
    await mkdir(path.join(directory, "inputs"), { recursive: true }); await writeFile(path.join(directory, "inputs/skills.json"), "[]");
    await createState(directory, parseTeamPlan(definition, tasks), baseline, { maxAttempts: 1, maxDispatches: 2, maxMs: 100000, maxCostUsd: 10 });
    const state = await driveTeam(directory, successful); assert.equal(state.status, "staged");
    await writeFile(path.join(state.baseline.directory, "ui.txt"), "corrupted staging");
    await assert.rejects(recoverTeam(directory, successful), /Frozen source changed/u);
  } finally { await f.close(); }
});
