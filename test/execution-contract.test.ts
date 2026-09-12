import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { freezeSelectedSkills, assertSkillBundles } from "../src/project/skills.ts";
import { setupProject } from "../src/verbs/project.ts";
import { defaultProfile, savedProfile } from "../src/project/profile.ts";
import { assertExecutionCompatible, assertExecutionPin, executionSettings, type ExecutionPin } from "../src/project/execution.ts";
import { createState, appendEvent, readState } from "../src/team/state.ts";
import { parseTeamPlan, digest } from "../src/team/schema.ts";
import { captureBaseline, captureCandidate, copySource } from "../src/workspace/candidate.ts";
import { dockerRunner } from "../src/runners/docker.ts";
import type { Config } from "../src/config.ts";

async function fixture(action: (root: string, project: string) => Promise<void>) {
 const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "execution-contract-"))), project = path.join(root, "project"); await mkdir(project);
 try { await action(root, project); } finally { await rm(root, { recursive: true, force: true }); }
}
const config: Config = { dockerExecutable: "/docker", imageId: `sha256:${"a".repeat(64)}`, piPackageDirectory: "/pi", agentDirectory: "/agent", skillsDirectory: undefined, provider: undefined, model: undefined, agentTimeoutMs: 100, gateTimeoutMs: 100 };
function pin(): ExecutionPin {
 const content = { version: 1 as const, settings: executionSettings(defaultProfile(), config, ["npm", "test"]), skills: [], capabilities: { version: 1 as const, runner: { id: "docker", version: 1 }, image: config.imageId, os: "linux", arch: "arm64", toolchains: { node: "v26.5.0", npm: "11.5.0" }, cpu: 2, memoryMiB: 2048, gui: false, emulator: false, gpu: false, network: { agent: "bridge", preparation: "bridge", verification: "none" } } };
 return { ...content, digest: digest(content) };
}
test("selected skills freeze resources; changing source does not change accepted instructions", () => fixture(async (root) => {
 const source = path.join(root, "available"), frozen = path.join(root, "frozen");
 for (const id of ["tdd", "grill-me"]) { await mkdir(path.join(source, id), { recursive: true }); await writeFile(path.join(source, id, "SKILL.md"), `---\nname: ${id}\ndescription: Test\n---\nRead workflow.txt.`, { flag: "wx" }); await writeFile(path.join(source, id, "workflow.txt"), "original"); }
 const bundles = await freezeSelectedSkills(source, frozen, ["tdd"]);
 assert.deepEqual(bundles.map(b => b.id), ["tdd"]); assert.ok(bundles[0]?.files["workflow.txt"]);
 await writeFile(path.join(source, "tdd/workflow.txt"), "changed upstream");
 await assertSkillBundles(frozen, bundles); assert.equal(await readFile(path.join(frozen, "tdd/workflow.txt"), "utf8"), "original");
 await assert.rejects(readFile(path.join(frozen, "grill-me/SKILL.md")), { code: "ENOENT" });
 await chmod(path.join(frozen, "tdd/workflow.txt"), 0o600); await writeFile(path.join(frozen, "tdd/workflow.txt"), "changed frozen");
 await assert.rejects(assertSkillBundles(frozen, bundles), /changed/);
}));
test("guided mixed-project selection is reviewable and cancellation does not save a choice", () => fixture(async (_root, project) => {
 await writeFile(path.join(project, "package.json"), "{}"); await writeFile(path.join(project, "pyproject.toml"), "[project]");
 const lines: string[] = []; let accept = false;
 const io = { write: (line: string) => { lines.push(line); }, ask: async (question: string) => { lines.push(question); return question.startsWith("Choose") ? "1" : question.startsWith("Save") ? (accept ? "y" : "n") : "none"; } };
 await setupProject(project, io); assert.equal(await savedProfile(project), undefined);
 accept = true; await setupProject(project, io); assert.equal((await savedProfile(project))?.adapter.id, "node-npm");
 assert.match(lines.join("\n"), /Multiple project types/); assert.match(lines.join("\n"), /Verification is offline/);
}));
test("versioned journal refuses candidate/verification drift and retains integration identity", () => fixture(async (root, project) => {
 await writeFile(path.join(project, "package.json"), "{}");
 const execution = pin();
 const inconsistent = { ...execution, capabilities: { ...execution.capabilities, image: "another-image" } };
 const { digest: _previousDigest, ...identity } = inconsistent;
 inconsistent.digest = digest(identity);
 assert.throws(() => assertExecutionPin(inconsistent), /does not match the accepted image/);
 const source = await captureBaseline(project, path.join(root, "baseline"), [], execution.digest);
 const plan = parseTeamPlan({ version: 1, roles: [{ id: "builder", instructions: "Build", skills: [] }], skills: [] }, [{ id: "one", title: "One", priority: "must", status: "todo", criteria: ["Works"], dependsOn: [] }]);
 const directory = path.join(root, "team");
 await createState(directory, plan, source, { maxAttempts: 1, maxDispatches: 1, maxMs: 60000, maxCostUsd: 1 }, "team-one", undefined, execution);
 const attempt = { id: "attempt-one", taskId: "one", roleId: "builder", containerName: "harness-one", directory: path.join(directory, "attempt"), baseline: source, skills: [], contracts: {}, instructionsDigest: digest(plan.roles[0]) };
 await assert.rejects(appendEvent(directory, { type: "dispatched", attempt }), /execution identity/);
 await appendEvent(directory, { type: "dispatched", attempt: { ...attempt, executionDigest: execution.digest } });
 const submission = { type: "submitted" as const, attemptId: attempt.id, candidate: { ...source, executionDigest: "wrong" }, usage: { tokens: 0, costUsd: 0, complete: true }, observedReads: [], workflowEvidence: [] };
 await assert.rejects(appendEvent(directory, submission), /execution identity/);
 await appendEvent(directory, { ...submission, candidate: source });
 const verification = { type: "verified" as const, attemptId: attempt.id, gates: ["pass"], review: "pass" as const, environmentKey: "environment" };
 await assert.rejects(appendEvent(directory, verification), /execution evidence/);
 await appendEvent(directory, { ...verification, executionDigest: execution.digest });
 const integration = { type: "integration-verified" as const, attemptId: attempt.id, fromDigest: source.digest, candidateDigest: source.digest, proposal: source, gates: ["pass"], environmentKey: "integration-env" };
 await assert.rejects(appendEvent(directory, integration), /execution evidence/);
 await appendEvent(directory, { ...integration, executionDigest: execution.digest });
 await assert.rejects(appendEvent(directory, { type: "integrated", attemptId: attempt.id, baseline: { ...source, executionDigest: "wrong" } }), /execution identity/);
 const state = await readState(directory); assert.equal(state.version, 4); assert.equal(state.attempts[0]?.integration?.executionDigest, execution.digest); assert.equal(state.attempts[0]?.integration?.environmentKey, "integration-env");
 await assert.rejects(assertExecutionCompatible(execution, project, { ...config, imageId: `sha256:${"b".repeat(64)}` }, ["npm", "test"]), /Execution settings changed/);
}));
test("adapter source exclusions and shared inputs survive candidate capture", () => fixture(async (root, project) => {
 await writeFile(path.join(project, "input.txt"), "old"); await mkdir(path.join(project, "generated")); await writeFile(path.join(project, "generated/output"), "not source");
 const source = await captureBaseline(project, path.join(root, "base"), ["generated"], "execution");
 assert.equal(source.files["generated/output"], undefined);
 const worker = path.join(root, "worker"); await copySource(source.directory, worker); await writeFile(path.join(worker, "input.txt"), "new");
 await assert.rejects(captureCandidate(source, worker, path.join(root, "rejected"), { sharedInputFiles: ["input.txt"] }), /shared-inputs/);
 const accepted = await captureCandidate(source, worker, path.join(root, "accepted"), { sharedInputFiles: ["input.txt"], sharedInputs: true });
 assert.equal(accepted.executionDigest, "execution"); assert.equal(accepted.sharedInputsChanged, true);
}));
test("runner inspection reports actual available resources and refuses another image", async () => {
 const layout = { ...config, skillsDirectory: "/skills", containerName: "harness-fixture", workDirectory: "/work", user: "1000:1000" };
 const probe = async (_command: string, args: readonly string[]) => ({ code: 0, timedOut: false, stderr: "", stdout: args[0] === "info" ? JSON.stringify({ OSType: "linux", NCPU: 1, MemTotal: 1073741824 }) : JSON.stringify([{ Id: config.imageId, Os: "linux", Architecture: "amd64" }]) });
 const report = await dockerRunner.inspect(layout, probe); assert.equal(report.cpu, 1); assert.equal(report.memoryMiB, 1024); assert.equal(report.arch, "x64"); assert.equal(report.gpu, false);
 await assert.rejects(dockerRunner.inspect({ ...layout, imageId: "wrong" }, probe), /pinned Linux image/);
 const launch = dockerRunner.prepare(layout, "none", ["node", "--test"]);
 assert.ok(launch.args.includes("--network=none")); assert.ok(launch.args.includes("--cap-drop=ALL"));
});
