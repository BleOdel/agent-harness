/**
 * The gate that decides whether anything reaches the operator's
 * repository.
 *
 * Two questions, not one. "Did the suite pass" is the question everyone
 * asks; "did it verify anything" is the one that catches a suite the
 * model wrote to satisfy the gate. A test file containing no assertion
 * passes every runner in existence.
 *
 * Runs with `--network=none`. A verification that can reach the network
 * is not verifying the code in front of it.
 */

import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { buildRunArguments, CONTAINER_WORK, type SandboxLayout } from "../containment/sandbox.ts";
import { run } from "../run.ts";

/** Written into the copy so the container can load it; removed before the diff. */
export const COUNTER_IN_COPY = ".harness-assert-counter.mjs";
const COUNT_FILE = ".harness-assert-count";

export interface GateVerdict {
  readonly passed: boolean;
  /** One line. The operator reads this on success and nothing else. */
  readonly summary: string;
  /** Everything else. Shown only when `passed` is false. */
  readonly detail: string;
}

/** Sums the per-process counts. Absent or unreadable reads as zero. */
async function assertionsExecuted(workDirectory: string): Promise<number> {
  try {
    const raw = await readFile(path.join(workDirectory, COUNT_FILE), "utf8");
    return raw.split("\n").reduce((total, line) => total + (Number(line.trim()) || 0), 0);
  } catch {
    return 0;
  }
}

export async function runTestGate(
  layout: SandboxLayout,
  counterSource: string,
  command: readonly string[],
  timeoutMs: number,
): Promise<GateVerdict> {
  await writeFile(path.join(layout.workDirectory, COUNTER_IN_COPY), counterSource, "utf8");
  await writeFile(path.join(layout.workDirectory, COUNT_FILE), "", "utf8");

  const args = buildRunArguments(layout, "none", command);
  args.splice(
    args.indexOf(layout.imageId),
    0,
    `--env=NODE_OPTIONS=--import=${CONTAINER_WORK}/${COUNTER_IN_COPY}`,
    `--env=HARNESS_ASSERT_COUNT_FILE=${CONTAINER_WORK}/${COUNT_FILE}`,
  );
  const result = await run(layout.dockerExecutable, args, { timeoutMs });
  const executed = await assertionsExecuted(layout.workDirectory);

  if (result.timedOut) {
    return {
      passed: false,
      summary: `tests: timed out after ${String(Math.round(timeoutMs / 1000))}s`,
      detail: result.stdout + result.stderr,
    };
  }
  if (result.code !== 0) {
    return {
      passed: false,
      summary: "tests: failed",
      detail: result.stdout + result.stderr,
    };
  }
  if (executed === 0) {
    return {
      passed: false,
      // Deliberately not phrased as a passing suite. A suite that asserts
      // nothing has not passed in any sense the operator cares about.
      summary: "tests: exited zero but executed no assertions, so nothing was verified",
      detail:
        "The test command succeeded without a single assertion running. That is what an "
        + "empty test file does, and what a test whose body never executes does.\n\n"
        + result.stdout,
    };
  }
  return {
    passed: true,
    summary: `tests: passed, ${String(executed)} assertions executed`,
    detail: result.stdout,
  };
}
