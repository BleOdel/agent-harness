/** Implementations are installed with the harness; project files never load host code. */
import type { SandboxLayout } from "../containment/sandbox.ts";
import type { GateVerdict } from "../gates/gate.ts";
import type { InstallPolicy } from "../workspace/dependencies.ts";
export interface Reference { id: string; version: number; }
export interface Environment { readonly key: string; readonly directory: string; readonly runtime: unknown; }
export interface VerificationRecipe { version: 1; adapter: Reference; testCommand: string[]; scripts?: Record<string, string>; }
export interface AdapterCheck { name: string; applies: boolean; check(layout: SandboxLayout): Promise<GateVerdict>; }
export interface ProjectAdapter {
 readonly reference: Reference;
 readonly markers: readonly string[];
 readonly defaultTestCommand: readonly string[];
 readonly source: { generatedDirectories: readonly string[]; sharedInputs: readonly string[] };
 /** Declared build outputs, not permission to apply them. E3 adds artifact export. */
 readonly artifacts: readonly string[];
 runtime(layout: SandboxLayout, timeoutMs: number): Promise<Record<string, string>>;
 prepare(source: string, directory: string, layout: SandboxLayout, timeoutMs: number, policy?: InstallPolicy): Promise<Environment>;
 matches(environment: Environment, source: string, layout: SandboxLayout, policy?: InstallPolicy): Promise<boolean>;
 install(source: string, destination: string, environment: Environment, layout: SandboxLayout, timeoutMs: number): Promise<void>;
 recipe(source: string, command: readonly string[]): Promise<VerificationRecipe>;
 pin(work: string, recipe: VerificationRecipe): Promise<void>;
 checks(source: string, recipe: VerificationRecipe, counter: string, timeoutMs: number): Promise<AdapterCheck[]>;
 test(layout: SandboxLayout, command: readonly string[], counter: string, timeoutMs: number): Promise<GateVerdict>;
}
