import assert from "node:assert/strict";
import test from "node:test";
import { nextItems, parseFeatures, unmetDependencies } from "../src/features.ts";

const item = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "a",
  title: "An item",
  priority: "must",
  status: "todo",
  criteria: ["it works"],
  ...overrides,
});

test("a well-formed list parses", () => {
  const result = parseFeatures(JSON.stringify([item(), item({ id: "b", dependsOn: ["a"] })]));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.features.map((f) => f.id), ["a", "b"]);
});

test("an item with no acceptance criteria is refused", () => {
  // An item with no criteria cannot be reviewed and cannot be finished,
  // so it is not a unit of work.
  for (const criteria of [[], undefined, [""], "it works"]) {
    const result = parseFeatures(JSON.stringify([item({ criteria })]));
    assert.equal(result.ok, false, `criteria ${JSON.stringify(criteria)} was accepted`);
    if (!result.ok) assert.match(result.reason, /acceptance criterion/u);
  }
});

test("a duplicate id is refused", () => {
  // Otherwise `work <id>` is ambiguous, and an ambiguous unit of work is
  // not a unit of work.
  const result = parseFeatures(JSON.stringify([item(), item()]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /appears more than once/u);
});

test("a dependency on an item that does not exist is refused", () => {
  const result = parseFeatures(JSON.stringify([item({ dependsOn: ["ghost"] })]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /depends on ghost/u);
});

test("a bad priority or status is refused with the allowed values", () => {
  for (const [field, value] of [["priority", "urgent"], ["status", "in-progress"]] as const) {
    const result = parseFeatures(JSON.stringify([item({ [field]: value })]));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, new RegExp(field, "u"));
  }
});

test("both the array form and the wrapped form parse", () => {
  const wrapped = parseFeatures(JSON.stringify({ features: [item()] }));
  assert.equal(wrapped.ok, true);
});

test("unmet dependencies are reported by id", () => {
  const result = parseFeatures(JSON.stringify([
    item({ id: "a", status: "todo" }),
    item({ id: "b", status: "done" }),
    item({ id: "c", dependsOn: ["a", "b"] }),
  ]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const c = result.features.find((f) => f.id === "c")!;
  assert.deepEqual(unmetDependencies(c, result.features), ["a"]);
});

test("next items are ordered by MoSCoW, and wont-haves are excluded", () => {
  const result = parseFeatures(JSON.stringify([
    item({ id: "c", priority: "could" }),
    item({ id: "w", priority: "wont" }),
    item({ id: "m", priority: "must" }),
    item({ id: "d", priority: "must", status: "done" }),
    item({ id: "s", priority: "should" }),
  ]));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(nextItems(result.features).map((f) => f.id), ["m", "s", "c"]);
});
