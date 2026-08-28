/**
 *   npm run work -- <goal>
 *
 * Copy the project, let the model work in the copy, prove the result,
 * apply it with a recovery snapshot, destroy the copy.
 *
 * Silent on success. Each gate prints one line; detail appears only when
 * one fails. v1 wrote a full passing test log into the transcript every
 * cycle, which is noise for the operator and context the model carries
 * for no benefit.
 *
 * On a gate failure the model gets one more attempt, and it is handed a
 * named diagnosis rather than a log. Attribution before recovery: a model
 * given a log fixes the most visible line in it, which is frequently not
 * the cause.
 */

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { runAgent } from "./agent/pi.ts";
import { diagnose } from "./attribution.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { type SandboxLayout } from "./containment/sandbox.ts";
import { CLAIM_FILE } from "./gates/claim.ts";
import { DEFAULT_LIMITS, type Limits } from "./gates/limits.ts";
import { runPipeline } from "./pipeline.ts";
import {
  assertChangesAreApplicable,
  BoundaryViolation,
} from "./workspace/changes.ts";
import {
  applyChanges,
  createSandbox,
  destroySandbox,
  snapshotForRecovery,
} from "./workspace/sandbox-lifecycle.ts";

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(summary: string, detail = ""): never {
  process.stderr.write(`\n${summary}\n`);
  if (detail.trim() !== "") process.stderr.write(`\n${detail.trimEnd()}\n`);
  process.exit(1);
}

/** Appended to the goal so the model knows what the gates will require. */
function briefing(goal: string): string {
  return [
    goal,
    "",
    "Before you finish, write " + CLAIM_FILE + " in the project root:",
    "",
    "{",
    '  "files": ["every file you created or modified, relative paths"],',
    '  "deletions": ["every file you deleted"],',
    '  "criteria": [{"criterion": "an acceptance criterion", "verifiedBy": "the file that verifies it"}]',
    "}",
    "",
    "It is checked against what actually changed, so it must be exact. It is",
    "not applied to the repository.",
  ].join("\n");
}

function limitsFrom(environment: NodeJS.ProcessEnv): Limits {
  const read = (name: string, fallback: number): number => {
    const value = Number(environment[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  };
  return {
    maxFiles: read("HARNESS_MAX_FILES", DEFAULT_LIMITS.maxFiles),
    maxLines: read("HARNESS_MAX_LINES", DEFAULT_LIMITS.maxLines),
  };
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
    let instruction = briefing(goal);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (attempt > 1) say(`\nattempt ${String(attempt)}, with a diagnosis`);
      const agent = await runAgent(
        layout,
        { goal: instruction, provider: config.provider, model: config.model, timeoutMs: config.agentTimeoutMs },
        (chunk) => process.stdout.write(chunk),
      );
      if (agent.timedOut) fail(`agent: timed out after ${String(Math.round(config.agentTimeoutMs / 1000))}s`);
      if (agent.code !== 0) fail(`agent: exited ${String(agent.code)}`, agent.stderr);

      const { run, changes } = await runPipeline({
        config,
        layout,
        project,
        testCommand,
        counterSource,
        limits: limitsFrom(process.env),
      });
      for (const verdict of run.verdicts) say(verdict.summary);
      for (const name of run.skipped) say(`${name}: not applicable to this project`);

      if (!run.passed) {
        const failure = run.firstFailure;
        if (failure?.kind === undefined) fail("a gate failed without saying why", "");
        const diagnosis = diagnose(failure.kind, failure.detail);
        if (attempt === 2) {
          fail("nothing was applied.", `${diagnosis.cause}\n\n${diagnosis.fix}\n\n${failure.detail}`);
        }
        instruction = `${diagnosis.forAgent}\n\n---\n\nThe original goal:\n\n${briefing(goal)}`;
        continue;
      }

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

      await rm(path.join(sandbox.workDirectory, CLAIM_FILE), { force: true });
      const recovery = await snapshotForRecovery(project, changes);
      await applyChanges(project, sandbox.workDirectory, changes);
      for (const change of changes) say(`  ${change.kind.padEnd(8)} ${change.file}`);
      say(`applied. recovery: ${recovery.directory}`);
      return;
    }
  } finally {
    // Every path, including a crash. A sandbox that survives a failure is
    // a stale copy the operator will one day mistake for the project.
    await destroySandbox(sandbox);
  }
}

await main();
