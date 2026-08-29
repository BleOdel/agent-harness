import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  allDeclared,
  declaredDependencies,
  missingFromDisk,
  missingInProject,
  newlyDeclared,
} from "../src/deps.ts";
import { buildAgentCommand } from "../src/agent/pi.ts";
import { buildReviewCommand } from "../src/review/reviewer.ts";

test("neither agent ever loads extensions", () => {
  // Pi discovers extensions from its own data directory, which this
  // harness mounts writable, and an extension can register tools and
  // flags. The harness said nothing either way, so whatever happened to
  // be installed would have reached every build with no line in the
  // output mentioning it.
  for (const command of [
    buildAgentCommand({ goal: "g", provider: undefined, model: undefined, timeoutMs: 1, skills: true }),
    buildAgentCommand({ goal: "g", provider: undefined, model: undefined, timeoutMs: 1, skills: false }),
    buildReviewCommand({ title: "t", criteria: ["c"], diff: "d", provider: undefined, model: undefined, timeoutMs: 1 }),
  ]) {
    assert.ok(command.includes("--no-extensions"), `missing --no-extensions in ${command.join(" ")}`);
    assert.equal(command.includes("--extension"), false);
  }
});

test("dependencies are read from both lists", () => {
  const declared = declaredDependencies(JSON.stringify({
    dependencies: { chalk: "^5" },
    devDependencies: { typescript: "^7", "@types/node": "^24" },
  }));
  assert.deepEqual(declared.runtime, ["chalk"]);
  assert.deepEqual(allDeclared(declared), ["@types/node", "chalk", "typescript"]);
});

test("a malformed package.json yields nothing rather than throwing", () => {
  // This runs immediately after an apply. Crashing there would leave the
  // operator with work applied and no idea what happened.
  assert.deepEqual(allDeclared(declaredDependencies("{ not json")), []);
});

test("what a change added is reported, what it removed is not", () => {
  const before = JSON.stringify({ dependencies: { chalk: "^5" } });
  const after = JSON.stringify({ dependencies: { chalk: "^5", zod: "^3" }, devDependencies: { vitest: "^2" } });
  assert.deepEqual(newlyDeclared(before, after), ["vitest", "zod"]);
  assert.deepEqual(newlyDeclared(after, before), [], "a removal is not a missing package");
});

test("scoped packages are found where they actually live", async () => {
  // @scope/name sits two directories deep. A naive readdir of
  // node_modules reports every scoped dependency as missing and sends the
  // operator to install packages they already have.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "harness-deps-")));
  try {
    await mkdir(path.join(root, "node_modules", "@types", "node"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "chalk"), { recursive: true });
    assert.deepEqual(
      await missingFromDisk(root, ["@types/node", "chalk", "zod"]),
      ["zod"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a project with no node_modules reports everything it declares", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "harness-deps-none-")));
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { chalk: "^5" }, devDependencies: { typescript: "^7" } }),
      "utf8",
    );
    assert.deepEqual(await missingInProject(root), ["chalk", "typescript"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a project declaring nothing is never reported as missing anything", async () => {
  // Every project built with this harness so far had zero dependencies.
  // A false report there would train the operator to ignore the warning.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "harness-deps-bare-")));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "bare" }), "utf8");
    assert.deepEqual(await missingInProject(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
