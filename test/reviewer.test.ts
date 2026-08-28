import assert from "node:assert/strict";
import test from "node:test";
import { parseReview, reviewPrompt } from "../src/review/reviewer.ts";
import { diffLines, renderDiff } from "../src/review/diff.ts";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("a clean verdict passes", () => {
  const review = parseReview('{"verdict":"pass","unmet":[],"unaccounted":[],"notes":[]}');
  assert.equal(review.verdict, "pass");
  assert.equal(review.failure, undefined);
});

test("findings override a contradictory pass", () => {
  // A reviewer that lists problems and then says "pass" has contradicted
  // itself. The findings are the part with evidence behind them.
  const review = parseReview('{"verdict":"pass","unaccounted":["a build script nobody asked for"],"unmet":[]}');
  assert.equal(review.verdict, "escalate");
  assert.deepEqual(review.unaccounted, ["a build script nobody asked for"]);
});

test("a reply that is not JSON is a failure, never a pass", () => {
  // The whole point of the Reviewer is to be the thing that says no. One
  // that says yes when it is confused is worse than none, because it is
  // believed.
  for (const reply of ["Looks good to me!", "", "{ not json }", '{"verdict":"maybe"}']) {
    const review = parseReview(reply);
    assert.notEqual(review.verdict, "pass", `${JSON.stringify(reply)} was treated as a pass`);
    assert.ok(review.failure !== undefined || review.unmet.length + review.unaccounted.length > 0);
  }
});

test("a verdict wrapped in prose is still read", () => {
  // Models narrate. Refusing a correct verdict because it came with a
  // sentence around it would make the Reviewer unusable.
  const review = parseReview('Here is my review:\n{"verdict":"pass","unmet":[],"unaccounted":[]}\nHope that helps.');
  assert.equal(review.verdict, "pass");
});

test("the prompt carries every criterion and forbids writing", () => {
  const prompt = reviewPrompt({
    title: "entry-page: ship the detail page",
    criteria: ["navigation is exact", "the page matches its renderer"],
    diff: "--- added: x.js\n+ export const x = 1;",
    provider: undefined,
    model: undefined,
    timeoutMs: 1,
  });
  assert.match(prompt, /1\. navigation is exact/u);
  assert.match(prompt, /2\. the page matches its renderer/u);
  assert.match(prompt, /Read only; do not modify anything/u);
  assert.match(prompt, /Scope creep is the/u);
});

test("the diff shows added and removed lines", () => {
  assert.deepEqual(
    diffLines(["a", "b", "c"], ["a", "x", "c"]),
    ["  a", "- b", "+ x", "  c"],
  );
});

test("a file too large to show says so instead of showing part of it", async () => {
  // A reviewer shown a truncated file and not told will review the part
  // it saw as if it were the whole.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "harness-diff-test-")));
  try {
    await mkdir(path.join(root, "copy"), { recursive: true });
    await mkdir(path.join(root, "project"), { recursive: true });
    await writeFile(path.join(root, "copy", "big.js"), "x\n".repeat(2_000));
    const rendered = await renderDiff(
      path.join(root, "project"),
      path.join(root, "copy"),
      [{ file: "big.js", kind: "added", symlink: false }],
    );
    assert.match(rendered, /too large to show/u);
    assert.match(rendered, /NOT reviewed/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
