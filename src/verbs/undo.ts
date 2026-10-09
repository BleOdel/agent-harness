import {beginApplication,finishApplication} from '../workspace/application.ts';
import {captureBaseline,copySource} from '../workspace/candidate.ts';
import {applicationFeatures} from '../features.ts';
import {runSnapshotPath} from '../record/record.ts';
import {mkdtemp,readFile} from 'node:fs/promises';
import os from 'node:os';
import {identityAt,fileIdentity,identityMode} from '../workspace/file-identity.ts';
import {atomicBytes} from '../workspace/atomic.ts';
/**
 *   harness undo <run-id>
 *   harness undo            (lists what can be undone)
 *
 * Team batches delegate to the journaled, conservative batch undo path.
 * Ordinary single-item undo reverses one applied run, including after later runs
 * changed the same files.
 *
 * Nothing here guesses. A file whose current content is exactly what the
 * run left behind is restored outright. A file that later work also
 * changed is merged three ways, with the run's own result as the base.
 * Where the undo and the later work rewrote the same lines, the file is
 * left alone and named -- silently choosing a side would destroy work
 * that was never being undone.
 *
 * The undo is itself an applied run with its own recovery snapshot, so it
 * can be undone in turn.
 */

import { safePath, readSafe } from "../workspace/safe-path.ts";
import { undoTeam } from "../team/apply.ts";
import { harnessDirectory } from "../record/record.ts";
import { withWriter } from "../workspace/writer-lock.ts";

import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  appendUndo,
  nextRunId,
  readRecord,
  recoveryPath,
  reverserOf,
  type RunRecord,
  undoableRuns,
} from "../record/record.ts";
import { type FileOutcome, planUndo } from "../recovery/plan-undo.ts";
import { markStatus } from "../features.ts";
import type { Change } from "../workspace/changes.ts";
import { localTime } from "../view/render.ts";
import { OperatorError, say } from "./io.ts";

async function undoUnlocked(project: string, argv: readonly string[]): Promise<void> {
  const { runs, malformed } = await readRecord(project);
  if (malformed.length > 0) {
    // Reported, never skipped. A record that quietly drops what it cannot
    // parse is a record that says a run never happened.
    say(`warning: ${String(malformed.length)} unreadable lines in the record (at ${malformed.join(", ")})`);
  }

  const undoable = undoableRuns(runs).filter(run => !(run.teamRunId && run.reverses));
  const wanted = argv[0];
  if (wanted === undefined) {
    if (undoable.length === 0) throw new OperatorError("nothing to undo.", "No applied run in this project is still standing.");
    say("undoable runs, newest last:\n");
    for (const run of undoable) {
      say(`  ${run.id.padEnd(5)} ${localTime(run.at)}  ${String(run.changes.length)} files  ${run.goal}`);
    }
    say("\nUndo one with: harness undo <run-id>");
    return;
  }

  if (runs.some(run => run.id === wanted && run.teamRunId && run.reverses)) throw new OperatorError("Team batch redo is not supported. Start and verify a new team run.");
  const run = undoable.find((entry) => entry.id === wanted);
  if (run === undefined) {
    const known = runs.find((entry) => entry.id === wanted);
    if (known === undefined) throw new OperatorError(`no run ${wanted} in this project.`, "Run `harness undo` to list what can be undone.");
    const reverser = reverserOf(runs, wanted);
    throw new OperatorError(
      `${wanted} cannot be undone.`,
      reverser !== undefined
        ? known.teamRunId ? `${reverser} already undid this team batch. Start and verify a new team run to apply it again.` : `${reverser} already undid it. Undo ${reverser} to put it back.`
        : `It was never applied (outcome: ${known.outcome}), so there is nothing to reverse.`,
    );
  }

  if (run.teamRunId) {
    const state = await undoTeam(project, path.join(harnessDirectory(project), "teams", run.teamRunId));
    say(`${state.runId}: ${state.status}, recorded as ${state.application?.recordId}. Dependent acceptance invalidated.`);
    say("The suite was not re-run. Check it before working on top of this."); return;
  }
  let rootRun = run;
  let depth = 1;
  const seen = new Set([run.id]);
  while (rootRun.reverses !== undefined) {
    const parent = runs.find((entry) => entry.id === rootRun.reverses);
    if (parent === undefined || seen.has(parent.id)) {
      throw new OperatorError("The undo chain is incomplete or cyclic.", "Repair the record before undoing this run.");
    }
    seen.add(parent.id);
    rootRun = parent;
    depth += 1;
  }
  const item = rootRun.goal;
  const status = depth % 2 === 1 ? "todo" : "done";

  const snapshot = runSnapshotPath(project, run);
  if (!existsSync(snapshot)) {
    throw new OperatorError(`the recovery snapshot for ${run.id} is missing.`, `Expected it at ${snapshot}.`);
  }

  const { outcomes, writes, modes, expected } = await planUndo(project, run, snapshot);
  const conflicts = outcomes.filter((outcome) => outcome.action === "conflicted");
  if (conflicts.length > 0) {
    // All or nothing. A half-undone change leaves the project in a state
    // that never existed and that nothing can describe.
    throw new OperatorError(
      `${run.id} cannot be undone cleanly: ${String(conflicts.length)} files conflict.`,
      [
        "Nothing was changed.",
        "",
        ...conflicts.map((outcome) => `  ${outcome.file}\n    ${outcome.detail ?? ""}`),
        "",
        `The previous content of each is under ${snapshot}/before, to merge by hand.`,
      ].join("\n"),
    );
  }

  const undoId = await nextRunId(project);
  const temporary=await mkdtemp(path.join(os.tmpdir(),'harness-undo-'));
  let restated=false;
  try {
    const baseline=await captureBaseline(project,path.join(temporary,'before'));
    const source=path.join(temporary,'after');await copySource(baseline.directory,source);
    for(const [file,content] of writes){
      if(await identityAt(path.join(project,file))!==expected.get(file))throw new OperatorError('Live content or mode changed while preparing undo.');
      if(content===undefined)await rm(path.join(source,file),{force:true});
      else await atomicBytes(path.join(source,file),content,modes.get(file)!);
    }
    const raw=await readFile(path.join(project,'features.json'),'utf8').catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return null;throw e;});
    const featuresAfter=applicationFeatures(raw,item,status,writes.size>0);restated=raw!==featuresAfter;
    const intent=await beginApplication(project,{source,expected:baseline,featuresAfter,direction:'undo',record:{id:undoId,at:new Date().toISOString(),project,goal:`undo ${run.id}`,attempts:0,outcome:'applied',gates:[],changes:[],reverses:run.id}});
    await finishApplication(intent);
  }finally{await rm(temporary,{recursive:true,force:true});}

  for (const outcome of outcomes) {
    say(`  ${outcome.action.padEnd(11)} ${outcome.file}${outcome.detail === undefined ? "" : `  (${outcome.detail})`}`);
  }
  say(`\nundid ${run.id}, recorded as ${undoId}. Undo that with: harness undo ${undoId}`);
  if (restated) say(`${item} is now ${status}.`);
  // Said plainly rather than implied. An undo reverses one run exactly;
  // whether the project still holds together afterwards is a different
  // question, and this one was not asked.
  say("The suite was not re-run. Check it before working on top of this.");
}

export async function undo(project: string, argv: readonly string[]): Promise<void> {
  return withWriter(project, "undo", () => undoUnlocked(project, argv));
}
