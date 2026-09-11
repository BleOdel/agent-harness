/** Trusted check inputs live beside the journal and are never mounted by builders. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.ts";
import { assertSnapshot, captureBaseline, type Snapshot } from "../workspace/candidate.ts";
import { regularResource } from "./inputs.ts";
import { digest, type ContractCheck, type TeamPlan } from "./schema.ts";
import { atomicJson } from "./state.ts";

export interface FrozenChecks { scripts: Record<string, string>; testCommand: readonly string[]; checks: (ContractCheck & { source: Snapshot })[]; }
export async function freezeChecks(project: string, inputs: string, run: string, plan: TeamPlan, testCommand: readonly string[]): Promise<{ digest: string }> {
  const pkg = JSON.parse(await readFile(path.join(project, "package.json"), "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return "{}"; throw e; })) as { scripts?: Record<string, string> };
  if (Object.values(pkg.scripts ?? {}).some(s => typeof s !== "string")) throw new Error("Invalid package scripts.");
  if (!testCommand.length || testCommand.some(s => !s)) throw new Error("Empty test command.");
  const checks: FrozenChecks["checks"] = [];
  for (const check of plan.checks ?? []) {
    const directory = path.join(run, "inputs/checks", check.id, "incoming");
    for (const file of check.files) {
      const bytes = await regularResource(inputs, `${check.path}/${file}`);
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      await writeFile(path.join(directory, file), bytes, { flag: "wx", mode: 0o600 });
    }
    // Capture into a separate immutable source; only declared resources exist.
    const source = await captureBaseline(directory, path.join(run, "inputs/checks", check.id, "source"));
    await rm(directory, { recursive: true });
    checks.push({ ...check, source });
  }
  const frozen: FrozenChecks = { scripts: pkg.scripts ?? {}, testCommand, checks };
  await atomicJson(path.join(run, "inputs/verification.json"), frozen);
  return { digest: digest(frozen) };
}
export async function readChecks(run: string, expected: string | undefined): Promise<FrozenChecks> {
  const frozen = JSON.parse(await readFile(path.join(run, "inputs/verification.json"), "utf8")) as FrozenChecks;
  if (!expected || digest(frozen) !== expected) throw new Error("Frozen verification configuration changed.");
  for (const check of frozen.checks) await assertSnapshot(check.source);
  return frozen;
}
export async function resolveTeamModel(config: Pick<Config, "agentDirectory" | "provider" | "model">): Promise<{ provider: string | undefined; model: string | undefined }> {
  if (config.provider && config.model) return { provider: config.provider, model: config.model };
  const settings = JSON.parse(await readFile(path.join(config.agentDirectory, "settings.json"), "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return "{}"; throw e; })) as { defaultProvider?: unknown; defaultModel?: unknown };
  const value = (v: unknown): string | undefined => typeof v === "string" && v.trim() ? v.trim() : undefined;
  return { provider: config.provider ?? value(settings.defaultProvider), model: config.model ?? value(settings.defaultModel) };
}
