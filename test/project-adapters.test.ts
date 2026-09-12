import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectProjects, getAdapter } from "../src/adapters/registry.ts";
import { defaultProfile, readProfile, saveProfile, parseProfile } from "../src/project/profile.ts";
import { assertCapabilities, type Capabilities } from "../src/runners/contract.ts";
import { executionSettings, assertSettingsMatch } from "../src/project/execution.ts";
import { runPipeline } from "../src/pipeline.ts";
import type { ProjectAdapter } from "../src/adapters/contract.ts";
import { copySource } from "../src/workspace/candidate.ts";
import { passed } from "../src/gates/gate.ts";
import type { Config } from "../src/config.ts";

const config: Config = { dockerExecutable: "/docker", imageId: `sha256:${"a".repeat(64)}`, piPackageDirectory: "/pi", agentDirectory: "/agent", skillsDirectory: undefined, provider: undefined, model: undefined, agentTimeoutMs: 100, gateTimeoutMs: 100 };
const capabilities: Capabilities = { version: 1, runner: { id: "docker", version: 1 }, image: config.imageId, os: "linux", arch: "arm64", toolchains: { node: "v26.5.0", npm: "11.5.0" }, cpu: 2, memoryMiB: 2048, gui: false, emulator: false, gpu: false, network: { agent: "bridge", preparation: "bridge", verification: "none" } };
async function fixture(action: (project: string, root: string) => Promise<void>) {
 const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "adapter-test-"))); const project = path.join(root, "project"); await mkdir(project);
 try { await action(project, root); } finally { await rm(root, { recursive: true, force: true }); }
}
test("detection suggests Node but mixed projects need explicit host-owned selection", () => fixture(async project => {
 await writeFile(path.join(project, "package.json"), '{"scripts":{"test":"node --test"}}');
 assert.deepEqual(await detectProjects(project), ["node-npm"]);
 assert.equal((await readProfile(project)).adapter.id, "node-npm");
 await writeFile(path.join(project, "pyproject.toml"), "[project]\nname='mixed'\n");
 await assert.rejects(readProfile(project), /Multiple project types.*project setup/su);
 await saveProfile(project, defaultProfile());
 assert.equal((await readProfile(project)).adapter.id, "node-npm");
 await writeFile(path.join(project, "harness-project.json"), JSON.stringify({ runner: "host", network: "all" }));
 assert.equal((await readProfile(project)).runner.id, "docker");
 assert.equal(JSON.parse(await readFile(`${project}-harness/project.json`, "utf8")).version, 1);
}));
test("unknown adapters, versions and privilege-shaped configuration fail closed", () => {
 assert.throws(() => getAdapter({ id: "python", version: 1 }), /Unsupported adapter/);
 assert.throws(() => getAdapter({ id: "node-npm", version: 999 }), /Unsupported adapter/);
 assert.throws(() => parseProfile({ ...defaultProfile(), mounts: ["/"] }), /Unknown project setting/);
 assert.throws(() => parseProfile({ ...defaultProfile(), runner: { id: "docker", version: 2 } }), /Unsupported runner/);
 assert.throws(() => parseProfile({ ...defaultProfile(), requirements: { ...defaultProfile().requirements, cpu: -1 } }), /requirements/);
});
test("capability requirements cannot grant GUI, GPU, network or unprovided resources", () => {
 assert.doesNotThrow(() => assertCapabilities(defaultProfile().requirements, capabilities));
 for (const requirements of [
  { ...defaultProfile().requirements, gpu: true }, { ...defaultProfile().requirements, gui: true },
  { ...defaultProfile().requirements, emulator: true }, { ...defaultProfile().requirements, cpu: 4 },
  { ...defaultProfile().requirements, memoryMiB: 4096 }, { ...defaultProfile().requirements, os: "darwin" },
  { ...defaultProfile().requirements, arch: "x64" },
 ]) assert.throws(() => assertCapabilities(requirements, capabilities), /Unavailable capability/);
 assert.throws(() => assertCapabilities(defaultProfile().requirements, { ...capabilities, toolchains: { node: "v24.0.0", npm: "11.0.0" } }), /toolchain/);
 assert.throws(() => assertCapabilities(defaultProfile().requirements, { ...capabilities, network: { ...capabilities.network, verification: "bridge" } }), /network/);
});
test("saved execution settings reject image, adapter, test and policy drift", () => {
 const original = executionSettings(defaultProfile(), config, ["npm", "test"]);
 assert.doesNotThrow(() => assertSettingsMatch(original, executionSettings(defaultProfile(), { ...config }, ["npm", "test"])));
 for (const altered of [
  executionSettings(defaultProfile(), { ...config, imageId: `sha256:${"b".repeat(64)}` }, ["npm", "test"]),
  executionSettings(defaultProfile(), config, ["node", "--test"]),
  executionSettings(defaultProfile(), { ...config, installPolicy: { scripts: "allow", flags: [] } }, ["npm", "test"]),
  executionSettings({ ...defaultProfile(), skills: { build: ["tdd"], plan: [] } }, config, ["npm", "test"]),
 ]) assert.throws(() => assertSettingsMatch(original, altered), /Execution settings changed/);
});
test("a second adapter verifies without package.json, npm, or Node assertion instrumentation", () => fixture(async (project, root) => {
 await writeFile(path.join(project, "hello.txt"), "hello");
 const calls: string[] = [];
 const adapter: ProjectAdapter = {
  reference: { id: "fixture-text", version: 1 }, markers: ["hello.txt"], defaultTestCommand: ["check-text"],
  source: { generatedDirectories: ["generated"], sharedInputs: ["inputs.txt"] }, artifacts: ["generated"],
  async runtime() { return { text: "1" }; },
  async prepare(_source, directory) { calls.push("prepare"); return { key: "fixture-environment", directory, runtime: { text: "1" } }; },
  async matches() { return false; },
  async install(source, destination) { calls.push("install"); await copySource(source, destination); },
  async recipe(_source, command) { return { version: 1, adapter: this.reference, testCommand: [...command] }; },
  async pin() { calls.push("pin"); },
  async checks(_source, recipe) { assert.deepEqual(recipe.testCommand, ["check-text"]); return [{ name: "tests", applies: true, async check(local) { assert.equal(await readFile(path.join(local.workDirectory, "hello.txt"), "utf8"), "hello"); calls.push("test"); return passed("fixture text verified"); } }]; },
  async test() { return passed("contract fixture"); },
 };
 const baseline = path.join(root, "baseline"); await mkdir(baseline);
 const result = await runPipeline({ adapter, config, layout: { dockerExecutable: config.dockerExecutable, imageId: config.imageId, piPackageDirectory: config.piPackageDirectory, agentDirectory: config.agentDirectory, workDirectory: project, containerName: "harness-fixture", user: "1000:1000" }, project: baseline, testCommand: ["check-text"], counterSource: "must not be used", limits: { maxFiles: 2, maxLines: 20 }, claim: { ok: true, claim: { files: ["hello.txt"], deletions: [], criteria: [{ criterion: "hello", verifiedBy: "hello.txt" }] } } });
 assert.equal(result.run.passed, true, JSON.stringify(result.run));
 assert.equal(result.environmentKey, "fixture-environment");
 assert.deepEqual(calls, ["prepare", "install", "pin", "test"]);
}));
