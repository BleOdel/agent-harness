/**
 * What a gate is.
 *
 * A gate answers one question about a finished piece of work and returns
 * a verdict the operator can read in a line. Detail exists, and is shown
 * only when the answer is no.
 *
 * Two rules hold for every gate here, and they are the reason the design
 * works at all:
 *
 * 1. **A gate that cannot run fails.** It never passes by default and
 *    never skips quietly. v1 shipped four checks that looked correct and
 *    did nothing; each one had a path where absence read as success.
 * 2. **A gate reports what it measured, not what it was told.** No gate
 *    asks the model whether the work is good. In M1 the model misreported
 *    its own assertion count in two runs out of four.
 */

export type FailureKind =
  | "tests-failed"
  | "tests-proved-nothing"
  | "tests-uncollected"
  | "typecheck-failed"
  | "build-not-reproducible"
  | "claim-missing"
  | "claim-mismatch"
  | "too-large"
  | "timed-out"
  | "boundary";

export interface GateVerdict {
  readonly passed: boolean;
  /** One line. On success this is all the operator sees. */
  readonly summary: string;
  /** Shown only on failure. */
  readonly detail: string;
  /** Absent when passed. Drives attribution. */
  readonly kind?: FailureKind;
}

export const passed = (summary: string, detail = ""): GateVerdict =>
  ({ passed: true, summary, detail });

export const failed = (kind: FailureKind, summary: string, detail = ""): GateVerdict =>
  ({ passed: false, summary, detail, kind });

export interface Gate {
  readonly name: string;
  /**
   * Whether this gate applies to this project at all. A gate that does
   * not apply is reported as such and is never counted as a pass, so
   * "9 gates passed" can never mean "9 gates were skipped".
   */
  readonly applies: () => boolean | Promise<boolean>;
  readonly check: () => Promise<GateVerdict>;
}

export interface GateRun {
  readonly verdicts: readonly (GateVerdict & { readonly name: string })[];
  readonly skipped: readonly string[];
  readonly passed: boolean;
  readonly firstFailure: (GateVerdict & { readonly name: string }) | undefined;
}

/**
 * Runs gates in order and stops at the first failure.
 *
 * Stopping is deliberate. Later gates read the state earlier gates
 * assumed -- there is nothing useful to say about a change's size when
 * its tests do not compile -- and a wall of consequential failures buries
 * the one that matters.
 */
export async function runGates(gates: readonly Gate[]): Promise<GateRun> {
  const verdicts: (GateVerdict & { name: string })[] = [];
  const skipped: string[] = [];
  for (const gate of gates) {
    if (!(await gate.applies())) {
      skipped.push(gate.name);
      continue;
    }
    const verdict = { ...(await gate.check()), name: gate.name };
    verdicts.push(verdict);
    if (!verdict.passed) {
      return { verdicts, skipped, passed: false, firstFailure: verdict };
    }
  }
  return { verdicts, skipped, passed: true, firstFailure: undefined };
}
