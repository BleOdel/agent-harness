import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chooseNext, markDone, markStatus, nextItems, parseFeatures, type Feature } from "../src/features.ts";

const item = (id: string, dependsOn: string[] = [], status = "todo", priority = "must") =>
  ({ id, title: id, status, priority, dependsOn, criteria: ["works"] });
function parse(items: unknown[]): readonly Feature[] {
  const result = parseFeatures(JSON.stringify(items));
  assert.ok(result.ok, result.ok ? "" : result.reason);
  return result.features;
}

test("reverse-declared dependencies schedule the prerequisite, even at lower priority", () => {
  const features = parse([item("client", ["api"]), item("api", [], "todo", "should")]);
  assert.deepEqual(nextItems(features).map(f => f.id), ["api"]);
  assert.equal(chooseNext(features, () => undefined).next?.id, "api");
});

test("self-dependencies and cycles fail with a readable path", () => {
  for (const [items, expected] of [
    [[item("a", ["a"])], "a -> a"],
    [[item("a", ["b"]), item("b", ["c"]), item("c", ["a"])], "a -> b -> c -> a"],
  ] as const) {
    const result = parseFeatures(JSON.stringify(items));
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.reason.includes(expected), result.reason);
  }
});

test("a shared prerequisite is not a cycle", () => {
  assert.equal(parse([item("a", ["c"]), item("b", ["c"]), item("c")]).length, 3);
});

test("invalidated work is eligible for revalidation despite an old no-changes outcome", () => {
  const features = parse([item("api", [], "done"), item("client", ["api"], "needs-revalidation")]);
  assert.equal(chooseNext(features, () => "no-changes").next?.id, "client");
});

test("changing a prerequisite invalidates accepted descendants transitively without changing their code or criteria", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-dependencies-"));
  try {
    const file = path.join(root, "features.json");
    const items = [item("api", [], "done"), item("client", ["api"], "done"), item("app", ["client"], "done"), item("other", [], "done"), item("future", ["app"])];
    await writeFile(file, JSON.stringify(items));
    await writeFile(path.join(root, "client.js"), "keep this code");
    await markStatus(root, "api", "todo");
    let features = parseFeatures(await readFile(file, "utf8"));
    assert.ok(features.ok);
    assert.deepEqual(features.features.map(f => f.status), ["todo", "needs-revalidation", "needs-revalidation", "done", "todo"]);
    assert.deepEqual(features.features[1]?.criteria, ["works"]);
    assert.equal(await readFile(path.join(root, "client.js"), "utf8"), "keep this code");
    // Restoring the prerequisite does not claim its consumers were rechecked.
    await markStatus(root, "api", "done");
    features = parseFeatures(await readFile(file, "utf8"));
    assert.ok(features.ok);
    assert.equal(features.features[1]?.status, "needs-revalidation");
    assert.deepEqual(nextItems(features.features).map(f => f.id), ["client"]);
    // An accepted replacement also invalidates an already accepted consumer.
    await writeFile(file, JSON.stringify(items));
    await markDone(root, "api");
    features = parseFeatures(await readFile(file, "utf8"));
    assert.ok(features.ok);
    assert.equal(features.features[1]?.status, "needs-revalidation");
  } finally { await rm(root, { recursive: true, force: true }); }
});
