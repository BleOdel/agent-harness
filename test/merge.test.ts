import assert from "node:assert/strict";
import test from "node:test";
import { threeWayMerge } from "../src/recovery/merge.ts";

/**
 * The whole value of `undo` rests on this being right. A merge that
 * silently picks a side turns an undo into a way to destroy work that was
 * never being undone, and it would do it quietly.
 */

const lines = (text: string): string[] => text.split("\n");

test("a file nobody touched since is restored exactly", () => {
  const base = lines("a\nNEW\nc");
  const result = threeWayMerge(base, base, lines("a\nb\nc"));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.lines, ["a", "b", "c"]);
});

test("a later change elsewhere in the file is kept", () => {
  // The case the plan requires: undo at any point, including after later
  // changes touched the same file.
  const base = lines("header\nNEW\nfooter");
  const ours = lines("header\nNEW\nfooter\nADDED LATER");
  const theirs = lines("header\nold\nfooter");
  const result = threeWayMerge(base, ours, theirs);
  assert.equal(result.ok, true, "ok" in result ? "" : JSON.stringify(result));
  if (result.ok) {
    assert.deepEqual(result.lines, ["header", "old", "footer", "ADDED LATER"]);
    assert.equal(result.kept, 1);
  }
});

test("two later changes elsewhere are both kept", () => {
  const base = lines("one\nNEW\nthree\nfour");
  const ours = lines("ONE\nNEW\nthree\nFOUR");
  const theirs = lines("one\nold\nthree\nfour");
  const result = threeWayMerge(base, ours, theirs);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.lines, ["ONE", "old", "three", "FOUR"]);
});

test("a later change to the same lines is a conflict, not a guess", () => {
  // Both want to rewrite the same region. Choosing either side silently
  // destroys work, so the operator is told instead.
  const base = lines("a\nNEW\nc");
  const ours = lines("a\nEDITED LATER\nc");
  const theirs = lines("a\nold\nc");
  const result = threeWayMerge(base, ours, theirs);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.conflicts[0]!, /both rewrote this region/u);
});

test("an undo that adds lines back where later work inserted is a conflict", () => {
  const base = lines("a\nc");
  const ours = lines("a\nLATER\nc");
  const theirs = lines("a\nb\nc");
  const result = threeWayMerge(base, ours, theirs);
  assert.equal(result.ok, false);
});

test("an unchanged file merges to itself", () => {
  // The degenerate case. If this were wrong every undo would rewrite
  // every file it touched.
  const base = lines("a\nb\nc");
  const result = threeWayMerge(base, base, base);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.lines, ["a", "b", "c"]);
});

test("undoing a pure addition removes it and keeps later work", () => {
  const base = lines("a\nb\nADDED\nc");
  const ours = lines("a\nb\nADDED\nc\nLATER");
  const theirs = lines("a\nb\nc");
  const result = threeWayMerge(base, ours, theirs);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.lines, ["a", "b", "c", "LATER"]);
});

test("one line both changes rewrote is merged at token level", () => {
  // The overwhelmingly common conflict: an import list that a later
  // change also extended. Line granularity calls this a conflict for a
  // reason that is really about line endings.
  const base = lines('import { shout, whisper } from "./text.js";');
  const ours = lines('import { reverse, shout, whisper } from "./text.js";');
  const theirs = lines('import { shout } from "./text.js";');
  const result = threeWayMerge(base, ours, theirs);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.lines, ['import { reverse, shout } from "./text.js";']);
});

test("a line where the two changes touch the same words is still a conflict", () => {
  // Token granularity must not turn a real disagreement into a silent
  // choice. Both rewrote the same identifier.
  const base = lines("const timeout = 30;");
  const ours = lines("const timeout = 90;");
  const theirs = lines("const timeout = 10;");
  const result = threeWayMerge(base, ours, theirs);
  assert.equal(result.ok, false);
});

test("a multi-line region both changes rewrote stays a conflict", () => {
  // Anything wider than one line for one line is a real disagreement
  // about structure, and token merging is not attempted.
  const base = lines("a\nb\nc\nd");
  const ours = lines("a\nOURS1\nOURS2\nd");
  const theirs = lines("a\nTHEIRS1\nTHEIRS2\nd");
  const result = threeWayMerge(base, ours, theirs);
  assert.equal(result.ok, false);
});
