import { OperatorError } from "../verbs/io.ts";
/** Operator configuration lives beside the project, outside all model mounts. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getAdapter, detectProjects } from "../adapters/registry.ts";
import type { Reference } from "../adapters/contract.ts";
import { getRunner } from "../runners/docker.ts";
import type { Requirements } from "../runners/contract.ts";
import { harnessDirectory } from "../record/record.ts";
import { atomicJson } from "../team/state.ts";
export interface ProjectProfile { version: 1; adapter: Reference; runner: Reference; requirements: Requirements; skills: { build: string[]; plan: string[] }; }
export const profilePath = (project: string) => path.join(harnessDirectory(project), "project.json");
export function defaultProfile(adapter = "node-npm"): ProjectProfile { return { version: 1, adapter: { id: adapter, version: 1 }, runner: { id: "docker", version: 1 }, requirements: { os: "linux", arch: "any", cpu: 2, memoryMiB: 2048, gui: false, emulator: false, gpu: false, toolchains: adapter === "python-pip" ? { node: 26, python: 3, pip: 23 } : { node: 26, npm: 10 } }, skills: { build: ["codebase-design", "diagnosing-bugs", "domain-modeling", "tdd"], plan: ["grill-me", "grilling", "domain-modeling", "codebase-design"] } }; }
function object(value: unknown, keys: string[]): Record<string, unknown> {
 if (!value || typeof value !== "object" || Array.isArray(value)) throw new OperatorError("Invalid project configuration object.");
 if (Object.keys(value).some(k => !keys.includes(k))) throw new OperatorError("Unknown project setting. Project configuration cannot grant permissions or load plugins.");
 return value as Record<string, unknown>;
}
export function parseProfile(raw: unknown): ProjectProfile {
 const value = object(raw, ["version", "adapter", "runner", "requirements", "skills"]);
 if (value.version !== 1) throw new OperatorError("Unsupported project configuration version.");
 const reference = (raw: unknown): Reference => { const ref = object(raw, ["id", "version"]); if (typeof ref.id !== "string" || !Number.isSafeInteger(ref.version)) throw new OperatorError("Invalid adapter or runner reference."); return { id: ref.id, version: ref.version as number }; };
 const adapter = reference(value.adapter), runner = reference(value.runner); getAdapter(adapter); getRunner(runner);
 const r = object(value.requirements, ["os", "arch", "cpu", "memoryMiB", "gui", "emulator", "gpu", "toolchains"]);
 if (!["linux", "darwin", "win32"].includes(String(r.os)) || !["any", "arm64", "x64"].includes(String(r.arch)) || ![r.cpu, r.memoryMiB].every(n => Number.isSafeInteger(n) && Number(n) > 0) || ![r.gui, r.emulator, r.gpu].every(v => typeof v === "boolean") || !r.toolchains || typeof r.toolchains !== "object" || Array.isArray(r.toolchains) || Object.entries(r.toolchains).some(([k, v]) => !/^[a-z][a-z0-9-]*$/u.test(k) || !Number.isSafeInteger(v) || Number(v) < 1)) throw new OperatorError("Invalid capability requirements.");
 // Project requirements may ask for more; they may never lower the launcher's toolchain floor.
 const toolchains = r.toolchains as Record<string, number>;
 if (adapter.id === "node-npm" && ((toolchains.node ?? 0) < 26 || (toolchains.npm ?? 0) < 10)) throw new OperatorError("Node adapter requirements need Node >=26 and npm >=10.");
 if (adapter.id === "python-pip" && ((toolchains.node ?? 0) < 26 || (toolchains.python ?? 0) < 3 || (toolchains.pip ?? 0) < 23)) throw new OperatorError("Python adapter requires Python >=3.11, pip >=23 and Node >=26 for the model launcher.");
 const skills = object(value.skills, ["build", "plan"]);
 for (const role of ["build", "plan"]) if (!Array.isArray(skills[role]) || (skills[role] as unknown[]).some(v => typeof v !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(v)) || new Set(skills[role] as string[]).size !== (skills[role] as string[]).length) throw new OperatorError("Skill selection must contain unique skill names.");
 if ((skills.build as string[]).some(v => ["grill-me", "grilling"].includes(v))) throw new OperatorError("Interactive planning skills cannot be selected for unattended builds.");
 return { version: 1, adapter, runner, requirements: { ...r, toolchains } as unknown as Requirements, skills: skills as unknown as ProjectProfile["skills"] };
}
export async function savedProfile(project: string): Promise<ProjectProfile | undefined> {
 const text = await readFile(profilePath(project), "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; });
 return text === undefined ? undefined : parseProfile(JSON.parse(text));
}
export async function readProfile(project: string, allowEmpty = false): Promise<ProjectProfile> {
 const saved = await savedProfile(project); if (saved) return saved;
 const detected = await detectProjects(project);
 if (detected.length > 1) throw new OperatorError(`Multiple project types detected (${detected.join(", ")}). Choose the intended root with harness project setup.`);
 if (detected[0] === "python-pip") return defaultProfile("python-pip");
 if (detected[0] === "node-npm" || (allowEmpty && !detected.length)) return defaultProfile();
 throw new OperatorError(`No supported adapter selected${detected.length ? ` (${detected.join(", ")})` : ""}. Use harness project setup. This release builds single-package Node/npm and pure-Python projects.`);
}
export async function saveProfile(project: string, profile: ProjectProfile): Promise<void> { await atomicJson(profilePath(project), parseProfile(profile)); }

/** Adapter defaults follow the selected project through work, teams and planning. */
export async function projectTestCommand(project: string, configured?: string): Promise<string[]> {
 return configured?.trim() ? configured.split(" ").filter(Boolean) : [...getAdapter((await readProfile(project, true)).adapter).defaultTestCommand];
}
