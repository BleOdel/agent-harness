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

/**
 * The shim the counter's resolve hook redirects to. A second file, and
 * therefore a second thing to forget to copy: the counter registers a
 * hook pointing at a sibling path, so a run with the counter and without
 * the shim fails every test file with a resolution error.
 */
export function shimPath(): string {
  return path.join(import.meta.dirname, "assert-shim.mjs");
}

/** Written into the copy so the container can load it; removed before the diff. */
export const COUNTER_IN_COPY = ".harness-assert-counter.mjs";
export const SHIM_IN_COPY = ".harness-assert-shim.mjs";
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
  // The counter's hook resolves the shim as a sibling, so the two names
  // in the copy must keep the same relationship as the two on disk.
  await writeFile(
    path.join(layout.workDirectory, COUNTER_IN_COPY),
    counterSource.replace("./assert-shim.mjs", `./${SHIM_IN_COPY}`),
    "utf8",
  );
  await writeFile(path.join(layout.workDirectory, SHIM_IN_COPY), await readFile(shimPath(), "utf8"), "utf8");
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
      + "One known blind spot, if you believe the suite does assert: `t.assert.ok` is "
      + "implemented natively by the test runner and is not observed. Every other "
      + "assertion style is -- module, named import, namespace import, require, and the "
      + "runner's other t.assert methods. A suite whose every assertion is t.assert.ok "
      + "will read as zero here.\n\n"
      + result.stdout,
    );
  }
  return passed(`tests: passed, ${String(executed)} assertions executed`, result.stdout);
}
