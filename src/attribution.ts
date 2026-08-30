/**
 * Turning a gate failure into a diagnosis.
 *
 * The rule this encodes: **attribution before recovery.** A model handed
 * a log and told to try again will fix the most visible line in it, which
 * is frequently not the cause. Handed a named failure and the specific
 * thing that must become true, it works on the actual problem.
 *
 * Each diagnosis says three things: what failed, why that matters, and
 * what would count as fixed. None of them says "try again".
 */

import type { FailureKind } from "./gates/gate.ts";

const DIAGNOSES: Record<FailureKind, { cause: string; fix: string }> = {
  "tests-failed": {
    cause: "The test suite failed. The code does not do what its own tests require.",
    fix: "Make the failing tests pass by fixing the code. Do not delete, skip, or weaken a test to get there.",
  },
  "tests-proved-nothing": {
    cause:
      "The suite exited zero without executing a single assertion, so it verified nothing. "
      + "A test file with no assertion passes every runner in existence.",
    fix: "Add assertions that would fail if the behaviour were wrong. Then break the code deliberately and confirm they fail.",
  },
  "tests-uncollected": {
    cause:
      "Test files exist that the test command never collects. Those tests are green by "
      + "never running, and they hide whatever they were written to catch.",
    fix: "Move each uncollected file to where the test command reaches it, and confirm the suite's test count rises.",
  },
  "typecheck-failed": {
    cause: "The project does not typecheck.",
    fix: "Fix the type errors themselves. Do not silence them with `any`, a cast, or a suppression comment.",
  },
  "build-not-reproducible": {
    cause:
      "Running the build changed committed files, so what is committed does not match what "
      + "its sources produce. Anyone reading the committed artefact is reading something stale.",
    fix: "Re-run the build and commit its output, so building again changes nothing.",
  },
  "claim-missing": {
    cause: "No claim was written, so there is nothing to check the work against.",
    fix: "Write the claim file listing every file changed, every deletion, and every acceptance criterion with the file that verifies it.",
  },
  "claim-mismatch": {
    cause:
      "The claim does not match what actually changed. Either work happened that the claim "
      + "does not mention, or the claim describes work that did not happen.",
    fix: "Make the claim exactly describe the change set, or make the change set match the claim. Do not pad the claim to silence the gate.",
  },
  "review-escalated": {
    cause:
      "A second reviewer, which did not write the change and cannot see how it was "
      + "reasoned about, judged it against the acceptance criteria and found something "
      + "unsatisfied or something present that nothing asked for.",
    fix:
      "Address each finding directly. If a criterion is genuinely satisfied and the "
      + "reviewer is wrong, say why in your summary rather than changing the code to "
      + "look compliant -- a second escalation goes to the operator, and a reasoned "
      + "disagreement is more useful to them than a silent edit.",
  },
  "too-large": {
    cause: "The change exceeds the ceiling for one run, which usually means the goal was misunderstood rather than large.",
    fix: "Do the smallest part of the goal that stands on its own, and stop there.",
  },
  "timed-out": {
    cause: "The run exceeded its time ceiling and was killed. Nothing about the work is known.",
    fix: "Nothing to fix in the code yet. Narrow the goal or raise the ceiling deliberately.",
  },
  boundary: {
    cause: "The change would have written outside the project, or through a symlink.",
    fix: "Keep every change inside the project as an ordinary file.",
  },
};

export interface Diagnosis {
  readonly kind: FailureKind;
  readonly cause: string;
  readonly fix: string;
  /** What the model is handed on a retry. Names the failure; never a raw log. */
  readonly forAgent: string;
}

export function diagnose(kind: FailureKind, evidence: string): Diagnosis {
  const { cause, fix } = DIAGNOSES[kind];
  return {
    kind,
    cause,
    fix,
    forAgent: [
      `The previous attempt was rejected by the ${kind} gate.`,
      "",
      `What happened: ${cause}`,
      `What must become true: ${fix}`,
      "",
      "The evidence:",
      evidence.trim(),
    ].join("\n"),
  };
}
