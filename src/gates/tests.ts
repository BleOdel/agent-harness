/**
 * Diagnostic project-test execution. Counts are project-controlled reports;
 * host-evaluated acceptance checks independently decide application.
 *
 * The count catches accidental empty suites; it cannot establish coverage.
 * Two diagnostic questions, not one. "Did the suite pass" is the question everyone
 * asks; "did it verify anything" is the one that catches a suite the
 * model wrote to satisfy the gate. A test file containing no assertion
 * passes every runner in existence.
 *
 * Runs with `--network=none`. A verification that can reach the network
 * is not verifying the code in front of it.
 */

import path from "node:path";
import os from "node:os";
import { mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { buildVerificationArguments, CONTAINER_WORK, type SandboxLayout } from "../containment/sandbox.ts";
import { runContained } from "../containment/process.ts";
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

/** A diagnostic output in the disposable verifier copy; never acceptance authority. */
export const COUNT_FILE = ".harness-assert-count";

/** Sums the per-process counts. Absent or unreadable reads as zero. */
async function assertionsExecuted(workDirectory: string): Promise<number> {
  try {
    const raw = await readFile(path.join(workDirectory, COUNT_FILE), "utf8");
    const values = raw.split("\n").filter(line => line.trim()).map(Number);
    if (values.some(n => !Number.isSafeInteger(n) || n < 0)) return 0;
    const total = values.reduce((sum, n) => sum + n, 0);
    return Number.isSafeInteger(total) ? total : 0;
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
  const instrumentation = await realpath(await mkdtemp(path.join(os.tmpdir(), "harness-instrumentation-")));
  let result;
  try {
    await writeFile(path.join(instrumentation, "assert-counter.mjs"), counterSource, "utf8");
    await writeFile(path.join(instrumentation, "assert-shim.mjs"), await readFile(shimPath(), "utf8"), "utf8");
    await writeFile(path.join(layout.workDirectory, COUNT_FILE), "", "utf8");
    const args = buildVerificationArguments({ ...layout, instrumentationDirectory: instrumentation }, "none", command);
    args.splice(args.indexOf(layout.imageId), 0,
      "--env=NODE_OPTIONS=--import=/harness-instrumentation/assert-counter.mjs",
      `--env=HARNESS_ASSERT_COUNT_FILE=${CONTAINER_WORK}/${COUNT_FILE}`);
    result = await runContained(layout, args, { timeoutMs });
  } finally { await rm(instrumentation, { recursive: true, force: true }); }
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
  return passed(`tests: passed, ${String(executed)} assertions reported by project tests; approved acceptance checks still required`, result.stdout);
}
