import { OperatorError } from "../verbs/io.ts";
import { mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Config } from "../config.ts";
import type { SandboxLayout } from "../containment/sandbox.ts";
import { getAdapter } from "../adapters/registry.ts";
import { getRunner } from "../runners/docker.ts";
import { assertCapabilities, type Capabilities } from "../runners/contract.ts";
import { digest } from "../team/schema.ts";
import { atomicJson } from "../team/state.ts";
import { DEFAULT_INSTALL_POLICY } from "../workspace/dependencies.ts";
import { parseProfile, readProfile, saveProfile, savedProfile, type ProjectProfile } from "./profile.ts";
import { availableSkills, freezeSelectedSkills, type SkillBundle } from "./skills.ts";
import { run } from "../run.ts";
export function executionSettings(profile: ProjectProfile, config: Config, testCommand: readonly string[]) {
 return { profile, image: config.imageId, docker: config.dockerExecutable, pi: config.piPackageDirectory, agent: config.agentDirectory,
  skills: config.skillsDirectory ?? null, provider: config.provider ?? null, model: config.model ?? null,
  installPolicy: config.installPolicy ?? DEFAULT_INSTALL_POLICY, testCommand: [...testCommand], contracts: config.contractPaths ?? [] };
}
export type ExecutionSettings = ReturnType<typeof executionSettings>;
export interface ExecutionPin { version: 1; settings: ExecutionSettings; capabilities: Capabilities; skills: SkillBundle[]; digest: string; }
export function assertSettingsMatch(expected: ExecutionSettings, current: ExecutionSettings): void {
 if (digest(expected) !== digest(current)) throw new OperatorError("Execution settings changed since this run was accepted. Restore the saved settings shown by harness project show / team inspect, or start a new run. Saved work remains available.");
}
export function assertExecutionPin(pin: ExecutionPin): void {
 if (!pin || pin.version !== 1 || !pin.settings || !pin.capabilities || !Array.isArray(pin.skills)) throw new OperatorError("Missing or unsupported execution identity. Inspect or recover this older run; start a new run to build with the current adapter contract.");
 parseProfile(pin.settings.profile);
 const { digest: expected, ...content } = pin;
 if (digest(content) !== expected) throw new OperatorError("Saved execution identity changed.");
 if (pin.capabilities.image !== pin.settings.image || digest(pin.capabilities.runner) !== digest(pin.settings.profile.runner)) throw new OperatorError("Execution report does not match the accepted image and runner.");
 assertCapabilities(pin.settings.profile.requirements, pin.capabilities);
}
export function executionLayout(config: Config, work: string, name: string): SandboxLayout {
 return { dockerExecutable: config.dockerExecutable, imageId: config.imageId, agentDirectory: config.agentDirectory, piPackageDirectory: config.piPackageDirectory,
  containerName: name, workDirectory: work, user: `${process.getuid?.() ?? 501}:${process.getgid?.() ?? 20}`, purpose: "verification" };
}
export async function inspectCapabilities(profile: ProjectProfile, config: Config, probe = run): Promise<Capabilities> {
 const work = await realpath(await mkdtemp(path.join(os.tmpdir(), "harness-capabilities-")));
 try {
  const layout = executionLayout(config, work, `harness-capabilities-${path.basename(work).toLowerCase()}`);
  const runner = getRunner(profile.runner), adapter = getAdapter(profile.adapter);
  const facts = await runner.inspect(layout, probe);
  const runtime = await adapter.runtime(layout, Math.min(config.gateTimeoutMs, 30000));
  if (runtime.platform !== facts.os || runtime.arch !== facts.arch) throw new OperatorError("Runtime OS/architecture does not match the pinned image.");
  const capabilities: Capabilities = { ...facts, toolchains: Object.fromEntries(Object.entries(runtime).filter(([k]) => !["platform", "arch"].includes(k))) };
  assertCapabilities(profile.requirements, capabilities); return capabilities;
 } finally { await rm(work, { recursive: true, force: true }); }
}
export async function pinExecution(project: string, config: Config, testCommand: readonly string[], directory: string, role: "build" | "plan" | "team" = "build"): Promise<ExecutionPin> {
 const saved = await savedProfile(project);
 const profile = saved ?? await readProfile(project, role === "plan");
 if (config.skillsDirectory && role !== "team") {
  const skillsRoot = await realpath(config.skillsDirectory), live = await realpath(project);
  const overlaps = (parent: string, child: string) => { const relative = path.relative(parent, child); return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative)); };
  if (overlaps(live, skillsRoot) || overlaps(skillsRoot, live) || overlaps(`${live}-harness`, skillsRoot)) throw new OperatorError("Configured skills must be outside live project source and its harness state.", "Select a separate HARNESS_SKILLS directory, then retry.");
 }
 const available = role === "team" ? new Map<string, string>() : await availableSkills(config.skillsDirectory);
 if (!saved) {
  for (const name of ["build", "plan"] as const) profile.skills[name] = profile.skills[name].filter(id => available.has(id));
 } else if (role !== "team") {
  const missing = profile.skills[role].filter(id => !available.has(id));
  if (missing.length) throw new OperatorError(`Selected ${role} skills are unavailable: ${missing.join(", ")}.`, "Restore the selected skills or update them with harness project setup.");
 }
 const capabilities = await inspectCapabilities(profile, config);
 await mkdir(directory, { recursive: true, mode: 0o700 });
 const pending = await mkdtemp(path.join(directory, "skills-pending-"));
 try {
  const skills = role === "team" ? [] : await freezeSelectedSkills(config.skillsDirectory, pending, profile.skills[role]);
  const content = { version: 1 as const, settings: executionSettings(profile, config, testCommand), capabilities, skills };
  const pin = { ...content, digest: digest(content) };
  // A prior interrupted preparation has no accepted identity and may leave this owned directory.
  await rm(path.join(directory, "skills"), { recursive: true, force: true });
  await rename(pending, path.join(directory, "skills"));
  await atomicJson(path.join(directory, "execution.json"), pin);
  if (!saved) await saveProfile(project, profile);
  return pin;
 } finally { await rm(pending, { recursive: true, force: true }); }
}

export async function assertExecutionCompatible(pin: ExecutionPin, project: string, config: Config, testCommand: readonly string[], probe = false): Promise<void> {
 assertExecutionPin(pin);
 assertSettingsMatch(pin.settings, executionSettings(await readProfile(project, true), config, testCommand));
 if (probe && digest(await inspectCapabilities(pin.settings.profile, config)) !== digest(pin.capabilities)) throw new OperatorError("Runner capabilities or toolchain identity changed. Restore the accepted environment or start a new run.");
}
