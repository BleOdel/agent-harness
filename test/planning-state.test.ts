import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPlan, resolvePlan, approvePlan, finishItems, readArtifact, acceptedProposal } from "../src/planning/store.ts";
import { add } from "../src/verbs/add.ts";

const proposal = JSON.stringify([{ id: "foundation", title: "Foundation", priority: "must", kind: "shared-inputs", criteria: ["Build passes"], dependsOn: [] }]);
async function fixture(action: (project: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "plan-state-"));
  const project = path.join(root, "project"); await mkdir(project);
  await writeFile(path.join(project, "package.json"), "{}");
  try { await action(project); } finally { await rm(root, { recursive: true, force: true }); }
}

test("a plan retains its transcript and draft across reopening; only approved items import with context", () => fixture(async project => {
  const first = await createPlan(project, "A blog");
  await writeFile(path.join(first.work, "session.jsonl"), '{"message":"Use Markdown"}\n');
  await writeFile(path.join(first.work, "PLAN.md"), "# Blog\nUse Markdown and no browser JS.\n");
  const reopened = await resolvePlan(project, "latest");
  assert.equal(reopened.state.id, first.state.id);
  assert.match((await readArtifact(reopened.work, "session.jsonl"))!, /Markdown/);
  await assert.rejects(() => acceptedProposal(reopened), /approve|ready/);
  const approved = await approvePlan(reopened);
  await writeFile(path.join(approved.work, "items.json"), proposal);
  const ready = await finishItems(approved);
  const accepted = await acceptedProposal(ready);
  assert.equal(accepted.features[0]?.kind, "shared-inputs");
  assert.match(accepted.features[0]?.planContext ?? "", /no browser JS/);
  await add(project, ["--from", "latest"]);
  const features = JSON.parse(await readFile(path.join(project, "features.json"), "utf8"));
  assert.match(features[0].planContext, /no browser JS/);
  assert.equal(features[0].status, "todo");
}));

test("malformed or stale items cannot advance planning or import", () => fixture(async project => {
  let plan = await createPlan(project, "Blog");
  await writeFile(path.join(plan.work, "PLAN.md"), "Approved scope");
  plan = await approvePlan(plan);
  await writeFile(path.join(plan.work, "items.json"), "not JSON");
  await assert.rejects(() => finishItems(plan), /JSON/);
  await writeFile(path.join(plan.work, "items.json"), proposal);
  await writeFile(path.join(plan.work, "PLAN.md"), "Changed by generator");
  await assert.rejects(() => finishItems(plan), /changed/);
  await writeFile(path.join(plan.work, "PLAN.md"), "Approved scope");
  plan = await finishItems(plan);
  await writeFile(path.join(plan.directory, "items.json"), "[]");
  await assert.rejects(() => acceptedProposal(plan), /changed/);
}));

test("latest never silently imports an older plan when a newer interview is unfinished", () => fixture(async project => {
  let old = await createPlan(project, "First");
  await writeFile(path.join(old.work, "PLAN.md"), "First plan");
  old = await approvePlan(old); await writeFile(path.join(old.work, "items.json"), proposal); await finishItems(old);
  await new Promise(resolve => setTimeout(resolve, 5));
  await createPlan(project, "Second");
  await assert.rejects(() => add(project, ["--from", "latest"]), /approve|ready/);
}));

test("artifact readers refuse symlinks and plan selectors refuse traversal", () => fixture(async project => {
  const plan = await createPlan(project, "Blog");
  await symlink(path.join(project, "package.json"), path.join(plan.work, "PLAN.md"));
  await assert.rejects(() => approvePlan(plan), /regular|symbolic|ELOOP/);
  await assert.rejects(() => resolvePlan(project, "../project"), /Invalid/);
}));
