import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createState, appendEvent, readState } from "../src/team/state.ts";
import { parseTeamPlan } from "../src/team/schema.ts";
import { schedule } from "../src/team/scheduler.ts";

export const plan = () => parseTeamPlan({ version: 1, roles: [{ id: "api", instructions: "Build the accepted API", skills: [] }, { id: "ui", instructions: "Build the accepted UI", skills: [] }], skills: [], contracts: {} }, [
  { id: "client", title: "client", priority: "must", status: "todo", criteria: ["works"], dependsOn: ["server"], assignedRole: "ui", changeScope: ["client/**"] },
  { id: "server", title: "server", priority: "should", status: "todo", criteria: ["works"], dependsOn: [], assignedRole: "api", changeScope: ["server/**"] },
]);
const baseline = { directory: "/host/baseline", digest: "a".repeat(64), files: {} };

test("durable decisions replay without a snapshot; duplicates cannot advance state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "team-state-"));
  try {
    let state = await createState(root, plan(), baseline, { maxAttempts: 2, maxDispatches: 10, maxMs: 100000, maxCostUsd: 10 });
    const decision = schedule(state)!;
    assert.equal(decision.task.id, "server"); assert.equal(decision.role.id, "api");
    state = await appendEvent(root, { type: "dispatched", attempt: { id: "a-one", taskId: "server", roleId: "api", containerName: "harness-a-one", baseline, directory: path.join(root, "a-one"), skills: [], contracts: {}, instructionsDigest: "b".repeat(64) } });
    assert.equal(schedule(state), undefined);
    state = await appendEvent(root, { type: "submitted", attemptId: "a-one", candidate: baseline, usage: { tokens: 10, costUsd: 0.1, complete: false }, observedReads: [], workflowEvidence: [] });
    const seq = state.seq;
    state = await appendEvent(root, { type: "submitted", attemptId: "a-one", candidate: baseline, usage: { tokens: 10, costUsd: 0.1, complete: false }, observedReads: [], workflowEvidence: [] });
    assert.equal(state.seq, seq); assert.equal(state.usage.tokens, 10);
    await assert.rejects(appendEvent(root, { type: "integrated", attemptId: "a-one", baseline }), /verified/u);
    await appendEvent(root, { type: "verified", attemptId: "a-one", gates: ["tests passed"], review: "pass" });
    await assert.rejects(appendEvent(root, { type: "integrated", attemptId: "a-one", baseline }), /verified integration/u);
    await assert.rejects(appendEvent(root, { type: "integration-verified", attemptId: "a-one", fromDigest: "c".repeat(64), candidateDigest: baseline.digest, proposal: baseline, gates: ["combined passes"] }), /current staging/u);
    await assert.rejects(appendEvent(root, { type: "integration-verified", attemptId: "a-one", fromDigest: baseline.digest, candidateDigest: "c".repeat(64), proposal: baseline, gates: ["combined passes"] }), /verified candidate/u);
    await appendEvent(root, { type: "integration-verified", attemptId: "a-one", fromDigest: baseline.digest, candidateDigest: baseline.digest, proposal: baseline, gates: ["combined passes"] });
    await assert.rejects(appendEvent(root, { type: "integrated", attemptId: "a-one", baseline: { ...baseline, digest: "c".repeat(64) } }), /verified integration/u);
    state = await appendEvent(root, { type: "integrated", attemptId: "a-one", baseline });
    assert.equal(schedule(state)?.task.id, "client");
    await writeFile(path.join(root, "state.json"), "broken projection");
    const recovered = await readState(root);
    assert.deepEqual(recovered, state);
    const files = await readdir(path.join(root, "events"));
    assert.equal(files.filter(f => f.endsWith(".json")).length, state.seq);
    assert.equal(JSON.parse(await readFile(path.join(root, "state.json"), "utf8")).seq, state.seq);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("role assignments, capabilities, scopes and dependency cycles fail closed", () => {
  assert.throws(() => parseTeamPlan({ version: 2 }, []), /version/u);
  const p = plan();
  assert.throws(() => parseTeamPlan({ ...p, roles: [] }, p.tasks), /role/u);
  assert.throws(() => parseTeamPlan(p, [{ ...p.tasks[0]!, assignedRole: "missing" }, p.tasks[1]!]), /role/u);
  assert.throws(() => parseTeamPlan(p, [{ ...p.tasks[0]!, changeScope: ["../secret"] }, p.tasks[1]!]), /scope/u);
  assert.throws(() => parseTeamPlan(p, [{ ...p.tasks[0]!, dependsOn: ["server"] }, { ...p.tasks[1]!, dependsOn: ["client"] }]), /cycle/u);
});

test("feature import preserves accepted role, scope and contract references", async () => {
  const { parseProposedItems } = await import("../src/features.ts");
  const imported = parseProposedItems(JSON.stringify(plan().tasks)); assert.ok(imported.ok);
  assert.equal(imported.features[0]!.assignedRole, "ui");
  assert.deepEqual(imported.features[0]!.changeScope, ["client/**"]);
});

test("journal corruption is refused; scheduling limits are explicit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "team-journal-"));
  try {
    const { budgetReason } = await import("../src/team/scheduler.ts");
    const state = await createState(root, plan(), baseline, { maxAttempts: 1, maxDispatches: 1, maxMs: 100, maxCostUsd: 1 });
    assert.match(budgetReason(state, Date.parse(state.startedAt) + 100) ?? "", /wall-clock/u);
    assert.match(budgetReason({ ...state, policy: { ...state.policy, maxDispatches: 0 } }, Date.parse(state.startedAt)) ?? "", /Dispatch/u);
    assert.match(budgetReason({ ...state, usage: { tokens: 1, costUsd: 1, complete: false } }, Date.parse(state.startedAt)) ?? "", /cost/u);
    await writeFile(path.join(root, "events/00000003.json"), "{}");
    await assert.rejects(readState(root), /gap/u);
    await rm(path.join(root, "events/00000003.json"));
    await writeFile(path.join(root, "events/00000002.json"), '{"version":99,"seq":2}');
    await assert.rejects(readState(root), /Unsupported/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("journal transitions cannot skip prerequisites or declare unstaged work complete", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "team-transitions-"));
  try {
    await createState(root, plan(), baseline, { maxAttempts: 2, maxDispatches: 10, maxMs: 100000, maxCostUsd: 10 });
    await assert.rejects(appendEvent(root, { type: "staged" }), /integrated/u);
    await assert.rejects(appendEvent(root, { type: "dispatched", attempt: { id: "a-client", taskId: "client", roleId: "ui", containerName: "harness-a-client", directory: path.join(root, "client"), baseline, skills: [], contracts: {}, instructionsDigest: "b".repeat(64) } }), /eligible/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("version 1 journals remain readable without silently adopting parallel integration semantics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "team-v1-"));
  try {
    await createState(root, plan(), baseline, { maxAttempts: 1, maxDispatches: 2, maxMs: 60000, maxCostUsd: 1 });
    const file = path.join(root, "events/00000001.json");
    const event = JSON.parse(await readFile(file, "utf8")); event.version = 1; await writeFile(file, JSON.stringify(event));
    const state = await readState(root); assert.equal(state.version, 1); assert.equal(schedule(state)?.task.id, "server");
    const { driveTeam } = await import("../src/team/controller.ts");
    await assert.rejects(driveTeam(root, { async execute() { throw Error("must not launch"); }, async verify() { throw Error("must not verify"); }, async verifyIntegration() { throw Error("must not integrate"); }, async cleanup() {} }), /Version 1 runs/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
