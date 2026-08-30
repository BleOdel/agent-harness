import assert from "node:assert/strict";
import test from "node:test";
import { diagnose } from "../src/attribution.ts";
import type { FailureKind } from "../src/gates/gate.ts";

test("a review escalation produces a diagnosis the builder can act on", () => {
  // Gate failures always got one informed retry; review escalations
  // stopped dead, so re-running handed the model the same task with no
  // idea what was wrong. Watched on a real run: the reviewer found that a
  // 404 page's relative links resolve beneath a missing nested path, and
  // the builder never heard it.
  const diagnosis = diagnose("review-escalated", "- the 404 page's links resolve beneath the missing path");
  assert.match(diagnosis.forAgent, /review-escalated gate/u);
  assert.match(diagnosis.forAgent, /404 page's links/u);
  assert.match(diagnosis.cause, /did not write the change/u);
  // And it must not tell the model to make the reviewer happy by any
  // means: a reasoned disagreement is worth more to the operator than a
  // silent edit that looks compliant.
  assert.match(diagnosis.fix, /say why in your summary rather than changing the code/u);
});

test("every failure kind has a diagnosis", () => {
  // A kind without one would reach the operator as an empty explanation
  // at the exact moment they need the fullest one.
  const kinds: FailureKind[] = [
    "tests-failed", "tests-proved-nothing", "tests-uncollected", "typecheck-failed",
    "build-not-reproducible", "claim-missing", "claim-mismatch", "too-large",
    "timed-out", "review-escalated", "boundary",
  ];
  for (const kind of kinds) {
    const diagnosis = diagnose(kind, "evidence");
    assert.ok(diagnosis.cause.length > 20, `${kind} has no cause`);
    assert.ok(diagnosis.fix.length > 20, `${kind} has no fix`);
  }
});
