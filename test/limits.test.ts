import assert from "node:assert/strict";
import test from "node:test";
import { checkLimits, DEFAULT_LIMITS } from "../src/gates/limits.ts";
import type { Change } from "../src/workspace/changes.ts";

const changes = (count: number): Change[] =>
  Array.from({ length: count }, (_, index) => ({
    file: `src/file${String(index)}.ts`,
    kind: "added" as const,
    symlink: false,
  }));

test("ordinary work is within the ceilings", () => {
  // The ceiling that fires on ordinary work teaches the operator to raise
  // it without reading it, which is worse than not having one.
  const verdict = checkLimits(changes(7), 400, DEFAULT_LIMITS);
  assert.equal(verdict.passed, true, verdict.detail);
});

test("too many files is refused, and the detail names them", () => {
  const verdict = checkLimits(changes(41), 100, DEFAULT_LIMITS);
  assert.equal(verdict.passed, false);
  assert.equal(verdict.kind, "too-large");
  assert.match(verdict.detail, /src\/file0\.ts/u);
  assert.match(verdict.detail, /and 21 more/u);
});

test("too many lines is refused", () => {
  const verdict = checkLimits(changes(3), 4_001, DEFAULT_LIMITS);
  assert.equal(verdict.passed, false);
  assert.match(verdict.summary, /4001 lines changed/u);
});

test("the ceiling is exactly the ceiling, not one less", () => {
  assert.equal(checkLimits(changes(40), 4_000, DEFAULT_LIMITS).passed, true);
  assert.equal(checkLimits(changes(41), 4_000, DEFAULT_LIMITS).passed, false);
  assert.equal(checkLimits(changes(40), 4_001, DEFAULT_LIMITS).passed, false);
});
