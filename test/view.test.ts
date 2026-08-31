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

test("the tree lists every run that touched a file, and files no run touched", async () => {
  // The question a diff cannot answer: what is this file now, and which
  // runs made it that way.
  const { collectTree } = await import("../src/view/files.ts");
  const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");

  const root = await mkdtemp(path.join(os.tmpdir(), "harness-tree-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "busy.js"), "export const a = 1;\n");
    await writeFile(path.join(root, "src", "quiet.js"), "export const b = 2;\n");
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "noise");

    const change = (file: string) => ({ file, kind: "modified" as const, symlink: false });
    const tree = await collectTree(root, [
      { ...run({ id: "r1" }), changes: [change("src/busy.js")] },
      { ...run({ id: "r2" }), changes: [change("src/busy.js")] },
      { ...run({ id: "r5" }), changes: [change("src/busy.js")] },
    ]);

    const busy = tree.files.find((f) => f.path === "src/busy.js");
    const quiet = tree.files.find((f) => f.path === "src/quiet.js");
    assert.deepEqual(busy?.touchedBy, ["r1", "r2", "r5"], "a file changed by three runs must list all three");
    assert.deepEqual(quiet?.touchedBy, [], "a file no run has touched is still listed");
    assert.match(quiet?.text ?? "", /export const b/u, "and still opens");
    assert.equal(tree.files.some((f) => f.path.startsWith("node_modules")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file too large to carry is listed with the reason, not hidden", async () => {
  // The page carries its own contents, so there is a ceiling. A tree that
  // hid what it could not embed would misdescribe the project rather than
  // the page.
  const { collectTree, MAX_FILE_BYTES } = await import("../src/view/files.ts");
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");

  const root = await mkdtemp(path.join(os.tmpdir(), "harness-tree-big-"));
  try {
    await writeFile(path.join(root, "huge.txt"), "x".repeat(MAX_FILE_BYTES + 1));
    await writeFile(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x0a]));
    const tree = await collectTree(root, []);
    assert.equal(tree.files.length, 2);
    assert.equal(tree.omitted, 2);
    assert.match(tree.files.find((f) => f.path === "huge.txt")?.note ?? "", /too large/u);
    assert.match(tree.files.find((f) => f.path === "logo.png")?.note ?? "", /Binary/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file contents are escaped in the page like everything else", async () => {
  const { renderPage: render } = await import("../src/view/render.ts");
  const page = render("p", [], {
    files: [{
      path: "x.js", directory: "", name: "x.js", bytes: 10,
      text: '<script>alert("x")</script>', note: undefined, touchedBy: ["r1"],
    }],
    omitted: 0,
  });
  assert.equal(page.includes('<script>alert'), false);
  assert.ok(page.includes("&lt;script&gt;"));
  assert.match(page, /href="#r1"/u, "a touching run is a link to its diff");
});

test("totals are shown when runs have been measured", async () => {
  const { renderPage: render } = await import("../src/view/render.ts");
  const usage = {
    model: "gpt-5.6-sol", input: 20_809, output: 2_086, cacheRead: 43_008,
    reasoning: 895, totalTokens: 65_903, costUsd: 0.1881, turns: 14,
  };
  const page = render("p", [
    view({ run: { ...run({ id: "r1" }), usage } }),
    view({ run: { ...run({ id: "r2" }), usage } }),
  ]);
  assert.match(page, /131,806/u, "tokens are summed across runs");
  assert.match(page, /\$0\.38/u);
  assert.match(page, /28 *</u, "turns are summed");
  assert.match(page, /67% cached/u, "measured against the whole prompt, not input alone");
});

test("a record with no usage shows no totals rather than zeroes", async () => {
  // Every run before usage capture existed carries none. A strip reading
  // "$0.00" over a real history is worse than no strip.
  const { renderPage: render } = await import("../src/view/render.ts");
  const page = render("p", [view(), view()]);
  assert.equal(page.includes('class="strip"'), false);
});

test("a partly measured record says how much it is not counting", async () => {
  const { renderPage: render } = await import("../src/view/render.ts");
  const usage = {
    model: "m", input: 100, output: 10, cacheRead: 0, reasoning: 0,
    totalTokens: 110, costUsd: 0.01, turns: 1,
  };
  const page = render("p", [
    view({ run: { ...run({ id: "r1" }), usage } }),
    view({ run: run({ id: "r2" }) }),
    view({ run: run({ id: "r3" }) }),
  ]);
  assert.match(page, /2 earlier runs were recorded before usage was captured/u);
});

test("the queue marks what is done and which item is next", async () => {
  // Which item is next is the one thing here a reader cannot work out
  // for themselves: MoSCoW order, minus what is done, minus anything
  // whose last run changed nothing.
  const { renderPage: render } = await import("../src/view/render.ts");
  const feature = (id: string, status: string, priority = "must") =>
    ({ id, title: id, priority, status, criteria: ["c"], dependsOn: [] }) as never;
  const page = render("p", [], { files: [], omitted: 0 }, false, [
    { feature: feature("built", "done"), state: "applied", next: false },
    { feature: feature("current", "todo"), state: "todo", next: true },
    { feature: feature("later", "todo", "should"), state: "todo", next: false },
  ]);
  assert.match(page, /class="dot done"/u);
  assert.match(page, /class="dot next"/u);
  assert.match(page, /class="is-next"/u);
  assert.match(page, /2 left/u, "done items are not counted as remaining");
});

test("a project with no feature list shows no queue", async () => {
  const { renderPage: render } = await import("../src/view/render.ts");
  const page = render("p", [], { files: [], omitted: 0 }, false, []);
  assert.equal(page.includes('class="queue"'), false);
});
