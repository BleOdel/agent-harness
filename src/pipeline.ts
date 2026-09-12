/** Each executable gate receives a fresh copy of frozen source and clean dependencies. */
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import type { Config } from "./config.ts";
import type { SandboxLayout } from "./containment/sandbox.ts";
import type { ProjectAdapter, Environment, VerificationRecipe, Reference } from "./adapters/contract.ts";
import { nodeNpm } from "./adapters/node-npm.ts";
import { CLAIM_FILE, checkClaim, checkCriteriaEvidence, readClaim, type ClaimResult } from "./gates/claim.ts";
import { failed, type Gate, type GateRun, type GateVerdict, runGates } from "./gates/gate.ts";
import { checkLimits, type Limits } from "./gates/limits.ts";
import { type Change, collectChanges } from "./workspace/changes.ts";
import { captureBaseline, assertSnapshot, type Snapshot } from "./workspace/candidate.ts";
import { EnvironmentBlocked } from "./workspace/dependencies.ts";

export interface PipelineInputs {
  readonly config: Config;
  /** workDirectory points at frozen candidate source, never the builder directory. */
  readonly layout: SandboxLayout;
  /** The immutable starting source against which candidate changes are measured. */
  readonly project: string;
  readonly testCommand: readonly string[];
  readonly counterSource: string;
  readonly limits: Limits;
  readonly claim?: ClaimResult;
  /** Host-selected scripts replace worker-controlled scripts in verifier copies only. */
  readonly pinnedScripts?: Readonly<Record<string, string>>;
  readonly contractChecks?: readonly { id: string; source: Snapshot; command: readonly string[] }[];
  readonly environment?: Environment;
  readonly adapter?: ProjectAdapter;
  readonly recipe?: VerificationRecipe;
}
export interface PipelineResult {
  readonly run: GateRun;
  readonly changes: readonly Change[];
  readonly environmentKey?: string;
  readonly identity?: { adapter: Reference; runner: Reference; image: string; runtime: unknown };
}
export async function runPipeline(inputs: PipelineInputs): Promise<PipelineResult> {
  const { layout, config } = inputs;
  const adapter = inputs.adapter ?? nodeNpm;
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "harness-verification-")));
  let changes: Change[] = [];
  try {
    // Even direct callers cannot let a test modify the source used by review/apply.
    const source = await captureBaseline(layout.workDirectory, path.join(root, "source"), adapter.source.generatedDirectories);
    const claim = inputs.claim ?? await readClaim(layout.workDirectory);
    changes = (await collectChanges(inputs.project, source.directory, adapter.source.generatedDirectories)).filter(c => c.file !== CLAIM_FILE);
    let environment = inputs.environment;
    if (!environment || !await adapter.matches(environment, source.directory, layout, config.installPolicy)) {
      environment = await adapter.prepare(source.directory, path.join(root, "environment"), layout, config.gateTimeoutMs, config.installPolicy);
    }
    const prepared = environment;
    const recipe = inputs.recipe ?? await adapter.recipe(source.directory, inputs.testCommand);
    if (inputs.pinnedScripts !== undefined) recipe.scripts = { ...inputs.pinnedScripts };
    if (recipe.adapter.id !== adapter.reference.id || recipe.adapter.version !== adapter.reference.version) throw new Error("Verification recipe does not match the selected adapter.");
    const verify = async (name: string, check: (local: SandboxLayout) => Promise<GateVerdict>): Promise<GateVerdict> => {
      const work = path.join(root, name);
      await adapter.install(source.directory, work, prepared, layout, config.gateTimeoutMs);
      await adapter.pin(work, recipe);
      const verdict = await check({ ...layout, workDirectory: work });
      await assertSnapshot(source);
      return verdict;
    };
    const gates: Gate[] = [
      ...(await adapter.checks(source.directory, recipe, inputs.counterSource, config.gateTimeoutMs)).map(check => ({
        name: check.name, applies: () => check.applies, check: () => verify(check.name, check.check),
      })),
      ...(inputs.contractChecks ?? []).map(check => ({
        name: `contract:${check.id}`,
        applies: () => true,
        check: () => verify(`contract-${check.id}`, async local => {
          await assertSnapshot(check.source);
          const verdict = await adapter.test({ ...local, checksDirectory: check.source.directory }, check.command, inputs.counterSource, config.gateTimeoutMs);
          await assertSnapshot(check.source);
          return { ...verdict, summary: `contract ${check.id}: ${verdict.summary}` };
        }),
      })),
      {
        name: "size",
        applies: () => true,
        check: async () => {
          let lines = 0;
          for (const change of changes) {
            if (change.kind !== "deleted") {
              lines += (await readFile(path.join(source.directory, change.file), "utf8")).split("\n").length;
            }
          }
          return checkLimits(changes, lines, inputs.limits);
        },
      },
      {
        name: "claim",
        applies: () => true,
        check: async () => {
          if (!claim.ok) return failed("claim-missing", `claim: ${claim.reason}`);
          const verdict = checkClaim(claim.claim, changes);
          return verdict.passed ? checkCriteriaEvidence(claim.claim, new Set(Object.keys(source.files))) : verdict;
        },
      },
    ];
    const result = await runGates(gates);
    return { run: result, changes, environmentKey: prepared.key, identity: { adapter: adapter.reference, runner: { id: "docker", version: 1 }, image: layout.imageId, runtime: prepared.runtime } };
  } catch (error) {
    if (!(error instanceof EnvironmentBlocked)) throw error;
    const verdict = { ...failed("environment-blocked", "environment-blocked: clean verification inputs are unavailable", error.message), name: "environment" };
    return { run: { passed: false, firstFailure: verdict, verdicts: [verdict], skipped: [] }, changes };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
