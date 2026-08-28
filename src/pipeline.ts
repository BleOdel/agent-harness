/**
 * The gates, in the order they run, and what happens when one fails.
 *
 * Order is not arbitrary. Each gate assumes the state the previous one
 * established, and cheap gates that produce specific diagnoses run before
 * expensive ones that produce vague ones. Tests first because a failing
 * suite makes every later verdict meaningless; the claim last because it
 * is the only gate about intent rather than about the code.
 */

import path from "node:path";
import { rm } from "node:fs/promises";
import type { Config } from "./config.ts";
import type { SandboxLayout } from "./containment/sandbox.ts";
import { checkBuildReproducible, checkTypecheck, packageScript } from "./gates/commands.ts";
import { CLAIM_FILE, checkClaim, checkCriteriaEvidence, readClaim } from "./gates/claim.ts";
import { type Gate, type GateRun, runGates } from "./gates/gate.ts";
import { checkLimits, type Limits } from "./gates/limits.ts";
import { checkTestCollection, resolveTestCommand } from "./gates/test-collection.ts";
import { COUNTER_IN_COPY, COUNT_FILE, runTestGate } from "./gates/tests.ts";
import { type Change, collectChanges } from "./workspace/changes.ts";

export interface PipelineInputs {
  readonly config: Config;
  readonly layout: SandboxLayout;
  readonly project: string;
  readonly testCommand: readonly string[];
  readonly counterSource: string;
  readonly limits: Limits;
}

export interface PipelineResult {
  readonly run: GateRun;
  readonly changes: readonly Change[];
}

/** Roughly how much text moved, without diffing: enough for a ceiling. */
function linesIn(changes: readonly Change[], contents: ReadonlyMap<string, number>): number {
  return changes.reduce((total, change) => total + (contents.get(change.file) ?? 0), 0);
}

export async function runPipeline(inputs: PipelineInputs): Promise<PipelineResult> {
  const { layout, project, config } = inputs;
  const work = layout.workDirectory;

  // Computed once, before the gate files are written, and reused. The
  // claim gate and the size gate must be looking at the same change set
  // as the apply step, or they are checking something else.
  const clean = async (): Promise<Change[]> => {
    await rm(path.join(work, COUNTER_IN_COPY), { force: true });
    await rm(path.join(work, COUNT_FILE), { force: true });
    const changes = await collectChanges(project, work);
    return changes.filter((change) => change.file !== CLAIM_FILE);
  };

  let changes: Change[] = [];
  const gates: Gate[] = [
    {
      name: "tests",
      applies: () => true,
      check: async () =>
        runTestGate(layout, inputs.counterSource, inputs.testCommand, config.gateTimeoutMs),
    },
    {
      name: "test-collection",
      applies: () => true,
      check: async () =>
        checkTestCollection(
          work,
          await resolveTestCommand(work, inputs.testCommand, packageScript),
        ),
    },
    {
      name: "typecheck",
      // Only projects that declare one. A project without a typecheck
      // script is not failed for not having it, and the run reports the
      // gate as not applicable rather than as passed.
      applies: async () => (await packageScript(work, "typecheck")) !== undefined,
      check: async () =>
        checkTypecheck(layout, ["npm", "run", "typecheck"], config.gateTimeoutMs),
    },
    {
      name: "build",
      applies: async () => (await packageScript(work, "build")) !== undefined,
      check: async () =>
        checkBuildReproducible(layout, ["npm", "run", "build"], config.gateTimeoutMs),
    },
    {
      name: "size",
      applies: () => true,
      check: async () => {
        changes = await clean();
        const { readFile } = await import("node:fs/promises");
        const lineCounts = new Map<string, number>();
        for (const change of changes) {
          if (change.kind === "deleted") continue;
          try {
            const text = await readFile(path.join(work, change.file), "utf8");
            lineCounts.set(change.file, text.split("\n").length);
          } catch {
            lineCounts.set(change.file, 0);
          }
        }
        return checkLimits(changes, linesIn(changes, lineCounts), inputs.limits);
      },
    },
    {
      name: "claim",
      applies: () => true,
      check: async () => {
        const result = await readClaim(work);
        if (!result.ok) {
          const { failed } = await import("./gates/gate.ts");
          return failed("claim-missing", `claim: ${result.reason}`);
        }
        const shape = checkClaim(result.claim, changes);
        if (!shape.passed) return shape;
        const { fingerprintTree } = await import("./workspace/changes.ts");
        return checkCriteriaEvidence(result.claim, new Set((await fingerprintTree(work)).keys()));
      },
    },
  ];

  const run = await runGates(gates);
  // The size gate is what populates `changes`, so a failure before it
  // leaves the set empty. Nothing downstream may treat that as "no
  // changes"; the caller only applies on a full pass.
  if (run.passed && changes.length === 0) changes = await clean();
  return { run, changes };
}
