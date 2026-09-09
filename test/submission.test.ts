import assert from "node:assert/strict";
import test from "node:test";
import { parseSubmission } from "../src/agent/submission.ts";
import { parseClaim } from "../src/gates/claim.ts";

test("blocked submissions require a reason and requested input", () => {
  const valid = { outcome: "blocked", reason: "Missing decision", requestedInput: "Choose a region" };
  assert.deepEqual(parseSubmission(JSON.stringify(valid)), { ok: true, ...valid });
  for (const raw of [{ ...valid, reason: " " }, { ...valid, requestedInput: "" }, { outcome: "blocked" }]) {
    assert.equal(parseSubmission(JSON.stringify(raw)).ok, false);
  }
  assert.equal(parseClaim(JSON.stringify({ ...valid, criteria: [], files: [] })).ok, false);
});

test("completed and legacy claims remain valid; unknown outcomes fail closed", () => {
  const claim = { files: [], deletions: [], criteria: [{ criterion: "works", verifiedBy: "test.js" }] };
  for (const raw of [claim, { ...claim, outcome: "completed" }]) {
    assert.deepEqual(parseSubmission(JSON.stringify(raw)), { ok: true, outcome: "completed", claim });
  }
  for (const raw of ["null", "[]", "broken", JSON.stringify({ ...claim, outcome: "maybe" })]) {
    assert.equal(parseSubmission(raw).ok, false);
  }
});
