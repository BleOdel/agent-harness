/** Host-only batch application. Intent precedes writes; fingerprints decide recovery. */
import { assertAcceptanceProof, type AcceptanceProof } from "../acceptance/checks.ts";
import { abortRequested } from "./control.ts";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { parseFeatures } from "../features.ts";
import { appendRunOnce, harnessDirectory, nextRunId, readRecord, type RunRecord } from "../record/record.ts";
import { atomicBytes, durableDirectory, syncDirectory } from "../workspace/atomic.ts";
import { assertLiveBaseline, assertSnapshot, captureBaseline, copySource, sourceFiles, type Snapshot } from "../workspace/candidate.ts";
import { assertChangesAreApplicable, type Change } from "../workspace/changes.ts";
import { canonicalProject, withWriter } from "../workspace/writer-lock.ts";
import { readChecks } from "./checks.ts";
import { digest, safeRelative, type TeamState } from "./schema.ts";
import { appendEvent, atomicJson, readState } from "./state.ts";

export interface ApplicationOptions { acceptance?: AcceptanceProof; rollback?: boolean; checkpoint?: (point: string) => void | Promise<void>; }
interface Intent {
  version: 1; id: string; project: string; teamDirectory: string; teamRunId: string; direction: "apply" | "undo";
  before: Snapshot; after: Snapshot; featuresBefore: string; featuresAfter: string;
  changes: Change[]; modes: Record<string, number>; record: RunRecord;
}
interface Pending { version: 1; id: string; teamRunId: string; intentDigest: string; }
const hash = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
export const applicationPath = (project: string): string => path.join(harnessDirectory(project), "application.json");
const transactionPath = (project: string, id: string): string => path.join(harnessDirectory(project), "applications", id);
async function optional(file: string): Promise<Buffer | undefined> {
  try { if (!(await lstat(file)).isFile()) throw new Error(`Unsupported file or symlink: ${file}`); return await readFile(file); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
}
async function pendingAt(project: string): Promise<Pending | undefined> {
  const bytes = await optional(applicationPath(project)); return bytes ? JSON.parse(bytes.toString()) as Pending : undefined;
}
export async function assertTeamDirectory(project: string, directory: string): Promise<void> {
  const expected = path.join(harnessDirectory(project), "teams", path.basename(directory));
  if (await canonicalProject(directory) !== expected) throw new Error("Team run does not belong to this project.");
}
async function loadIntent(project: string, pending: Pending): Promise<Intent> {
  if (pending.version !== 1 || !/^application-[a-f0-9-]+$/u.test(pending.id)) throw new Error("Invalid pending application identity.");
  const intent = JSON.parse((await optional(path.join(transactionPath(project, pending.id), "intent.json")))!.toString()) as Intent;
  if (digest(intent) !== pending.intentDigest || intent.version !== 1 || intent.id !== pending.id || intent.project !== project || intent.teamRunId !== pending.teamRunId) throw new Error("Application intent changed; manual recovery required.");
  await assertTeamDirectory(project, intent.teamDirectory);
  await Promise.all([assertSnapshot(intent.before), assertSnapshot(intent.after)]);
  return intent;
}
async function inspectLive(intent: Intent): Promise<void> {
  const live = await sourceFiles(intent.project);
  for (const file of new Set([...Object.keys(live), ...Object.keys(intent.before.files), ...Object.keys(intent.after.files)])) {
    if (live[file] !== intent.before.files[file] && live[file] !== intent.after.files[file]) throw new Error(`External change at ${file}; fingerprints disagree. Manual recovery required.`);
  }
  const features = await optional(path.join(intent.project, "features.json"));
  if (!features || ![intent.featuresBefore, intent.featuresAfter].includes(features.toString())) throw new Error("Feature manifest changed externally; manual recovery required.");
}
function featuresAfter(before: string, state: TeamState, undo: boolean): string {
  const list = parseFeatures(before); if (!list.ok) throw new Error(list.reason);
  const completed = new Set(undo ? (state.plan.tasks.filter(t => state.integrated.includes(t.id)).map(t => t.id)) : state.integrated);
  const affected = new Set(completed);
  for (let changed = true; changed;) {
    changed = false;
    for (const task of list.features) if (!affected.has(task.id) && task.dependsOn.some(id => affected.has(id))) { affected.add(task.id); changed = true; }
  }
  return JSON.stringify(list.features.map(task => completed.has(task.id) ? { ...task, status: undo ? "todo" : "done" }
    : (state.invalidated.includes(task.id) || (undo && affected.has(task.id))) && ["done", "doing"].includes(task.status) ? { ...task, status: "needs-revalidation" } : task), null, 2) + "\n";
}
async function begin(project: string, directory: string, state: TeamState, source: string, direction: Intent["direction"], expected: Snapshot, options: ApplicationOptions): Promise<Intent> {
  const id = `application-${randomUUID()}`, root = transactionPath(project, id);
  await durableDirectory(root, 0o700);
  await assertLiveBaseline(project, expected);
  const before = await captureBaseline(project, path.join(root, "before"));
  if (before.digest !== expected.digest || before.controls !== expected.controls) throw new Error("Live source changed while preparing application.");
  const after = await captureBaseline(source, path.join(root, "after"));
  if (direction === "apply" && after.digest !== state.baseline.digest) throw new Error("Verified staging changed during application preparation.");
  const raw = await optional(path.join(project, "features.json")); if (!raw) throw new Error("Application requires the accepted feature manifest.");
  const changes: Change[] = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].filter(file => before.files[file] !== after.files[file]).sort().map(file => ({ file, symlink: false, kind: after.files[file] === undefined ? "deleted" : before.files[file] === undefined ? "added" : "modified" }));
  assertChangesAreApplicable(changes, after.directory);
  for (const file of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
    if (!safeRelative(file)) throw new Error("Unsafe application path.");
    // Directory replacement can remove excluded data. Refuse it before any write.
    const parts = file.split("/"); parts.pop();
    while (parts.length) { if (before.files[parts.join("/")] !== undefined || after.files[parts.join("/")] !== undefined) throw new Error("File/directory replacement requires manual application."); parts.pop(); }
  }
  const modes: Record<string, number> = {};
  for (const file of [...changes.map(c => c.file), "features.json"]) {
    const stat = await lstat(path.join(project, file)).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; });
    if (stat && stat.nlink !== 1) throw new Error(`Hard-linked application paths are unsupported: ${file}`);
    let ancestor = path.dirname(path.join(project, file));
    while (!(await lstat(ancestor).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; }))) ancestor = path.dirname(ancestor);
    if ((await lstat(ancestor)).dev !== (await lstat(root)).dev) throw new Error("Application state and destination must be on the same filesystem.");
    modes[file] = stat ? stat.mode & 0o777 : (await lstat(path.join(after.directory, file))).mode & 0o777;
  }
  const history = await readRecord(project); if (history.malformed.length) throw new Error("Malformed record requires repair before application.");
  const record: RunRecord = { id: await nextRunId(project), at: new Date().toISOString(), project, goal: direction === "apply" ? state.runId : `undo ${state.appliedRecordId}`, attempts: state.attempts.length, outcome: "applied", gates: direction === "apply" ? ["All staged candidates passed gates, review, combined verification and approved acceptance checks."] : [], ...(direction === "apply" && options.acceptance ? { acceptance: options.acceptance } : {}), changes, teamRunId: state.runId, taskIds: [...state.integrated], transactionId: id, baselineDigest: before.digest, candidateDigest: after.digest, ...(direction === "undo" ? { reverses: state.appliedRecordId! } : {}) };
  const intent: Intent = { version: 1, id, project, teamDirectory: directory, teamRunId: state.runId, direction, before, after, featuresBefore: raw.toString(), featuresAfter: featuresAfter(raw.toString(), state, direction === "undo"), changes, modes, record };
  // The intent may outlive this process; flush its source bytes before publication.
  for (const snapshot of [before, after]) {
    const directories = new Set<string>([snapshot.directory, root]);
    for (const file of Object.keys(snapshot.files)) {
      const handle = await open(path.join(snapshot.directory, file), "r"); try { await handle.sync(); } finally { await handle.close(); }
      let directory = path.dirname(path.join(snapshot.directory, file));
      while (directory.startsWith(snapshot.directory)) { directories.add(directory); directory = path.dirname(directory); }
    }
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) await syncDirectory(directory);
  }
  await atomicJson(path.join(root, "intent.json"), intent, true);
  // Recheck after preparation and before publishing an intent that may write.
  await options.checkpoint?.("prepared-intent");
  await assertLiveBaseline(project, expected);
  if (direction === "apply") await assertAcceptanceProof(project, state.baseline, state.integrated, options.acceptance);
  await atomicJson(applicationPath(project), { version: 1, id, teamRunId: state.runId, intentDigest: digest(intent) } satisfies Pending, true);
  return intent;
}
async function writeSource(intent: Intent, file: string, toBefore: boolean, checkpoint?: ApplicationOptions["checkpoint"]): Promise<void> {
  const desired = toBefore ? intent.before : intent.after;
  const live = path.join(intent.project, file);
  // Recheck every path immediately before replacement, including its parents.
  const assertParents = async () => {
    const parts = file.split("/"); parts.pop(); let parent = intent.project;
    if (!(await lstat(parent)).isDirectory()) throw new Error("Project root changed or became a symlink.");
    for (const part of parts) { parent = path.join(parent, part); const stat = await lstat(parent).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; }); if (stat && !stat.isDirectory()) throw new Error(`Parent changed or became a symlink: ${file}`); }
  };
  await assertParents();
  const current = await optional(live), currentHash = current === undefined ? undefined : hash(current);
  if (currentHash !== intent.before.files[file] && currentHash !== intent.after.files[file]) throw new Error(`External change at ${file}; refusing overwrite.`);
  if (currentHash === desired.files[file]) return;
  if (desired.files[file] === undefined) { await unlink(live); await syncDirectory(path.dirname(live)); }
  else {
    const bytes = await readFile(path.join(desired.directory, file));
    if (hash(bytes) !== desired.files[file]) throw new Error(`Application snapshot changed at ${file}.`);
    await atomicBytes(live, bytes, intent.modes[file], transactionPath(intent.project, intent.id), async () => {
      await checkpoint?.(`prepared:${file}`);
      await assertParents();
      const latest = await optional(live), fingerprint = latest === undefined ? undefined : hash(latest);
      if (fingerprint !== intent.before.files[file] && fingerprint !== intent.after.files[file]) throw new Error(`External change at ${file}; refusing replacement.`);
    });
  }
}
async function writeFeatures(intent: Intent, rollback: boolean, checkpoint: ApplicationOptions["checkpoint"]): Promise<void> {
  const file = path.join(intent.project, "features.json"), current = await optional(file);
  if (!current || ![intent.featuresBefore, intent.featuresAfter].includes(current.toString())) throw new Error("External feature change; refusing overwrite.");
  const desired = rollback ? intent.featuresBefore : intent.featuresAfter;
  if (current.toString() !== desired) await atomicBytes(file, Buffer.from(desired), intent.modes["features.json"], transactionPath(intent.project, intent.id), async () => {
    await checkpoint?.("prepared:features.json");
    const latest = await optional(file);
    if (!latest || ![intent.featuresBefore, intent.featuresAfter].includes(latest.toString())) throw new Error("External feature change; refusing replacement.");
  });
}
async function finish(intent: Intent, options: ApplicationOptions): Promise<TeamState> {
  const checkpoint = options.checkpoint ?? (() => {});
  await inspectLive(intent);
  let state = await readState(intent.teamDirectory);
  if (state.application?.transactionId !== intent.id) state = await appendEvent(intent.teamDirectory, { type: "application-started", transactionId: intent.id, intentDigest: digest(intent), direction: intent.direction });
  const history = await readRecord(intent.project);
  if (options.rollback && history.runs.some(r => r.id === intent.record.id)) throw new Error("Application record is committed; finish recovery, then undo the batch.");
  const decisionPath = path.join(transactionPath(intent.project, intent.id), "rollback.json");
  if (options.rollback && !await optional(decisionPath)) await atomicJson(decisionPath, { rollback: true }, true);
  const rollback = await optional(decisionPath) !== undefined;
  if (rollback && history.runs.some(r => r.id === intent.record.id)) throw new Error("Committed application cannot roll back; manual recovery required.");
  const featuresFirst = intent.direction === "undo" ? !rollback : rollback;
  if (featuresFirst) await writeFeatures(intent, rollback, checkpoint);
  for (const change of intent.changes) {
    await writeSource(intent, change.file, rollback, checkpoint);
    await checkpoint(`replaced:${change.file}`);
    await atomicJson(path.join(transactionPath(intent.project, intent.id), "progress.json"), { file: change.file, rollback });
    await checkpoint(`write:${change.file}`);
  }
  await checkpoint("sources");
  const expected = rollback ? intent.before : intent.after;
  await assertSnapshot({ ...expected, directory: intent.project });
  if (!featuresFirst) { await writeFeatures(intent, rollback, checkpoint); await checkpoint("features"); }
  if (rollback) {
    state = await appendEvent(intent.teamDirectory, { type: "application-rolled-back", transactionId: intent.id, direction: intent.direction });
  } else {
    await appendRunOnce(intent.project, intent.record); await checkpoint("record");
    if (state.status === "applying") state = await appendEvent(intent.teamDirectory, { type: "application-completed", transactionId: intent.id, direction: intent.direction, recordId: intent.record.id });
    await checkpoint("event");
  }
  await atomicJson(path.join(transactionPath(intent.project, intent.id), "complete.json"), { rollback });
  await unlink(applicationPath(intent.project)); await syncDirectory(harnessDirectory(intent.project));
  return state;
}
export async function applyTeam(project: string, directory: string, options: ApplicationOptions = {}): Promise<TeamState> {
  project = await canonicalProject(project); directory = await canonicalProject(directory);
  return withWriter(project, "team apply", async () => {
    await assertTeamDirectory(project, directory);
    if (await abortRequested(directory)) throw new Error("Aborted team cannot apply; start a new verified run.");
    const state = await readState(directory);
    if (state.status === "applied") return state;
    if (state.version < 2 || state.status !== "staged" || !state.integrated.length) throw new Error("Only a verified staged team with integrated assignments can apply.");
    if (!state.original.controls) throw new Error("Application requires a captured feature-manifest fingerprint.");
    await assertLiveBaseline(project, state.original); await assertSnapshot(state.baseline);
    await readChecks(directory, state.verificationDigest);
    await assertAcceptanceProof(project, state.baseline, state.integrated, options.acceptance);
    const intent = await begin(project, directory, state, state.baseline.directory, "apply", state.original, options);
    await options.checkpoint?.("intent");
    return finish(intent, options);
  });
}
export async function recoverApplication(project: string, directory: string, options: ApplicationOptions = {}): Promise<TeamState> {
  project = await canonicalProject(project); directory = await canonicalProject(directory);
  return withWriter(project, "team application recovery", async () => {
    await assertTeamDirectory(project, directory);
    const pending = await pendingAt(project); if (!pending) return readState(directory);
    if (pending.teamRunId !== path.basename(directory)) throw new Error(`Pending application belongs to ${pending.teamRunId}; recover that run first.`);
    return finish(await loadIntent(project, pending), options);
  }, true);
}
export async function undoTeam(project: string, directory: string, options: ApplicationOptions = {}): Promise<TeamState> {
  project = await canonicalProject(project); directory = await canonicalProject(directory);
  return withWriter(project, "team undo", async () => {
    await assertTeamDirectory(project, directory); const state = await readState(directory);
    if (state.status === "undone") return state;
    if (state.status !== "applied" || !state.appliedTransactionId) throw new Error("Only an applied team batch can be undone.");
    const original = JSON.parse((await optional(path.join(transactionPath(project, state.appliedTransactionId), "intent.json")))!.toString()) as Intent;
    if (digest(original) !== state.appliedIntentDigest) throw new Error("Applied intent changed; manual recovery required.");
    await Promise.all([assertSnapshot(original.before), assertSnapshot(original.after)]);
    const undoLive = await captureBaseline(project, path.join(directory, `undo-live-${randomUUID()}`));
    for (const change of original.changes) if (undoLive.files[change.file] !== original.after.files[change.file]) throw new Error(`External change at ${change.file}; batch undo requires manual reconciliation.`);
    const undoSource = path.join(directory, `undo-source-${randomUUID()}`); await copySource(undoLive.directory, undoSource);
    try {
      for (const change of original.changes) {
        const file = path.join(undoSource, change.file);
        if (original.before.files[change.file] === undefined) await rm(file);
        else await atomicBytes(file, await readFile(path.join(original.before.directory, change.file)), original.modes[change.file]);
      }
      const intent = await begin(project, directory, state, undoSource, "undo", undoLive, options); await options.checkpoint?.("intent"); return finish(intent, options);
    } finally { await rm(undoSource, { recursive: true, force: true }); }
  });
}
