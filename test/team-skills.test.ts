import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { snapshotSkills, privateAgentDirectory } from "../src/team/inputs.ts";
import { parseTeamPlan, resolveSkills } from "../src/team/schema.ts";
import { EventStream } from "../src/agent/events.ts";

test("role bundle freezes selected definitions and resources only; incompatible manifests stop", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-skills-"));
  try {
    await mkdir(path.join(root, "tdd"));
    await writeFile(path.join(root, "tdd/SKILL.md"), "---\nname: tdd\ndescription: Test behavior\n---\nRead CHECK.md\n");
    await writeFile(path.join(root, "tdd/CHECK.md"), "Accepted test interface");
    await writeFile(path.join(root, "tdd/secret"), "not selected");
    const raw = { version: 1, roles: [{ id: "builder", instructions: "Build", skills: ["tdd"] }], skills: [{ id: "tdd", path: "tdd", interaction: "unattended", resources: ["CHECK.md"], requires: ["read"], dependencies: [] }], contracts: {} };
    const plan = parseTeamPlan(raw, []);
    const bundle = await snapshotSkills(root, path.join(root, "bundle"), resolveSkills(plan, plan.roles[0]!));
    assert.equal(bundle.length, 1); assert.equal(Object.keys(bundle[0]!.files).length, 2);
    assert.deepEqual((await readdir(path.join(root, "bundle/tdd"))).sort(), ["CHECK.md", "SKILL.md"]);
    await writeFile(path.join(root, "tdd/CHECK.md"), "Changed");
    assert.equal(await readFile(path.join(root, "bundle/tdd/CHECK.md"), "utf8"), "Accepted test interface");
    const changed = await snapshotSkills(root, path.join(root, "changed"), resolveSkills(plan, plan.roles[0]!));
    assert.notEqual(changed[0]!.digest, bundle[0]!.digest);
    for (const update of [{ interaction: "interactive" }, { requires: ["Skill"] }, { dependencies: ["code-review"] }, { dependencies: ["tdd"] }]) assert.throws(() => parseTeamPlan({ ...raw, skills: [{ ...raw.skills[0], ...update }] }, []));
    await rm(path.join(root, "tdd/CHECK.md"));
    await assert.rejects(snapshotSkills(root, path.join(root, "missing"), resolveSkills(plan, plan.roles[0]!)), /ENOENT/u);
    await symlink(path.join(root, "tdd/secret"), path.join(root, "tdd/CHECK.md"));
    await assert.rejects(snapshotSkills(root, path.join(root, "linked"), resolveSkills(plan, plan.roles[0]!)), /regular|symlink/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("attempt auth and sessions are private copies; observations distinguish successful skill reads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-auth-"));
  try {
    const source = path.join(root, "source"); await mkdir(source);
    await writeFile(path.join(source, "auth.json"), '{"fixture":"private"}');
    await writeFile(path.join(source, "settings.json"), '{"extensions":["untrusted"],"skills":["extra"]}');
    const a = await privateAgentDirectory(source, path.join(root, "a"));
    const b = await privateAgentDirectory(source, path.join(root, "b"));
    await writeFile(path.join(a, "auth.json"), "changed by attempt");
    assert.equal(await readFile(path.join(b, "auth.json"), "utf8"), '{"fixture":"private"}');
    await assert.rejects(readFile(path.join(a, "settings.json")), { code: "ENOENT" });
    assert.notEqual(a, b);
    const stream = new EventStream();
    stream.push(JSON.stringify({type:"tool_execution_start",toolCallId:"1",toolName:"read",args:{path:"/opt/skills/tdd/SKILL.md"}})+"\n");
    assert.deepEqual(stream.skillReads(), []);
    stream.push(JSON.stringify({type:"tool_execution_end",toolCallId:"1",toolName:"read",isError:false})+"\n");
    assert.deepEqual(stream.skillReads(), ["tdd/SKILL.md"]);
    stream.push(JSON.stringify({type:"tool_execution_start",toolCallId:"2",toolName:"read",args:{path:"/opt/skills/tdd/CHECK.md"}})+"\n");
    stream.push(JSON.stringify({type:"tool_execution_end",toolCallId:"2",isError:true})+"\n");
    assert.deepEqual(stream.skillReads(), ["tdd/SKILL.md"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("provider errors in a zero-exit event stream remain failures", () => {
  const stream = new EventStream();
  stream.push(JSON.stringify({ type: "turn_end", message: { stopReason: "error", errorMessage: "No API key for provider: fixture" } }) + "\n");
  assert.match(stream.failure() ?? "", /No API key/u);
});
