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
import { type Feature, readFeatures, unmetDependencies } from "./features.ts";
import { runPipeline } from "./pipeline.ts";
import { appendRun, nextRunId, type Outcome, recoveryPath } from "./record/record.ts";
import { renderDiff } from "./review/diff.ts";
import { review } from "./review/reviewer.ts";
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

/**
 * The work item, if the argument names one in the project's feature list.
 *
 * A free-form goal still works. It just gives the Reviewer nothing exact
 * to check against, and the run says so rather than reviewing against
 * criteria it invented.
 */
async function resolveWork(project: string, argument: string): Promise<{
  title: string;
  criteria: readonly string[];
  feature: Feature | undefined;
}> {
  const list = await readFeatures(project);
  if (list === undefined) return { title: argument, criteria: [], feature: undefined };
  if (!list.ok) fail(list.reason, "Fix the feature list, or delete it to work from a free-form goal.");

  const feature = list.features.find((entry) => entry.id === argument);
  if (feature === undefined) {
    // Not an error: the operator may be describing work that has no item.
    return { title: argument, criteria: [], feature: undefined };
  }
  const unmet = unmetDependencies(feature, list.features);
  if (unmet.length > 0) {
    // Reported, not enforced. The operator may know something the list
    // does not; what they must not do is find out afterwards.
    say(`note: ${feature.id} depends on ${unmet.join(", ")}, which are not done`);
  }
  return { title: `${feature.id}: ${feature.title}`, criteria: feature.criteria, feature };
}

/** Appended to the goal so the model knows what the gates will require. */
function briefing(goal: string, criteria: readonly string[]): string {
  return [
    goal,
    ...(criteria.length === 0
      ? []
      : ["", "Acceptance criteria, all of which must be satisfied:",
         ...criteria.map((criterion, index) => `  ${String(index + 1)}. ${criterion}`)]),
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
    fail(
      "Use: npm run work -- <item-id or goal>",
      'Example: npm run work -- entry-page\n         npm run work -- "add a --json flag to the report command"',
    );
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

  const work = await resolveWork(project, goal);
  if (work.feature !== undefined) say(`item: ${work.title}`);

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
    let instruction = briefing(work.title, work.criteria);
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
        instruction = `${diagnosis.forAgent}\n\n---\n\nThe original goal:\n\n${briefing(work.title, work.criteria)}`;
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

      // The last gate, and the only one about intent. Everything before
      // it asks whether the code is sound; this asks whether it is the
      // work that was asked for.
      const verdict = await review(layout, {
        title: work.title,
        criteria: work.criteria.length > 0
          ? work.criteria
          // Without a feature list there is nothing exact to check
          // against. Said out loud, because a Reviewer silently inventing
          // its own criteria is a Reviewer nobody can calibrate.
          : ["(no feature list: judge only whether the change is coherent and self-consistent)"],
        diff: await renderDiff(project, sandbox.workDirectory, changes),
        provider: config.provider,
        model: config.model,
        timeoutMs: config.agentTimeoutMs,
      });
      if (verdict.failure !== undefined) {
        fail(`review: ${verdict.failure}`, "nothing was applied. A reviewer that cannot answer is never a pass.");
      }
      if (verdict.verdict === "escalate") {
        fail(
          "review: escalated to you.",
          [
            ...(verdict.unmet.length === 0 ? [] : ["Acceptance criteria the reviewer could not find satisfied:",
              ...verdict.unmet.map((entry) => `  - ${entry}`), ""]),
            ...(verdict.unaccounted.length === 0 ? [] : ["In the change, but nothing asked for it:",
              ...verdict.unaccounted.map((entry) => `  - ${entry}`), ""]),
            ...(verdict.notes.length === 0 ? [] : ["Notes:", ...verdict.notes.map((entry) => `  - ${entry}`), ""]),
            `Nothing was applied. The work is in ${sandbox.workDirectory}, which is about to be destroyed;`,
            "re-run to try again, or narrow the item.",
          ].join("\n"),
        );
      }
      say(`review: passed, ${String(work.criteria.length)} criteria accounted for`);

      await rm(path.join(sandbox.workDirectory, CLAIM_FILE), { force: true });
      const runId = await nextRunId(project);
      const recovery = await snapshotForRecovery(
        project,
        sandbox.workDirectory,
        changes,
        recoveryPath(project, runId),
      );
      await applyChanges(project, sandbox.workDirectory, changes);
      await appendRun(project, {
        id: runId,
        at: new Date().toISOString(),
        project,
        goal: work.feature?.id ?? goal,
        attempts: attempt,
        outcome: "applied",
        gates: run.verdicts.map((entry) => entry.summary),
        review: { verdict: verdict.verdict, findings: [...verdict.unmet, ...verdict.unaccounted] },
        changes,
      });
      for (const change of changes) say(`  ${change.kind.padEnd(8)} ${change.file}`);
      say(`applied as ${runId}. undo with: npm run undo -- ${runId}`);
      say(`recovery: ${recovery.directory}`);
      return;
    }
  } finally {
    // Every path, including a crash. A sandbox that survives a failure is
    // a stale copy the operator will one day mistake for the project.
    await destroySandbox(sandbox);
  }
}

await main();
