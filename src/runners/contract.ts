import { OperatorError } from "../verbs/io.ts";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Reference } from "../adapters/contract.ts";
import type { SandboxLayout } from "../containment/sandbox.ts";
import type { run, RunResult } from "../run.ts";
export const RUNNER_LIMITS = { cpu: 2, memoryMiB: 2048 } as const;
export interface Requirements {
 os: string; arch: string; cpu: number; memoryMiB: number; gui: boolean; emulator: boolean; gpu: boolean;
 toolchains: Record<string, number>;
}
export interface Capabilities {
 version: 1; runner: Reference; image: string; os: string; arch: string;
 toolchains: Record<string, string>; cpu: number; memoryMiB: number; gui: boolean; emulator: boolean; gpu: boolean;
 network: { agent: string; preparation: string; verification: string };
}
export interface PreparedLaunch { executable: string; args: string[]; layout: SandboxLayout; }
export interface ExecutionEvidence {
 version: 1; runner: Reference; image: string; container: string; code: number | null; timedOut: boolean; outputLimited: boolean;
}
export interface Runner {
 reference: Reference;
 prepare(layout: SandboxLayout, network: "none" | "bridge", command: readonly string[], interactive?: boolean): PreparedLaunch;
 execute(layout: SandboxLayout, args: readonly string[], options: Parameters<typeof run>[2]): Promise<RunResult>;
 connect(launch: PreparedLaunch): ChildProcessWithoutNullStreams;
 inspect(layout: SandboxLayout, probe?: typeof run): Promise<Omit<Capabilities, "toolchains">>;
 cancel(layout: SandboxLayout): Promise<void>;
 cleanup(layout: SandboxLayout): Promise<void>;
 evidence(layout: SandboxLayout, result: RunResult): ExecutionEvidence;
}
export function assertCapabilities(requirements: Requirements, actual: Capabilities): void {
 const unavailable = (field: string, need: unknown, have: unknown): never => { throw new OperatorError(`Unavailable capability ${field}: needs ${String(need)}, runner provides ${String(have)}. Run harness doctor or choose a supported project setup.`); };
 if (!actual || ![actual.cpu, actual.memoryMiB].every(n => Number.isFinite(n) && n > 0) || ![actual.gui, actual.emulator, actual.gpu].every(v => typeof v === "boolean") || !actual.toolchains || !actual.network || !["linux", "darwin", "win32"].includes(actual.os) || !["arm64", "x64"].includes(actual.arch)) throw new OperatorError("Invalid runner capability report.");
 if (actual.version !== 1) unavailable("report version", 1, actual.version);
 for (const field of ["os", "arch"] as const) if (requirements[field] !== "any" && requirements[field] !== actual[field]) unavailable(field, requirements[field], actual[field]);
 for (const field of ["cpu", "memoryMiB"] as const) if (requirements[field] > actual[field]) unavailable(field, requirements[field], actual[field]);
 for (const field of ["gui", "emulator", "gpu"] as const) if (requirements[field] && !actual[field]) unavailable(field, true, false);
 for (const [name, major] of Object.entries(requirements.toolchains)) {
  const version = actual.toolchains[name];
  if (!version || !/^v?\d+\./u.test(version) || Number(version.replace(/^v/u, "").split(".")[0]) < major) unavailable(`toolchain ${name}`, `major >= ${major}`, version ?? "missing");
 }
 if (actual.network.verification !== "none" || actual.network.preparation !== "bridge" || actual.network.agent !== "bridge") unavailable("network policy", "offline verification; bridge for preparation/agent", JSON.stringify(actual.network));
}
