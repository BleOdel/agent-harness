import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { run } from "../src/run.ts";

/**
 * The assertion counter decides whether a passing suite counts as
 * verification, so a counter that silently counts nothing would turn the
 * strongest gate into the weakest. These run it for real -- against the
 * node process, not a model of it -- because the failure mode is
 * precisely "it looked installed and observed nothing".
 */

const COUNTER = path.join(import.meta.dirname, "..", "src", "gates", "assert-counter.mjs");

/**
 * Runs a real suite under the counter and returns both the count and the
 * runner's exit code. The code is returned rather than ignored: the first
 * version of this helper wrote ESM into a directory with no package.json,
 * so every fixture failed to parse and every count was zero -- including
 * the one asserting zero, which passed for entirely the wrong reason.
 */
async function countFor(testBody: string): Promise<{ counted: number; code: number | null; ran: boolean }> {
  // NODE_TEST_CONTEXT is how Node's runner recognises that it is already
  // inside a test. Left set, the fixture run prints "skipping running
  // files" and exits 0 without running anything -- a green result meaning
  // nothing happened, which is the exact failure this whole file exists
  // to detect. Removed here, and every caller checks that a test really
  // reported so the deception cannot recur silently.
  const { NODE_TEST_CONTEXT: _ignored, ...environment } = process.env;
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "harness-counter-test-")));
  try {
    await mkdir(path.join(root, "test"), { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "counter-fixture", private: true, type: "module" }),
      "utf8",
    );
    await writeFile(path.join(root, "test", "subject.test.js"), testBody, "utf8");
    const countFile = path.join(root, "count");
    await writeFile(countFile, "", "utf8");
    const result = await run(process.execPath, ["--test", path.join(root, "test", "subject.test.js")], {
      timeoutMs: 60_000,
      env: {
        ...environment,
        NODE_OPTIONS: `--import=${COUNTER}`,
        HARNESS_ASSERT_COUNT_FILE: countFile,
      },
    });
    const raw = await readFile(countFile, "utf8");
    return {
      counted: raw.split("\n").reduce((total, line) => total + (Number(line.trim()) || 0), 0),
      code: result.code,
      ran: /^. pass 1$/mu.test(result.stdout),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("assertions that run are counted", async () => {
  const { counted, code, ran } = await countFor([
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'test("verifies", () => { assert.equal(1, 1); assert.ok(true); });',
  ].join("\n"));
  assert.equal(code, 0);
  assert.ok(ran, "the fixture suite reported no passing test, so the count below means nothing");
  // Exactly two: node:assert/strict and assert.strict are the same object,
  // and wrapping it twice would report four for a suite that made two
  // calls -- a gate reporting more verification than happened.
  assert.equal(counted, 2);
});

test("a passing suite that asserts nothing counts zero", async () => {
  // The case the gate exists for. This suite passes every runner.
  const { counted, code, ran } = await countFor([
    'import test from "node:test";',
    'test("proves nothing", () => { const x = 1 + 1; if (x === 3) throw new Error("unreachable"); });',
  ].join("\n"));
  assert.equal(code, 0);
  assert.ok(ran, "the point is that this suite passes; a zero count from a suite that never ran proves nothing");
  assert.equal(counted, 0);
});

test("assertions are counted through the plain assert module too", async () => {
  const { counted, code, ran } = await countFor([
    'import test from "node:test";',
    'import assert from "node:assert";',
    'test("verifies", () => { assert.strictEqual(2, 2); });',
  ].join("\n"));
  assert.equal(code, 0);
  assert.ok(ran, "the fixture suite reported no passing test, so the count below means nothing");
  assert.equal(counted, 1);
});

test("the counter file is where the gate looks for it", async () => {
  // Moving the command into src/verbs/ broke a path built from the
  // caller's directory, and nothing caught it until a live run failed
  // with ENOENT. The gate that proves every change is worthless if the
  // harness cannot find the file that makes it work.
  const { counterPath } = await import("../src/gates/tests.ts");
  const source = await readFile(counterPath(), "utf8");
  assert.match(source, /HARNESS_ASSERT_COUNT_FILE/u);
});
