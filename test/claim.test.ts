import assert from "node:assert/strict";
import test from "node:test";
import {
  type Claim,
  checkClaim,
  checkCriteriaEvidence,
  parseClaim,
} from "../src/gates/claim.ts";
import type { Change } from "../src/workspace/changes.ts";

const change = (file: string, kind: Change["kind"]): Change => ({ file, kind, symlink: false });
const claim = (partial: Partial<Claim>): Claim => ({
  files: [],
  deletions: [],
  criteria: [{ criterion: "it works", verifiedBy: "test/a.test.js" }],
  ...partial,
});

test("a claim matching the change set passes", () => {
  const verdict = checkClaim(
    claim({ files: ["src/a.ts", "test/a.test.js"] }),
    [change("src/a.ts", "added"), change("test/a.test.js", "added")],
  );
  assert.equal(verdict.passed, true, verdict.detail);
});

test("a file changed but not declared is caught", () => {
  // The interesting direction: the edit the summary did not mention.
  const verdict = checkClaim(
    claim({ files: ["src/a.ts"] }),
    [change("src/a.ts", "added"), change("package.json", "modified")],
  );
  assert.equal(verdict.passed, false);
  assert.equal(verdict.kind, "claim-mismatch");
  assert.match(verdict.detail, /changed but not declared:\s+package\.json/u);
});

test("a file declared but never changed is caught", () => {
  // The claim describing work that did not happen.
  const verdict = checkClaim(claim({ files: ["src/a.ts", "src/never.ts"] }), [change("src/a.ts", "added")]);
  assert.equal(verdict.passed, false);
  assert.match(verdict.detail, /declared but not changed:\s+src\/never\.ts/u);
});

test("an undeclared deletion is caught", () => {
  const verdict = checkClaim(claim({ files: [] }), [change("src/gone.ts", "deleted")]);
  assert.equal(verdict.passed, false);
  assert.match(verdict.detail, /deleted but not declared:\s+src\/gone\.ts/u);
});

test("a claim with no acceptance criteria is refused", () => {
  const verdict = checkClaim(claim({ files: ["src/a.ts"], criteria: [] }), [change("src/a.ts", "added")]);
  assert.equal(verdict.passed, false);
  assert.match(verdict.summary, /no acceptance criteria/u);
});

test("a criterion pointing at a file that does not exist is refused", () => {
  // Otherwise the cheapest way past the gate is to name a plausible file.
  const verdict = checkCriteriaEvidence(
    claim({ criteria: [{ criterion: "it works", verifiedBy: "test/imaginary.test.js" }] }),
    new Set(["test/a.test.js"]),
  );
  assert.equal(verdict.passed, false);
  assert.match(verdict.detail, /test\/imaginary\.test\.js/u);
});

test("criteria pointing at real files pass", () => {
  const verdict = checkCriteriaEvidence(claim({}), new Set(["test/a.test.js"]));
  assert.equal(verdict.passed, true, verdict.detail);
});

test("a malformed claim is refused with the reason, not a crash", () => {
  for (const [text, expected] of [
    ["not json", /not valid JSON/u],
    ["[]", /must be a JSON object/u],
    ['{"files": "src/a.ts", "criteria": []}', /"files" must be an array/u],
    ['{"criteria": [{"criterion": 1}]}', /string "criterion"/u],
    ['{"files": []}', /"criteria" must be an array/u],
  ] as const) {
    const result = parseClaim(text);
    assert.equal(result.ok, false, `${text} was accepted`);
    if (!result.ok) assert.match(result.reason, expected);
  }
});

test("declaring the claim file itself is not a discrepancy", () => {
  // The claim file is stripped from the change set before the gate runs,
  // so a model that honestly lists it would otherwise be refused for a
  // discrepancy the harness created. Found in a live run, which spent its
  // retry on it.
  const verdict = checkClaim(
    claim({ files: ["src/a.ts", ".harness-claim.json"] }),
    [change("src/a.ts", "added")],
  );
  assert.equal(verdict.passed, true, verdict.detail);
});
