/**
 *   look
 *
 * What happened, what is pending, what escalated and why.
 *
 * The plan's verification for this milestone is an application built
 * start to finish by someone following nothing but this. So it has to
 * answer three questions without the operator asking a second one: what
 * should I do next, what went wrong, and can I put it back.
 *
 * Escalations first. They are the only thing here that is waiting on a
 * person, and burying them under a status table is how a queue of them
 * accumulates unread.
 */

import { listMl, readMlState } from "../ml/store.ts";
import { listJobs } from "../jobs/state.ts";
import { listArtifacts } from "../artifacts/store.ts";
import { readTeams, formatTeams } from "../view/status.ts";
import { readFeatures, chooseNext, unmetDependencies, type Feature } from "../features.ts";
import { readRecord, type RunRecord, undoableRuns } from "../record/record.ts";
import { localTime } from "../view/render.ts";
import { clip, pad, say } from "./io.ts";

export function stateOfItem(feature: Feature, runs: readonly RunRecord[]): string {
  if (["done", "blocked", "needs-revalidation"].includes(feature.status)) return feature.status;
  const last = runs.filter((run) => run.goal === feature.id).at(-1);
  if (last === undefined) return feature.status;
  // Whether that run is *still standing* matters. Reporting "applied" for
  // a run a later undo reversed describes a repository that no longer
  // exists, which is exactly the confusion the record exists to prevent.
  if (last.outcome === "applied") {
    return undoableRuns(runs).some((run) => run.id === last.id)
      ? "applied, not yet marked done"
      : "undone";
  }
  return last.outcome;
}

export async function look(project: string): Promise<void> {
  for (const ml of await listMl(project)) say(`ML ${ml.spec.title} · ${(await readMlState(project, ml.id)).status} · ${ml.id}`);
  const jobs = await listJobs(project);
  for (const job of jobs) say(`JOB ${job.spec.title} · ${job.status} · checkpoint ${job.completed ?? "none"} · cost unknown · ${job.id}`);
  const artifacts = await listArtifacts(project);
  if (artifacts.length) say(`${artifacts.length} retained artifacts. Inspect with harness artifacts list; nothing published.`);
  const teams = await readTeams(project);
  if (teams.length) { say("TEAMS"); say(formatTeams(teams)); say(); }
  const { runs, malformed } = await readRecord(project);
  const list = await readFeatures(project);

  if (malformed.length > 0) {
    say(`warning: ${String(malformed.length)} unreadable lines in the record (at ${malformed.join(", ")})`);
    say();
  }

  const escalations = runs.filter((run) => run.outcome === "escalated" || run.outcome === "gate-failed" || run.outcome === "blocked" || run.outcome === "environment-blocked");
  const stillOpen = escalations.filter(
    (run) => !runs.some((later) => later.goal === run.goal && later.outcome === "applied" && later.at > run.at),
  );

  if (stillOpen.length > 0) {
    say(`WAITING ON YOU (${String(stillOpen.length)})`);
    say();
    for (const run of stillOpen) {
      say(`  ${pad(run.id, 5)} ${clip(run.goal, 40)}`);
      say(`        ${run.reason ?? "(no reason recorded)"}`);
      if (run.acceptance) say(`        Acceptance evidence: ${run.acceptance.evidencePath}`);
      if (run.requestedInput !== undefined) say(`        Needed: ${run.requestedInput}`);
      for (const finding of run.review?.findings ?? []) say(`        - ${clip(finding, 90)}`);
      say();
    }
  }

  if (list === undefined) {
    say("No feature list in this project. Work from a goal, or add an item:");
    say('  harness add <id> --title "..." --criterion "..."');
  } else if (!list.ok) {
    say(`The feature list cannot be read: ${list.reason}`);
  } else {
    say("ITEMS");
    say();
    for (const feature of list.features) {
      const waiting = unmetDependencies(feature, list.features);
      say(`  ${pad(feature.priority, 7)} ${pad(feature.id, 16)} ${pad(stateOfItem(feature, runs), 28)} ${clip(feature.title, 44)}`);
      if (waiting.length > 0) say(`          waiting for: ${waiting.join(", ")}`);
    }
    say();
    const { next, waiting, steppedOver } = chooseNext(list.features, (id) =>
      runs.filter((run) => run.goal === id).at(-1)?.outcome);
    say(next === undefined
      ? waiting.length > 0 || list.features.some((f) => f.status === "blocked" && f.priority !== "wont")
        ? "Work is waiting on prerequisites or operator input."
        : steppedOver.length > 0 ? "No eligible work: previous no-change items are being stepped over." : "Nothing left to work on."
      : `Next: ${next.id}.  Start it with: harness work`);
    say();
  }

  const applied = undoableRuns(runs);
  // What it has cost, when the record knows. Silence rather than a zero
  // for runs made before usage was captured: a total that quietly omits
  // half the history is worse than no total.
  const measured = runs.filter((run) => run.usage !== undefined);
  const spent = measured.reduce((total, run) => total + (run.usage?.costUsd ?? 0), 0);
  const tokens = measured.reduce((total, run) => total + (run.usage?.totalTokens ?? 0), 0);
  say(`HISTORY  ${String(runs.length)} runs, ${String(applied.length)} still standing`
    + (measured.length === 0
      ? ""
      : `  ·  ${tokens.toLocaleString("en-GB")} tokens, $${spent.toFixed(2)}`
      + (measured.length === runs.length ? "" : ` across ${String(measured.length)} measured`)));
  say();
  for (const run of runs.slice(-8)) {
    const marker = run.outcome === "applied" ? "+" : run.outcome === "no-changes" ? "=" : "!";
    say(`  ${marker} ${pad(run.id, 5)} ${localTime(run.at)}  ${pad(run.outcome, 12)} ${clip(run.goal, 44)}`);
  }
  if (runs.length > 8) say(`  ... ${String(runs.length - 8)} earlier runs`);
  say();
  say("  harness show <id>   the exact diff        harness undo <id>   put it back");
}
