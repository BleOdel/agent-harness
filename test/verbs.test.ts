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
      (error: unknown) => error instanceof OperatorError && /already in the feature list/u.test(error.message),
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
