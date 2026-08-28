/**
 *   npm run work -- <goal>
 *
 * Copy the project, let the model work in the copy, prove the result,
 * apply it with a recovery snapshot, destroy the copy.
 *
 * Silent on success. The gate prints a verdict; detail appears only when
 * something failed. v1 wrote a full passing test log into the transcript
 * every cycle, which is noise for the operator and context the model
 * carries for no benefit.
 */

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { runAgent } from "./agent/pi.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { type SandboxLayout } from "./containment/sandbox.ts";
import { COUNTER_IN_COPY, runTestGate } from "./gates/tests.ts";
import {
  assertChangesAreApplicable,
  BoundaryViolation,
  collectChanges,
} from "./workspace/changes.ts";
import {
  applyChanges,
  createSandbox,
  destroySandbox,
  snapshotForRecovery,
} from "./workspace/sandbox-lifecycle.ts";

const COUNT_FILE = ".harness-assert-count";

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(summary: string, detail = ""): never {
  process.stderr.write(`\n${summary}\n`);
  if (detail.trim() !== "") process.stderr.write(`\n${detail.trimEnd()}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const goal = process.argv.slice(2).join(" ").trim();
  if (goal === "") {
    fail("Use: npm run work -- <goal>", 'Example: npm run work -- "add a --json flag to the report command"');
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message, error.remedy);
    throw error;
  }

  const project = path.resolve(process.env.HARNESS_PROJECT ?? process.cwd());
  const testCommand = (process.env.HARNESS_TEST_COMMAND ?? "npm test").split(" ").filter(Boolean);
  const counterSource = await readFile(
    path.join(import.meta.dirname, "gates", "assert-counter.mjs"),
    "utf8",
  );

  const sandbox = await createSandbox(project);
  // Printed before anything can go wrong with it, so a crash still leaves
  // the operator knowing where the run happened.
  say(`sandbox: ${sandbox.workDirectory}`);
  if (sandbox.withheld.length > 0) {
    // Said out loud: a test that needs one of these will fail the gate,
    // and the operator would otherwise have no way to connect the two.
    say(`withheld from the copy: ${sandbox.withheld.join(", ")}`);
  }

  const layout: SandboxLayout = {
    dockerExecutable: config.dockerExecutable,
    imageId: config.imageId,
    containerName: `harness-${String(process.pid)}`,
    workDirectory: sandbox.workDirectory,
    agentDirectory: config.agentDirectory,
    piPackageDirectory: config.piPackageDirectory,
    user: `${String(process.getuid?.() ?? 501)}:${String(process.getgid?.() ?? 20)}`,
  };

  try {
    const agent = await runAgent(
      layout,
      {
        goal,
        provider: config.provider,
        model: config.model,
        timeoutMs: config.agentTimeoutMs,
      },
      (chunk) => process.stdout.write(chunk),
    );
    if (agent.timedOut) {
      fail(`agent: timed out after ${String(Math.round(config.agentTimeoutMs / 1000))}s`);
    }
    if (agent.code !== 0) {
      fail(`agent: exited ${String(agent.code)}`, agent.stderr);
    }

    const gate = await runTestGate(layout, counterSource, testCommand, config.gateTimeoutMs);
    say(gate.summary);
    if (!gate.passed) fail("nothing was applied.", gate.detail);

    // The gate's own files never reach the operator's project.
    await rm(path.join(sandbox.workDirectory, COUNTER_IN_COPY), { force: true });
    await rm(path.join(sandbox.workDirectory, COUNT_FILE), { force: true });

    const changes = await collectChanges(project, sandbox.workDirectory);
    if (changes.length === 0) {
      say("no changes. nothing was applied.");
      return;
    }
    try {
      assertChangesAreApplicable(changes, sandbox.workDirectory);
    } catch (error) {
      if (error instanceof BoundaryViolation) fail(`boundary: ${error.message}`, "nothing was applied.");
      throw error;
    }
    say(`boundary: ${String(changes.length)} files, all inside the project`);

    const recovery = await snapshotForRecovery(project, changes);
    await applyChanges(project, sandbox.workDirectory, changes);
    for (const change of changes) say(`  ${change.kind.padEnd(8)} ${change.file}`);
    say(`applied. recovery: ${recovery.directory}`);
  } finally {
    // Every path, including a crash. A sandbox that survives a failure is
    // a stale copy the operator will one day mistake for the project.
    await destroySandbox(sandbox);
  }
}

await main();
