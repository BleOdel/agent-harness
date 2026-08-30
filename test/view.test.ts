import assert from "node:assert/strict";
import test from "node:test";
import { escape, renderPage, type RunView } from "../src/view/render.ts";
import type { RunRecord } from "../src/record/record.ts";

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: "r1",
  at: "2026-08-30T20:02:00.000Z",
  project: "/tmp/p",
  goal: "thing",
  attempts: 1,
  outcome: "applied",
  gates: ["tests: passed, 12 assertions executed"],
  changes: [],
  ...over,
});

const view = (over: Partial<RunView> = {}): RunView => ({
  run: run(),
  title: "A thing",
  criteria: ["it works"],
  files: [],
  standing: true,
  ...over,
});

test("project content is escaped, never rendered as markup", () => {
  // The page shows file contents, acceptance criteria, and the reviewer's
  // words -- all of which come from a project a model has been writing
  // in. A viewer that executed any of it would be a way for a sandboxed
  // change to reach the host, through the one tool that was supposed to
  // be safe because it runs nothing.
  const nasty = '<script>alert("x")</script>';
  const page = renderPage(nasty, [view({
    title: nasty,
    criteria: [nasty],
    files: [{ file: nasty, kind: "added", lines: [`+ ${nasty}`] }],
    run: run({ goal: nasty, reason: nasty, review: { verdict: "escalate", findings: [nasty] } }),
  })]);
  assert.equal(page.includes("<script>alert"), false, "unescaped markup reached the page");
  assert.ok(page.includes("&lt;script&gt;"));
  assert.equal(escape('a & b < c > d "e"'), "a &amp; b &lt; c &gt; d &quot;e&quot;");
});

test("a run with no diff says why rather than looking empty", () => {
  // A run whose snapshot is gone still happened. Showing it with no files
  // would read as a run that changed nothing.
  const page = renderPage("p", [view({
    files: [{ file: "a.js", kind: "modified", lines: [], note: "The recovery snapshot for this run is gone." }],
  })]);
  assert.match(page, /recovery snapshot for this run is gone/u);
});

test("a truncated diff says so", () => {
  const page = renderPage("p", [view({
    files: [{ file: "big.js", kind: "modified", lines: ["+ a"], note: "Showing the first 600 of 4000 changed lines." }],
  })]);
  assert.match(page, /Showing the first 600 of 4000/u);
});

test("a reversed run is marked, not silently shown as standing", () => {
  // Assert on the marker, not the word: "reversed" also appears in the
  // stylesheet, so a looser check passes on every page ever rendered.
  const applied = renderPage("p", [view({ standing: true })]);
  const reversed = renderPage("p", [view({ standing: false })]);
  assert.equal(applied.includes("reversed by a later undo"), false);
  assert.equal(applied.includes('class="run applied reversed"'), false);
  assert.match(reversed, /reversed by a later undo/u);
  assert.match(reversed, /class="run applied reversed"/u);
});

test("added and removed lines are counted and classed separately", () => {
  const page = renderPage("p", [view({
    files: [{ file: "a.js", kind: "modified", lines: ["+ one", "+ two", "- gone"] }],
  })]);
  assert.match(page, /class="add">\+2</u);
  assert.match(page, /class="del">-1</u);
  assert.match(page, /<div class="l add">\+ one<\/div>/u);
});

test("the header counts only runs still standing", () => {
  const page = renderPage("p", [
    view({ run: run({ id: "r1" }), standing: true }),
    view({ run: run({ id: "r2" }), standing: false }),
    view({ run: run({ id: "r3", outcome: "escalated" }), standing: false }),
  ]);
  assert.match(page, /3 runs recorded &middot; 1 still standing/u);
});
