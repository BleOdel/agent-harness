import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkTestCollection,
  discoverTestFiles,
  expandCollected,
  resolveTestCommand,
} from "../src/gates/test-collection.ts";

/**
 * Every case here is the shape of a real defect from v1, where a test
 * file sat outside what `node --test test/*.test.js` collects and the
 * suite stayed green.
 */

async function projectWith(files: Record<string, string>): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "harness-collect-test-")));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.join(root, path.dirname(file)), { recursive: true });
    await writeFile(path.join(root, file), content, "utf8");
  }
  return root;
}

const SUITE = 'import test from "node:test";\ntest("t", () => {});\n';

test("a test at the repository root is reported as uncollected", async () => {
  // The v1 defect exactly: the runner globs test/*.test.js and never
  // looks at the root, so the file is green by never running.
  const root = await projectWith({ "test/ok.test.js": SUITE, "stray.test.js": SUITE });
  try {
    const verdict = await checkTestCollection(root, ["node", "--test", "test/*.test.js"]);
    assert.equal(verdict.passed, false);
    assert.equal(verdict.kind, "tests-uncollected");
    assert.match(verdict.detail, /stray\.test\.js/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a test in a subdirectory is reported as uncollected", async () => {
  // node --test does not recurse through a single-star glob.
  const root = await projectWith({ "test/ok.test.js": SUITE, "test/unit/deep.test.js": SUITE });
  try {
    const verdict = await checkTestCollection(root, ["node", "--test", "test/*.test.js"]);
    assert.equal(verdict.passed, false);
    assert.match(verdict.detail, /test\/unit\/deep\.test\.js/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a project whose tests are all collected passes", async () => {
  // Keeps the failures above honest: a gate that refused everything would
  // pass both of them.
  const root = await projectWith({ "test/a.test.js": SUITE, "test/b.test.js": SUITE, "src/app.js": "" });
  try {
    const verdict = await checkTestCollection(root, ["node", "--test", "test/*.test.js"]);
    assert.equal(verdict.passed, true, verdict.detail);
    assert.match(verdict.summary, /all 2 test files are collected/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a recursive glob collects the subdirectory, so the same project passes", async () => {
  // Proves the gate is measuring the command rather than the layout.
  const root = await projectWith({ "test/ok.test.js": SUITE, "test/unit/deep.test.js": SUITE });
  try {
    const verdict = await checkTestCollection(root, ["node", "--test", "test/**/*.test.js"]);
    assert.equal(verdict.passed, true, verdict.detail);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a project with no test files fails rather than passing vacuously", async () => {
  const root = await projectWith({ "src/app.js": "" });
  try {
    const verdict = await checkTestCollection(root, ["node", "--test", "test/*.test.js"]);
    assert.equal(verdict.passed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("node_modules is not searched", async () => {
  // Otherwise every project with a dependency fails this gate forever.
  const root = await projectWith({
    "test/a.test.js": SUITE,
    "node_modules/pkg/thing.test.js": SUITE,
  });
  try {
    assert.deepEqual(await discoverTestFiles(root), ["test/a.test.js"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("npm test is resolved to the command package.json actually runs", async () => {
  // Without this the gate expands "npm" and "test", which match nothing,
  // and every project using npm test passes vacuously.
  const root = await projectWith({ "test/a.test.js": SUITE });
  try {
    const resolved = await resolveTestCommand(root, ["npm", "test"], async () => "node --test test/*.test.js");
    assert.deepEqual(resolved, ["node", "--test", "test/*.test.js"]);
    assert.deepEqual(await expandCollected(root, resolved), ["test/a.test.js"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
