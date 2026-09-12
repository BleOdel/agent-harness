/** Real CLI, Docker and RPC fixture: no model-provider calls. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../src/config.ts";
import { run } from "../src/run.ts";
import { writeRpcFixture } from "./rpc-fixture.ts";
import { approveChecks } from "../src/acceptance/checks.ts";
import { readState } from "../src/team/state.ts";
import { readRecord } from "../src/record/record.ts";
import { profilePath } from "../src/project/profile.ts";
import { createPlan, approvePlan, atomicWrite } from "../src/planning/store.ts";
import { runPlanAttempt } from "../src/verbs/plan.ts";
const configured = !!process.env.HARNESS_IMAGE_ID && !!process.env.HARNESS_DOCKER;
test("Docker: Node team uses the adapter; resume drift stops before dispatch; application records matching identities", { skip: configured ? false : "configure Docker for adapter workflow" }, async () => {
 const config = loadConfig(), root = await realpath(await mkdtemp(path.join(os.tmpdir(), "adapter-process-")));
 const project = path.join(root, "project"), pi = path.join(root, "pi"), agent = path.join(root, "agent");
 for (const directory of [path.join(project, "test"), path.join(pi, "dist"), agent]) await mkdir(directory, { recursive: true });
 await writeFile(path.join(project, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test test/*.test.mjs" } }));
 await writeFile(path.join(project, "test/works.test.mjs"), "import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; assert.equal(readFileSync('result.txt','utf8'),'verified');");
 await writeFile(path.join(project, "features.json"), JSON.stringify([{ id: "one", title: "Write verified output", priority: "must", status: "todo", criteria: ["Output is verified"], dependsOn: [] }]));
 const team = path.join(root, "team.json"); await writeFile(team, JSON.stringify({ version: 1, roles: [{ id: "builder", instructions: "Build the requested output", skills: [] }], skills: [] }));
 await writeRpcFixture(pi, `const fs=require('node:fs'); if(process.argv.includes('read,grep'))console.log(JSON.stringify({verdict:'pass',unmet:[],unaccounted:[],notes:[]})); else {fs.writeFileSync('result.txt','verified');fs.writeFileSync('.harness-claim.json',JSON.stringify({files:['result.txt'],deletions:[],criteria:[{criterion:'Output is verified',verifiedBy:'test/works.test.mjs'}]}));}`);
 const expected = path.join(root, "checks.json"); await writeFile(expected, JSON.stringify({ version: 1, cases: [{ id: "output", tasks: ["one"], steps: [{ command: ["node", "-e", "console.log(require('node:fs').readFileSync('result.txt','utf8'))"], exitCode: 0, stdout: "verified\n" }] }] })); await approveChecks(project, expected);
 const file = path.join(root, "config"); await writeFile(file, "# deterministic fixture\n");
 const env = { ...process.env, HARNESS_CONFIG: file, HARNESS_PROJECT: project, HARNESS_DOCKER: config.dockerExecutable, HARNESS_IMAGE_ID: config.imageId, HARNESS_PI_PACKAGE: pi, HARNESS_AGENT_DIR: agent, HARNESS_SKILLS: "", HARNESS_PROVIDER: "fixture", HARNESS_MODEL: "fixture", HARNESS_TEST_COMMAND: "npm test" };
 const call = (args: string[], changed: NodeJS.ProcessEnv = {}) => run(process.execPath, [path.resolve("src/cli.ts"), ...args], { timeoutMs: 60000, env: { ...env, ...changed } });
 try {
  const staged = await call(["team", "run", "--profile", team, "--max-attempts", "1"]); assert.equal(staged.code, 0, staged.stdout + staged.stderr);
  const id = /^team: (team-[a-f0-9-]+)/mu.exec(staged.stdout)?.[1]; assert.ok(id);
  const directory = path.join(`${project}-harness/teams`, id); let state = await readState(directory);
  assert.equal(state.version, 4); assert.equal(state.status, "staged"); assert.ok(state.execution);
  const identity = state.execution.digest;
  assert.equal(state.baseline.executionDigest, identity); assert.equal(state.attempts[0]?.candidate?.executionDigest, identity); assert.equal(state.attempts[0]?.integration?.executionDigest, identity);
  assert.ok(state.attempts[0]?.environmentKey); assert.ok(state.attempts[0]?.integration?.environmentKey);
  const seq = state.seq;
  const refused = await call(["team", "resume", id], { HARNESS_IMAGE_ID: `sha256:${"b".repeat(64)}` }); assert.notEqual(refused.code, 0); assert.match(refused.stderr, /Execution settings changed/); assert.equal((await readState(directory)).seq, seq);
  const resumed = await call(["team", "resume", id]); assert.equal(resumed.code, 0, resumed.stderr); assert.equal((await readState(directory)).attempts.length, 1);
  const applied = await call(["team", "apply", id]); assert.equal(applied.code, 0, applied.stderr); assert.equal(await readFile(path.join(project, "result.txt"), "utf8"), "verified");
  const record = (await readRecord(project)).runs[0]!; assert.equal(record.execution?.digest, identity); assert.equal(record.acceptance?.executionDigest, identity);
  const evidence = JSON.parse(await readFile(record.acceptance!.evidencePath, "utf8")); assert.equal(evidence.execution.digest, identity); assert.equal(evidence.adapter.id, "node-npm"); assert.equal(evidence.observations[0].runner.image, config.imageId);
  assert.ok(await readFile(profilePath(project)));
  await writeFile(path.join(agent, "auth.json"), "{}");
  const doctor = await call(["doctor", "--json"], { HARNESS_TEST_COMMAND: "" }); assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr); const report = JSON.parse(doctor.stdout); assert.equal(report.version, 2); assert.equal(report.capabilities.version, 1); assert.equal(report.capabilities.network.verification, "none");
  const unsupported = JSON.parse(await readFile(profilePath(project), "utf8")); unsupported.requirements.gpu = true; await writeFile(profilePath(project), JSON.stringify(unsupported));
  const blocked = await call(["work", "one"]); assert.notEqual(blocked.code, 0); assert.match(blocked.stderr, /Unavailable capability gpu/); assert.equal((await readRecord(project)).runs.filter(r => r.outcome === "applied").length, 1);
 } finally { await rm(root, { recursive: true, force: true }); }
});

test("Docker: planning resume refuses a changed image before launching another session", { skip: configured ? false : "configure Docker for planning environment drift" }, async () => {
 const config = loadConfig(), root = await realpath(await mkdtemp(path.join(os.tmpdir(), "plan-adapter-"))), project = path.join(root, "project"), pi = path.join(root, "pi"), agent = path.join(root, "agent");
 for (const directory of [project, path.join(pi, "dist"), agent]) await mkdir(directory, { recursive: true });
 await writeFile(path.join(pi, "dist/cli.js"), "process.exit(7)");
 let saved = await createPlan(project, "Blog"); await atomicWrite(path.join(saved.work, "PLAN.md"), "# Approved blog"); saved = await approvePlan(saved);
 const local = { ...config, piPackageDirectory: pi, agentDirectory: agent, skillsDirectory: undefined };
 try {
  await assert.rejects(runPlanAttempt(saved, local), /code 7/);
  const before = await readFile(path.join(saved.directory, "execution.json"));
  await assert.rejects(runPlanAttempt(saved, { ...local, imageId: `sha256:${"b".repeat(64)}` }), /Execution settings changed/);
  assert.deepEqual(await readFile(path.join(saved.directory, "execution.json")), before);
 } finally { await rm(root, { recursive: true, force: true }); }
});
