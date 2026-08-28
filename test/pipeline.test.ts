import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { CLAIM_FILE } from "../src/gates/claim.ts";
import type { SandboxLayout } from "../src/containment/sandbox.ts";
import { runPipeline } from "../src/pipeline.ts";
import { createSandbox, destroySandbox } from "../src/workspace/sandbox-lifecycle.ts";

/**
 * The plan's M2 verification: break each gate deliberately and confirm it
 * stops the apply.
 *
 * These run against a real Docker daemon, deliberately. A gate that only
 * works against a fake container is a gate whose failure mode is exactly
 * the thing being tested. When the daemon or the image is absent these
 * are skipped by name -- never silently, and never as passes.
 */

const CONFIGURED =
  process.env.HARNESS_IMAGE_ID !== undefined
  && process.env.HARNESS_PI_PACKAGE !== undefined
  && process.env.HARNESS_AGENT_DIR !== undefined;

const SUITE = [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  'import { add } from "../src/add.js";',
  'test("adds", () => { assert.equal(add(1, 2), 3); });',
].join("\n");

// Declares exactly what the fixture changes and nothing more. The first
// version named src/add.js, which the project already contained
// unmodified, and the claim gate correctly refused it -- "declared but not
// changed" is a claim describing work that did not happen.
const CLAIM = JSON.stringify({
  files: ["test/add.test.js"],
  deletions: [],
  criteria: [{ criterion: "add returns the sum", verifiedBy: "test/add.test.js" }],
});

/**
 * Builds a project, then applies one deliberate mutation to the copy --
 * standing in for what a model might produce -- and runs the gates.
 */
async function gateRun(mutate: (work: string) => Promise<void>): Promise<{
  passed: boolean;
  failure: string | undefined;
  kind: string | undefined;
}> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "harness-pipeline-test-")));
  const project = path.join(root, "project");
  await mkdir(path.join(project, "test"), { recursive: true });
  await mkdir(path.join(project, "src"), { recursive: true });
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({ name: "subject", private: true, type: "module", scripts: { test: "node --test test/*.test.js" } }),
  );
  await writeFile(path.join(project, "src", "add.js"), "export const add = (a, b) => a + b;\n");

  const sandbox = await createSandbox(project);
  try {
    // Everything a passing run would have produced, before the mutation.
    await writeFile(path.join(sandbox.workDirectory, "test", "add.test.js"), SUITE);
    await writeFile(path.join(sandbox.workDirectory, CLAIM_FILE), CLAIM);
    await mutate(sandbox.workDirectory);

    const config = loadConfig();
    const layout: SandboxLayout = {
      dockerExecutable: config.dockerExecutable,
      imageId: config.imageId,
      containerName: `harness-pipeline-test-${String(process.pid)}-${String(Math.random()).slice(2, 8)}`,
      workDirectory: sandbox.workDirectory,
      agentDirectory: config.agentDirectory,
      piPackageDirectory: config.piPackageDirectory,
      user: `${String(process.getuid?.() ?? 501)}:${String(process.getgid?.() ?? 20)}`,
    };
    const counterSource = await readFile(
      path.join(import.meta.dirname, "..", "src", "gates", "assert-counter.mjs"),
      "utf8",
    );
    const { run } = await runPipeline({
      config,
      layout,
      project,
      testCommand: ["npm", "test"],
      counterSource,
      limits: { maxFiles: 40, maxLines: 4_000 },
    });
    return { passed: run.passed, failure: run.firstFailure?.summary, kind: run.firstFailure?.kind };
  } finally {
    await destroySandbox(sandbox);
    await rm(root, { recursive: true, force: true });
  }
}

test(
  "the gates pass an honest change, and each deliberate break stops it",
  { skip: CONFIGURED ? false : "set HARNESS_IMAGE_ID, HARNESS_PI_PACKAGE and HARNESS_AGENT_DIR to run" },
  async (t) => {
    await t.test("an honest change passes every gate", async () => {
      const result = await gateRun(async () => {});
      assert.equal(result.passed, true, `unexpectedly failed at: ${result.failure ?? "?"}`);
    });

    await t.test("broken code fails the tests gate", async () => {
      const result = await gateRun(async (work) => {
        await writeFile(path.join(work, "src", "add.js"), "export const add = (a, b) => a - b;\n");
      });
      assert.equal(result.passed, false);
      assert.equal(result.kind, "tests-failed");
    });

    await t.test("a suite with the assertions removed fails, though it passes", async () => {
      await gateRun(async (work) => {
        await writeFile(
          path.join(work, "test", "add.test.js"),
          'import test from "node:test";\ntest("adds", () => {});\n',
        );
      }).then((result) => {
        assert.equal(result.passed, false);
        assert.equal(result.kind, "tests-proved-nothing");
      });
    });

    await t.test("a test the runner never collects fails, though the suite is green", async () => {
      // The v1 defect that hid another defect behind it.
      const result = await gateRun(async (work) => {
        await writeFile(path.join(work, "stray.test.js"), SUITE.replace("../src", "./src"));
      });
      assert.equal(result.passed, false);
      assert.equal(result.kind, "tests-uncollected");
    });

    await t.test("an undeclared change fails the claim gate", async () => {
      const result = await gateRun(async (work) => {
        await writeFile(path.join(work, "src", "extra.js"), "export const extra = 1;\n");
      });
      assert.equal(result.passed, false);
      assert.equal(result.kind, "claim-mismatch");
    });

    await t.test("a missing claim fails rather than passing quietly", async () => {
      const result = await gateRun(async (work) => {
        await rm(path.join(work, CLAIM_FILE));
      });
      assert.equal(result.passed, false);
      assert.equal(result.kind, "claim-missing");
    });

    await t.test("a build that changes committed files fails", async () => {
      // Generated artefacts that drifted from their sources. Invisible to
      // every test that reads the source instead of the artefact.
      const result = await gateRun(async (work) => {
        const manifest = JSON.parse(await readFile(path.join(work, "package.json"), "utf8")) as {
          scripts: Record<string, string>;
        };
        manifest.scripts.build = "node -e \"require('fs').writeFileSync('src/add.js', 'export const add = (a, b) => a + b; // regenerated\\n')\"";
        await writeFile(path.join(work, "package.json"), JSON.stringify(manifest));
        await writeFile(path.join(work, CLAIM_FILE), JSON.stringify({
          files: ["test/add.test.js", "package.json"],
          deletions: [],
          criteria: [{ criterion: "add returns the sum", verifiedBy: "test/add.test.js" }],
        }));
      });
      assert.equal(result.passed, false);
      assert.equal(result.kind, "build-not-reproducible");
    });
  },
);
