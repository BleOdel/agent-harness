import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { freezeChecks, readChecks, resolveTeamModel } from "../src/team/checks.ts";
import { parseTeamPlan } from "../src/team/schema.ts";

test("gate commands and declared checks are frozen outside source; tampering is refused", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "team-checks-"));
  try {
    const project = path.join(root, "project"), inputs = path.join(root, "profile"), run = path.join(root, "run");
    await mkdir(project); await mkdir(path.join(inputs, "checks"), { recursive: true });
    await writeFile(path.join(project, "package.json"), JSON.stringify({ scripts: { test: "node --test test/*.test.js", typecheck: "tsc" } }));
    await writeFile(path.join(inputs, "checks/system.mjs"), "import assert from 'node:assert/strict'; assert.ok(true);");
    await writeFile(path.join(inputs, "checks/secret.txt"), "undeclared");
    const plan = parseTeamPlan({ version: 1, roles: [{ id: "b", instructions: "build", skills: [] }], skills: [], checks: [{ id: "system", path: "checks", files: ["system.mjs"], command: ["node", "/harness-checks/system.mjs"], after: ["a"] }] }, [{ id: "a", title: "a", criteria: ["works"], priority: "must", status: "todo", dependsOn: [] }]);
    const frozen = await freezeChecks(project, inputs, run, plan, ["npm", "test"]);
    await writeFile(path.join(project, "package.json"), '{"scripts":{"test":"true"}}');
    await writeFile(path.join(inputs, "checks/system.mjs"), "weakened");
    assert.deepEqual((await readChecks(run, frozen.digest)).scripts, { test: "node --test test/*.test.js", typecheck: "tsc" });
    await assert.rejects(readFile(path.join(run, "inputs/checks/system/source/secret.txt")), { code: "ENOENT" });
    await writeFile(path.join(run, "inputs/checks/system/source/system.mjs"), "tampered");
    await assert.rejects(readChecks(run, frozen.digest), /changed/u);
    assert.throws(() => parseTeamPlan({ ...plan, checks: [{ ...plan.checks![0], after: ["missing"] }] }, plan.tasks), /check/u);
    assert.throws(() => parseTeamPlan({ ...plan, checks: [{ ...plan.checks![0], files: ["../auth.json"] }] }, plan.tasks), /check/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("only provider and model defaults are read from host Pi settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "team-model-"));
  try {
    await writeFile(path.join(root, "settings.json"), JSON.stringify({ defaultProvider: "p", defaultModel: "m", packages: ["unsafe"] }));
    assert.deepEqual(await resolveTeamModel({ agentDirectory: root, provider: undefined, model: undefined }), { provider: "p", model: "m" });
    assert.deepEqual(await resolveTeamModel({ agentDirectory: root, provider: "explicit", model: "override" }), { provider: "explicit", model: "override" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("check IDs cannot collide with another check's snapshot or manifest paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "check-names-"));
  try {
    await mkdir(path.join(root, "project")); await mkdir(path.join(root, "checks"));
    await writeFile(path.join(root, "checks/system.mjs"), "original");
    const plan = parseTeamPlan({ version: 1, roles: [{ id: "b", instructions: "build", skills: [] }], skills: [], checks: ["system", "system-frozen"].map(id => ({ id, path: "checks", files: ["system.mjs"], command: ["node", "/harness-checks/system.mjs"] })) }, []);
    const frozen = await freezeChecks(path.join(root, "project"), root, path.join(root, "run"), plan, ["npm", "test"]);
    assert.equal((await readChecks(path.join(root, "run"), frozen.digest)).checks.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
