import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { add, parseAddArguments } from "../src/verbs/add.ts";
import { OperatorError } from "../src/verbs/io.ts";
import { parseFeatures } from "../src/features.ts";

async function project(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "harness-verbs-test-")));
  const directory = path.join(root, "project");
  await mkdir(directory, { recursive: true });
  return directory;
}

test("add refuses an item with no acceptance criteria", () => {
  // At the point of writing, not later. The moment the operator is
  // thinking about the item is the cheapest moment to make them say what
  // done means.
  assert.throws(
    () => parseAddArguments(["thing", "--title", "A thing"]),
    (error: unknown) => error instanceof OperatorError && /acceptance criterion/u.test(error.message),
  );
});

test("add refuses an item with no title, and an unknown option", () => {
  assert.throws(() => parseAddArguments(["thing", "--criterion", "x"]), OperatorError);
  assert.throws(() => parseAddArguments(["thing", "--title", "T", "--criterion", "x", "--oops"]), OperatorError);
});

test("add refuses a priority that is not MoSCoW, and names the allowed ones", () => {
  assert.throws(
    () => parseAddArguments(["t", "--title", "T", "--criterion", "c", "--priority", "urgent"]),
    (error: unknown) => error instanceof OperatorError && /must, should, could, wont/u.test(error.remedy),
  );
});

test("add accepts repeated criteria and dependencies", () => {
  const parsed = parseAddArguments([
    "entry", "--title", "Detail page",
    "--criterion", "navigation is exact",
    "--criterion", "the page matches its renderer",
    "--priority", "should",
    "--depends-on", "log-index",
  ]);
  assert.deepEqual(parsed.criteria, ["navigation is exact", "the page matches its renderer"]);
  assert.deepEqual(parsed.dependsOn, ["log-index"]);
  assert.equal(parsed.priority, "should");
});

test("add writes a list the harness can read back", async () => {
  // Written through the same parser that reads it, so an item can never
  // be written that the harness would then refuse to load.
  const directory = await project();
  try {
    await add(directory, ["one", "--title", "First", "--criterion", "it works"]);
    await add(directory, ["two", "--title", "Second", "--criterion", "it also works", "--depends-on", "one"]);
    const list = parseFeatures(await readFile(path.join(directory, "features.json"), "utf8"));
    assert.equal(list.ok, true);
    if (list.ok) {
      assert.deepEqual(list.features.map((f) => f.id), ["one", "two"]);
      assert.equal(list.features[0]!.status, "todo");
    }
  } finally {
    await rm(path.dirname(directory), { recursive: true, force: true });
  }
});

test("add refuses a duplicate id rather than shadowing the first", async () => {
  const directory = await project();
  try {
    await add(directory, ["one", "--title", "First", "--criterion", "it works"]);
    await assert.rejects(
      () => add(directory, ["one", "--title", "Again", "--criterion", "x"]),
      (error: unknown) => error instanceof OperatorError && /Already in the feature list/u.test(error.message),
    );
  } finally {
    await rm(path.dirname(directory), { recursive: true, force: true });
  }
});

test("add refuses to touch a feature list it cannot parse", async () => {
  // Otherwise the append silently discards whatever was there.
  const directory = await project();
  try {
    await writeFile(path.join(directory, "features.json"), "{ broken", "utf8");
    await assert.rejects(() => add(directory, ["one", "--title", "T", "--criterion", "c"]), OperatorError);
    assert.equal(await readFile(path.join(directory, "features.json"), "utf8"), "{ broken");
  } finally {
    await rm(path.dirname(directory), { recursive: true, force: true });
  }
});

test("work steps over an item whose last run changed nothing", async () => {
  // Left in the queue, `work` hands the model an item it has already
  // satisfied, and a model asked to do something finds something cosmetic
  // to do. Watched happen on a real project: a number wrapped in
  // <strong>, which the Reviewer escalated.
  const { chooseNext, parseFeatures: parse } = await import("../src/features.ts");
  const list = parse(JSON.stringify([
    { id: "settled", title: "S", priority: "must", status: "todo", criteria: ["c"], dependsOn: [] },
    { id: "pending", title: "P", priority: "should", status: "todo", criteria: ["c"], dependsOn: [] },
  ]));
  assert.equal(list.ok, true);
  if (!list.ok) return;

  const stepped = chooseNext(list.features, (id) => (id === "settled" ? "no-changes" : undefined));
  assert.equal(stepped.next?.id, "pending", "the settled item was offered again");
  assert.deepEqual(stepped.steppedOver.map((f) => f.id), ["settled"]);

  // And it is only stepped over for that outcome. A run that failed a
  // gate must still be retried, or one bad attempt retires the item.
  const failed = chooseNext(list.features, (id) => (id === "settled" ? "gate-failed" : undefined));
  assert.equal(failed.next?.id, "settled");
  assert.deepEqual(failed.steppedOver, []);
});

test("proposed items import without being retyped", async () => {
  // The model proposes; the operator runs the command that accepts. The
  // model still never writes features.json.
  const directory = await project();
  try {
    const proposal = path.join(path.dirname(directory), "items.json");
    await writeFile(proposal, JSON.stringify([
      { id: "router", title: "Command router", priority: "must", criteria: ["--help exits zero"] },
      { id: "store", title: "Storage", priority: "should", criteria: ["notes round-trip"], dependsOn: ["router"] },
    ]), "utf8");

    await add(directory, ["--from", proposal]);
    const list = parseFeatures(await readFile(path.join(directory, "features.json"), "utf8"));
    assert.equal(list.ok, true);
    if (!list.ok) return;
    assert.deepEqual(list.features.map((f) => f.id), ["router", "store"]);
    assert.deepEqual(list.features[1]!.dependsOn, ["router"]);
  } finally {
    await rm(path.dirname(directory), { recursive: true, force: true });
  }
});

test("a proposed status is discarded, never trusted", async () => {
  // Status is the harness's own verdict, reached through the gates and
  // the reviewer. A model that could import an item as already done would
  // be marking its own homework before doing it.
  const directory = await project();
  try {
    const proposal = path.join(path.dirname(directory), "items.json");
    await writeFile(proposal, JSON.stringify([
      { id: "sneaky", title: "T", priority: "must", status: "done", criteria: ["c"] },
    ]), "utf8");
    await add(directory, ["--from", proposal]);
    const list = parseFeatures(await readFile(path.join(directory, "features.json"), "utf8"));
    assert.equal(list.ok, true);
    if (list.ok) assert.equal(list.features[0]!.status, "todo");
  } finally {
    await rm(path.dirname(directory), { recursive: true, force: true });
  }
});

test("an import that clashes with an existing id writes nothing at all", async () => {
  // Partial import would leave a backlog that matches neither the
  // proposal nor what was there before.
  const directory = await project();
  try {
    await add(directory, ["router", "--title", "Router", "--criterion", "c"]);
    const proposal = path.join(path.dirname(directory), "items.json");
    await writeFile(proposal, JSON.stringify([
      { id: "fresh", title: "New", priority: "must", criteria: ["c"] },
      { id: "router", title: "Clash", priority: "must", criteria: ["c"] },
    ]), "utf8");

    await assert.rejects(() => add(directory, ["--from", proposal]), OperatorError);
    const list = parseFeatures(await readFile(path.join(directory, "features.json"), "utf8"));
    assert.equal(list.ok, true);
    if (list.ok) assert.deepEqual(list.features.map((f) => f.id), ["router"], "a clash imported part of the file");
  } finally {
    await rm(path.dirname(directory), { recursive: true, force: true });
  }
});

test("a malformed proposal is refused with the reason", async () => {
  const directory = await project();
  try {
    const proposal = path.join(path.dirname(directory), "items.json");
    for (const [content, expected] of [
      ["{ not json", /not valid JSON/u],
      ["{}", /must be an array/u],
      ["[]", /proposes no items/u],
      ['[{"id":"a","title":"T","priority":"must"}]', /acceptance criterion/u],
      ['[{"id":"a","title":"T","priority":"urgent","criteria":["c"]}]', /priority/u],
    ] as const) {
      await writeFile(proposal, content, "utf8");
      await assert.rejects(
        () => add(directory, ["--from", proposal]),
        (error: unknown) => error instanceof OperatorError && expected.test(error.message),
        `${content} was accepted`,
      );
    }
  } finally {
    await rm(path.dirname(directory), { recursive: true, force: true });
  }
});

test("shared input changes need an explicit assignment kind", () => {
  assert.equal(parseAddArguments(["deps", "--title", "Update dependencies", "--criterion", "lock installs offline", "--shared-inputs"]).kind, "shared-inputs");
  const result = parseFeatures(JSON.stringify([{ id: "deps", title: "Update dependencies", criteria: ["works"], status: "todo", priority: "must", kind: "unexpected" }]));
  assert.equal(result.ok, false);
});

test("add accepts explicit team role, change scope and contract references", () => {
  const result = parseAddArguments(["api", "--title", "API", "--criterion", "works", "--role", "backend", "--scope", "src/**", "--scope", "test/**", "--contract", "api-v1"]);
  assert.equal(result.assignedRole, "backend");
  assert.deepEqual(result.changeScope, ["src/**", "test/**"]);
  assert.deepEqual(result.contracts, ["api-v1"]);
});
