/** Each executable gate receives a fresh copy of frozen source and clean dependencies. */
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type { Config } from "./config.ts";
import type { SandboxLayout } from "./containment/sandbox.ts";
import { checkBuildReproducible, checkTypecheck, packageScript } from "./gates/commands.ts";
import { CLAIM_FILE, checkClaim, checkCriteriaEvidence, readClaim, type ClaimResult } from "./gates/claim.ts";
import { failed, type Gate, type GateRun, type GateVerdict, runGates } from "./gates/gate.ts";
import { checkLimits, type Limits } from "./gates/limits.ts";
import { checkTestCollection, resolveTestCommand } from "./gates/test-collection.ts";
import { runTestGate } from "./gates/tests.ts";
import { type Change, collectChanges } from "./workspace/changes.ts";
import { captureBaseline, assertSnapshot, type Snapshot } from "./workspace/candidate.ts";
import { EnvironmentBlocked, installEnvironment, prepareEnvironment, type PreparedEnvironment } from "./workspace/dependencies.ts";

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
  readonly environment?: PreparedEnvironment;
}
export interface PipelineResult {
  readonly run: GateRun;
  readonly changes: readonly Change[];
  readonly environmentKey?: string;
}
export async function runPipeline(inputs: PipelineInputs): Promise<PipelineResult> {
  const { layout, config } = inputs;
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "harness-verification-")));
  let changes: Change[] = [];
  try {
    // Even direct callers cannot let a test modify the source used by review/apply.
    const source = await captureBaseline(layout.workDirectory, path.join(root, "source"));
    const claim = inputs.claim ?? await readClaim(layout.workDirectory);
    changes = (await collectChanges(inputs.project, source.directory)).filter(c => c.file !== CLAIM_FILE);
    let environment = inputs.environment;
    const manifest = await readFile(path.join(source.directory, "package.json"), "utf8").catch(() => undefined);
    const lock = await readFile(path.join(source.directory, "package-lock.json"), "utf8").catch(() => undefined);
    if (!environment || environment.manifest !== manifest || environment.lock !== lock) {
      environment = await prepareEnvironment(source.directory, path.join(root, "environment"), layout, config.gateTimeoutMs, config.installPolicy);
    }
    const prepared = environment;
    const script = (directory: string, name: string): Promise<string | undefined> => inputs.pinnedScripts === undefined ? packageScript(directory, name) : Promise.resolve(inputs.pinnedScripts[name]);
    const verify = async (name: string, check: (local: SandboxLayout) => Promise<GateVerdict>): Promise<GateVerdict> => {
      const work = path.join(root, name);
      await installEnvironment(source.directory, work, prepared, layout, config.gateTimeoutMs);
      if (inputs.pinnedScripts !== undefined) {
        const file = path.join(work, "package.json");
        const pkg = JSON.parse(await readFile(file, "utf8"));
        await writeFile(file, JSON.stringify({ ...pkg, scripts: inputs.pinnedScripts }));
      }
      const verdict = await check({ ...layout, workDirectory: work });
      await assertSnapshot(source);
      return verdict;
    };
    const gates: Gate[] = [
      {
        name: "tests",
        applies: () => true,
        check: () => verify("tests", local => runTestGate(local, inputs.counterSource, inputs.testCommand, config.gateTimeoutMs)),
      },
      {
        name: "test-collection",
        applies: () => true,
        check: async () => checkTestCollection(source.directory, await resolveTestCommand(source.directory, inputs.testCommand, script)),
      },
      {
        name: "typecheck",
        applies: async () => await script(source.directory, "typecheck") !== undefined,
        check: () => verify("typecheck", local => checkTypecheck(local, ["npm", "run", "typecheck"], config.gateTimeoutMs)),
      },
      {
        name: "build",
        applies: async () => await script(source.directory, "build") !== undefined,
        check: () => verify("build", local => checkBuildReproducible(local, ["npm", "run", "build"], config.gateTimeoutMs)),
      },
      ...(inputs.contractChecks ?? []).map(check => ({
        name: `contract:${check.id}`,
        applies: () => true,
        check: () => verify(`contract-${check.id}`, async local => {
          await assertSnapshot(check.source);
          const verdict = await runTestGate({ ...local, checksDirectory: check.source.directory }, inputs.counterSource, check.command, config.gateTimeoutMs);
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
    return { run: result, changes, environmentKey: prepared.key };
  } catch (error) {
    if (!(error instanceof EnvironmentBlocked)) throw error;
    const verdict = { ...failed("environment-blocked", "environment-blocked: clean verification inputs are unavailable", error.message), name: "environment" };
    return { run: { passed: false, firstFailure: verdict, verdicts: [verdict], skipped: [] }, changes };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
