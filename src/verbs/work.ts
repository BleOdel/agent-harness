/**
 *   harness work <goal>
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
import { runAgent } from "../agent/pi.ts";
import { diagnose } from "../attribution.ts";
import { ConfigError, loadConfig, setting } from "../config.ts";
import { OperatorError, say } from "./io.ts";
import { type SandboxLayout } from "../containment/sandbox.ts";
import { CLAIM_FILE } from "../gates/claim.ts";
import { counterPath } from "../gates/tests.ts";
import { DEFAULT_LIMITS, type Limits } from "../gates/limits.ts";
import { chooseNext, type Feature, markDone, readFeatures, unmetDependencies } from "../features.ts";
import { listSkills } from "../agent/skills.ts";
import { runPipeline } from "../pipeline.ts";
import { appendRun, nextRunId, type Outcome, readRecord, recoveryPath, type RunRecord } from "../record/record.ts";
import { renderDiff } from "../review/diff.ts";
import { review } from "../review/reviewer.ts";
import {
  assertChangesAreApplicable,
  BoundaryViolation,
} from "../workspace/changes.ts";
import {
  applyChanges,
  createSandbox,
  destroySandbox,
  snapshotForRecovery,
} from "../workspace/sandbox-lifecycle.ts";

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
  if (list === undefined) {
    if (argument === "") {
      throw new OperatorError(
        "Nothing to work on: there is no feature list and no goal was given.",
        `Add an item with:  harness add <id> --title "..." --criterion "..."\n`
        + 'Or work from a goal:  harness work "add a --json flag"',
      );
    }
    return { title: argument, criteria: [], feature: undefined };
  }
  if (!list.ok) throw new OperatorError(list.reason, "Fix the feature list, or delete it to work from a free-form goal.");

  if (argument === "") {
    // The bare verb takes the next Must. This is the whole point of a
    // MoSCoW list: the operator should not have to decide what is next
    // every single time, and the list already says.
    //
    // An item whose last run changed nothing is stepped over rather than
    // offered again. Left in, `work` hands the model an item it has
    // already satisfied, and the model -- asked to do something -- finds
    // something cosmetic to do. Watched happen on a real project: a
    // number wrapped in <strong>, which the Reviewer then escalated.
    const { runs } = await readRecord(project);
    const { next, steppedOver } = chooseNext(list.features, (id) =>
      runs.filter((run) => run.goal === id).at(-1)?.outcome);
    if (next === undefined) {
      const idle = steppedOver;
      throw new OperatorError(
        idle.length === 0
          ? "Nothing left to work on: every item is done, blocked, or a won't-have."
          : `Nothing left to work on. ${idle.map((f) => f.id).join(", ")} produced no changes `
            + "last time, so they are being stepped over.",
        idle.length === 0
          ? "Run `harness look` to see the list."
          : "An item that changes nothing is usually already satisfied, or its criteria do not\n"
            + "say anything the code does not already do. Check it with `harness look`, then\n"
            + "either sharpen the criteria or edit its status to \"done\" in features.json.",
      );
    }
    say(`taking the next ${next.priority}: ${next.id}`);
    return { title: `${next.id}: ${next.title}`, criteria: next.criteria, feature: next };
  }

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

export async function work(argv: readonly string[]): Promise<void> {
  const goal = argv.join(" ").trim();

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) throw new OperatorError(error.message, error.remedy);
    throw error;
  }

  const project = path.resolve(setting(process.env, "HARNESS_PROJECT") ?? process.cwd());
  const testCommand = (setting(process.env, "HARNESS_TEST_COMMAND") ?? "npm test")
    .split(" ")
    .filter(Boolean);
  const counterSource = await readFile(counterPath(), "utf8");

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
    ...(config.skillsDirectory === undefined ? {} : { skillsDirectory: config.skillsDirectory }),
    user: `${String(process.getuid?.() ?? 501)}:${String(process.getgid?.() ?? 20)}`,
  };
  if (config.skillsDirectory !== undefined) {
    // Named, not implied. Instructions reaching the model from outside the
    // project are exactly the thing an operator should never discover by
    // reading the source.
    const loaded = await listSkills(config.skillsDirectory);
    say(`skills: ${loaded.length === 0 ? "none found in " + config.skillsDirectory : loaded.join(", ")}`);
  }

  const runId = await nextRunId(project);

  /**
   * Stops the run and records why. Every ending is recorded, not just the
   * successful one: `look` exists to answer "what escalated and why", and
   * it can only answer that from endings that were written down.
   */
  // Returns the error rather than throwing it, so every call site reads
  // `throw await stop(...)`. An awaited `never` does not narrow control
  // flow in TypeScript, and the alternative was a file full of
  // unreachable-code errors hiding a real one.
  const stop = async (
    outcome: Outcome,
    summary: string,
    detail: string,
    extra: Partial<RunRecord> = {},
  ): Promise<OperatorError> => {
    await appendRun(project, {
      id: runId,
      at: new Date().toISOString(),
      project,
      goal: work.feature?.id ?? goal,
      attempts,
      outcome,
      gates: gateSummaries,
      changes: [],
      reason: summary,
      ...extra,
    });
    return new OperatorError(summary, detail);
  };

  let attempts = 0;
  let gateSummaries: string[] = [];

  try {
    let instruction = briefing(work.title, work.criteria);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      attempts = attempt;
      if (attempt > 1) say(`\nattempt ${String(attempt)}, with a diagnosis`);
      const agent = await runAgent(
        layout,
        {
          goal: instruction,
          provider: config.provider,
          model: config.model,
          timeoutMs: config.agentTimeoutMs,
          skills: config.skillsDirectory !== undefined,
        },
        (chunk) => process.stdout.write(chunk),
      );
      if (agent.timedOut) {
        throw await stop("error", `agent: timed out after ${String(Math.round(config.agentTimeoutMs / 1000))}s`, "");
      }
      if (agent.code !== 0) throw await stop("error", `agent: exited ${String(agent.code)}`, agent.stderr);

      const { run, changes } = await runPipeline({
        config,
        layout,
        project,
        testCommand,
        counterSource,
        limits: limitsFrom(process.env),
      });
      gateSummaries = run.verdicts.map((entry) => entry.summary);
      for (const verdict of run.verdicts) say(verdict.summary);
      for (const name of run.skipped) say(`${name}: not applicable to this project`);

      if (!run.passed) {
        const failure = run.firstFailure;
        if (failure?.kind === undefined) throw await stop("error", "a gate failed without saying why", "");
        const diagnosis = diagnose(failure.kind, failure.detail);
        if (attempt === 2) {
          throw await stop(
            "gate-failed",
            `${failure.name} gate: ${failure.summary}`,
            `${diagnosis.cause}\n\n${diagnosis.fix}\n\n${failure.detail}`,
          );
        }
        instruction = `${diagnosis.forAgent}\n\n---\n\nThe original goal:\n\n${briefing(work.title, work.criteria)}`;
        continue;
      }

      if (changes.length === 0) {
        await appendRun(project, {
          id: runId,
          at: new Date().toISOString(),
          project,
          goal: work.feature?.id ?? goal,
          attempts: attempt,
          outcome: "no-changes",
          gates: gateSummaries,
          changes: [],
        });
        say("no changes. nothing was applied.");
        return;
      }
      try {
        assertChangesAreApplicable(changes, sandbox.workDirectory);
      } catch (error) {
        if (error instanceof BoundaryViolation) {
          throw await stop("gate-failed", `boundary: ${error.message}`, "nothing was applied.");
        }
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
        throw await stop(
          "escalated",
          `review: ${verdict.failure}`,
          "nothing was applied. A reviewer that cannot answer is never a pass.",
          { review: { verdict: "escalate", findings: [verdict.failure] } },
        );
      }
      if (verdict.verdict === "escalate") {
        throw await stop(
          "escalated",
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
          { review: { verdict: "escalate", findings: [...verdict.unmet, ...verdict.unaccounted] } },
        );
      }
      say(`review: passed, ${String(work.criteria.length)} criteria accounted for`);

      await rm(path.join(sandbox.workDirectory, CLAIM_FILE), { force: true });
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
      if (work.feature !== undefined) await markDone(project, work.feature.id);
      for (const change of changes) say(`  ${change.kind.padEnd(8)} ${change.file}`);
      say(`applied as ${runId}. undo with: harness undo ${runId}`);
      say(`recovery: ${recovery.directory}`);
      return;
    }
  } finally {
    // Every path, including a crash. A sandbox that survives a failure is
    // a stale copy the operator will one day mistake for the project.
    await destroySandbox(sandbox);
  }
}
