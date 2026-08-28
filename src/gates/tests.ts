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
import { failed, type GateVerdict, passed } from "./gate.ts";

/**
 * Where the counter lives on disk, resolved from this module rather than
 * from whatever file happens to be calling.
 *
 * Moving the command into src/verbs/ broke a path built from the
 * caller's directory, and nothing caught it until a live run. A path to a
 * file this module owns belongs next to that file.
 */
export function counterPath(): string {
  return path.join(import.meta.dirname, "assert-counter.mjs");
}

/** Written into the copy so the container can load it; removed before the diff. */
export const COUNTER_IN_COPY = ".harness-assert-counter.mjs";
export const COUNT_FILE = ".harness-assert-count";

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
    return failed(
      "timed-out",
      `tests: timed out after ${String(Math.round(timeoutMs / 1000))}s`,
      result.stdout + result.stderr,
    );
  }
  if (result.code !== 0) {
    return failed("tests-failed", "tests: failed", result.stdout + result.stderr);
  }
  if (executed === 0) {
    // Deliberately not phrased as a passing suite. A suite that asserts
    // nothing has not passed in any sense the operator cares about.
    return failed(
      "tests-proved-nothing",
      "tests: exited zero but executed no assertions, so nothing was verified",
      "The test command succeeded without a single assertion running. That is what an "
      + "empty test file does, and what a test whose body never executes does.\n\n"
      + result.stdout,
    );
  }
  return passed(`tests: passed, ${String(executed)} assertions executed`, result.stdout);
}
