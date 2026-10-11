/** Execution ownership, not acceptance evidence. Domain records remain the source of verification facts. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';
import {realpathSync} from 'node:fs';
import {readArtifact} from '../workspace/artifact.ts';
import {atomicBytes, durableDirectory} from '../workspace/atomic.ts';
import {safePath} from '../workspace/safe-path.ts';
import {OperatorError} from '../verbs/io.ts';

type ExecutionState = 'running' | 'returned' | 'failed' | 'interrupted';
export interface OperationCheckpoint {
  dispatchId?: string;
  kind: 'run' | 'implementation' | 'continuation' | 'preparation' | 'stage' | 'team';
  reference: string;
  digest: string;
  status: 'checkpoint' | 'paused' | 'attention' | 'approval' | 'complete';
}
export type OperationPhase = 'preparing' | 'repairing' | 'building' | 'verifying' | 'reviewing' | 'staging' | 'applying' | 'recovering';
export interface PhaseIdentity {kind: OperationPhase; reference: string;}
interface Dispatch {
  phase?: PhaseIdentity;
  id: string;
  parent: string | null;
  command: string;
  state: 'reserved' | 'returned' | 'failed' | 'uncertain';
}
export interface DurableOperation {
  version: 1;
  id: string;
  revision: number;
  previous: string | null;
  owner: string;
  command: string;
  state: ExecutionState;
  updated: string;
  dispatches: Dispatch[];
  checkpoints: OperationCheckpoint[];
  progress: OperationCheckpoint | null;
}
interface Lease {project: string; token: string; assertOwned(): Promise<void>;}
interface Session {lease: Lease; record: DurableOperation; writes: Promise<unknown>; closed: boolean;}
interface Frame {session: Session; dispatch: string; closed: boolean; child: Promise<unknown> | null;}
const context = new AsyncLocalStorage<Frame>();
function canonical(project: string): string {
  try { return realpathSync(project); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return path.resolve(project);
  }
}
const directory = (project: string) => canonical(project) + '-harness/operations';
const file = 'current.json';
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1000 && !value.includes('\0');
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
function fields(value: unknown, names: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...names].sort().join(',')) throw new OperatorError('Invalid operation fields. Retained state needs inspection.');
}
function checkpoint(value: unknown): asserts value is OperationCheckpoint {
  fields(value, ['kind', 'reference', 'digest', 'status', ...(value && typeof value === 'object' && Object.hasOwn(value, 'dispatchId') ? ['dispatchId'] : [])]);
  if (Object.hasOwn(value, 'dispatchId') && !uuid(value.dispatchId)) throw new OperatorError('Invalid checkpoint dispatch.');
  if (!['run', 'implementation', 'continuation', 'preparation', 'stage', 'team'].includes(value.kind as string) || !text(value.reference) || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest) || !['checkpoint', 'paused', 'attention', 'approval', 'complete'].includes(value.status as string)) throw new OperatorError('Invalid operation checkpoint.');
}
function parsePhase(value: unknown): asserts value is PhaseIdentity {
  fields(value, ['kind', 'reference']);
  if (!['preparing', 'repairing', 'building', 'verifying', 'reviewing', 'staging', 'applying', 'recovering'].includes(value.kind as string) || !text(value.reference)) throw new OperatorError('Invalid operation phase.');
}
export function parseOperation(value: unknown): DurableOperation {
  fields(value, ['version', 'id', 'revision', 'previous', 'owner', 'command', 'state', 'updated', 'dispatches', 'checkpoints', 'progress']);
  if (value.version !== 1 || !uuid(value.id) || !uuid(value.owner) || (value.previous !== null && !uuid(value.previous)) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !text(value.command) || !['running', 'returned', 'failed', 'interrupted'].includes(value.state as string) || typeof value.updated !== 'string' || !Number.isFinite(Date.parse(value.updated)) || !Array.isArray(value.dispatches) || value.dispatches.length > 1024 || !Array.isArray(value.checkpoints) || value.checkpoints.length > 1024) throw new OperatorError('Invalid durable operation.');
  const ids = new Set<string>();
  for (const d of value.dispatches) {
    fields(d, ['id', 'parent', 'command', 'state', ...(d && typeof d === 'object' && Object.hasOwn(d, 'phase') ? ['phase'] : [])]);
    if (d.phase !== undefined) parsePhase(d.phase);
    if (!uuid(d.id) || ids.has(d.id) || (d.parent !== null && !ids.has(String(d.parent))) || !text(d.command) || !['reserved', 'returned', 'failed', 'uncertain'].includes(d.state as string)) throw new OperatorError('Invalid operation dispatch.');
    ids.add(d.id);
  }
  for (const c of value.checkpoints) {
    checkpoint(c);
    if (c.dispatchId !== undefined && !ids.has(c.dispatchId)) throw new OperatorError('Unknown checkpoint dispatch.');
  }
  if (value.progress !== null) {
    checkpoint(value.progress);
    if (JSON.stringify(value.progress) !== JSON.stringify(value.checkpoints.at(-1))) throw new OperatorError('Operation progress does not match its checkpoint.');
  } else if (value.checkpoints.length) throw new OperatorError('Operation progress is missing.');
  if (value.state !== 'running' && value.dispatches.some(d => d.state === 'reserved')) throw new OperatorError('Terminal operation has unresolved dispatches.');
  return structuredClone(value) as unknown as DurableOperation;
}
export async function readOperation(project: string): Promise<DurableOperation | undefined> {
  const raw = await readArtifact(directory(project), file, 2 * 1024 * 1024);
  return raw === undefined ? undefined : parseOperation(JSON.parse(raw));
}
export async function assertOperationRevision(project: string, id: string, revision: number): Promise<void> {
  const current = await readOperation(project);
  if (current?.id !== id || current.revision !== revision) throw new OperatorError('Stale operation guidance; reload status before dispatch.');
}
async function writeRecord(lease: Lease, expected: DurableOperation | undefined, next: DurableOperation): Promise<void> {
  parseOperation(next);
  await lease.assertOwned();
  const root = directory(lease.project);
  await durableDirectory(root, 0o700);
  const target = await safePath(root, file);
  const bytes = Buffer.from(encode(next));
  if (bytes.length > 2 * 1024 * 1024) throw new OperatorError("Operation record exceeds its bounded storage limit.");
  await atomicBytes(target, bytes, 0o600, root, async () => {
    await lease.assertOwned();
    if (JSON.stringify(await readOperation(lease.project)) !== JSON.stringify(expected)) throw new OperatorError('Stale operation or owner; refusing state replacement.');
  });
}
function update(session: Session, change: (next: DurableOperation) => void): Promise<void> {
  const work = session.writes.then(async () => {
    if (session.closed) throw new OperatorError('Operation owner has finished.');
    const before = session.record, next = structuredClone(before);
    change(next);
    next.revision++;
    next.updated = new Date().toISOString();
    await writeRecord(session.lease, before, next);
    session.record = next;
  });
  // Serialize independent result callbacks; a failed write is never hidden from its caller.
  session.writes = work.catch(() => {});
  return work;
}
export function currentOperationId(project: string): string | undefined {
  const frame = context.getStore();
  return frame && !frame.closed && !frame.session.closed && frame.session.lease.project === canonical(project) ? frame.session.record.id : undefined;
}
/** Domain-state publication requires the same live lease and recorded operation revision. */
export async function assertOperationOwner(project: string): Promise<string> {
  const frame = context.getStore();
  if (!frame || frame.closed || frame.session.closed || frame.session.lease.project !== canonical(project)) throw new OperatorError('Controller state requires its active operation owner.');
  await frame.session.writes;
  await frame.session.lease.assertOwned();
  if (JSON.stringify(await readOperation(project)) !== JSON.stringify(frame.session.record)) throw new OperatorError('Stale operation or owner; refusing controller state replacement.');
  return frame.session.record.id;
}
export async function checkpointOperation(project: string, value: OperationCheckpoint): Promise<void> {
  checkpoint(value);
  const frame = context.getStore();
  if (!frame || frame.session.lease.project !== canonical(project)) return;
  if (frame.closed) throw new OperatorError('Operation dispatch has finished.');
  if (value.dispatchId !== undefined && value.dispatchId !== frame.dispatch) throw new OperatorError('Checkpoint belongs to another dispatch.');
  const saved = {...value, dispatchId: frame.dispatch};
  await update(frame.session, next => {
    next.checkpoints.push(structuredClone(saved));
    next.progress = structuredClone(saved);
  });
}
export function trackedCommand(command: string): boolean {
  return command === 'recover-application' || command === 'application recovery' || command === 'undo' || /^work(?: |$)/u.test(command) || command === 'continue' || /^team(?: |$)/.test(command) || /^checks(?: |$)/.test(command) || /^stage /.test(command);
}
/** The phase scope owns dispatch, not the evidence verdict produced by its callback. */
export async function withOperationPhase<T>(project: string, kind: OperationPhase, reference: string, action: () => Promise<T>): Promise<T> {
  const frame = context.getStore();
  if (!frame || frame.session.lease.project !== canonical(project)) throw new OperatorError('A phase requires its project operation owner.');
  const phase = {kind, reference};
  parsePhase(phase);
  return childDispatch(frame, `phase ${kind}`, action, phase);
}
function childDispatch<T>(parent: Frame, command: string, action: () => Promise<T>, phase?: PhaseIdentity): Promise<T> {
  if (parent.closed || parent.session.closed) throw new OperatorError('Operation owner has finished.');
  if (parent.child) throw new OperatorError('An operation child is already active; await it before dispatching another phase.');
  // Claim the in-process slot synchronously, before the durable reservation awaits I/O.
  const work = dispatch(parent.session, command, parent.dispatch, action, phase);
  const tracked = work.finally(() => { if (parent.child === tracked) parent.child = null; });
  parent.child = tracked;
  return tracked;
}
async function dispatch<T>(session: Session, command: string, parent: string | null, action: () => Promise<T>, phase?: PhaseIdentity): Promise<T> {
  const id = randomUUID(), frame: Frame = {session, dispatch: id, closed: false, child: null};
  await update(session, next => { next.dispatches.push({id, parent, command, state: 'reserved', ...(phase ? {phase} : {})}); });
  let result!: T, failure: unknown, failed = false;
  try { result = await context.run(frame, action); }
  catch (error) { failure = error; failed = true; }
  frame.closed = true;
  if (frame.child) {
    // Never release the writer while dispatched work can still produce effects.
    // Drain the already-started child, but reject the programming error instead of reporting success.
    await frame.child.catch(() => {});
    if (!failed) { failed = true; failure = new OperatorError('Operation callback did not await its active child.'); }
  }
  await update(session, next => { next.dispatches.find(d => d.id === id)!.state = failed ? 'failed' : 'returned'; });
  if (failed) throw failure;
  return result;
}
function commandPhase(command: string): PhaseIdentity | undefined {
  const kind: OperationPhase | undefined = command === 'checks prepare' || command === 'checks setup' || command === 'checks draft' ? 'preparing'
    : /^checks (repair|simplify|regenerate)/.test(command) ? 'repairing'
    : command === 'checks review' || command === 'checks approve' || command === 'checks recipe' || command === 'stage review' ? 'reviewing'
    : command === 'stage apply' || command === 'undo' ? 'applying'
    : command === 'recover-application' || command === 'application recovery' ? 'recovering' : undefined;
  return kind ? {kind, reference: command} : undefined;
}
export async function withOperation<T>(lease: Lease, command: string, action: () => Promise<T>): Promise<T> {
  const parent = context.getStore();
  if (parent && parent.session.lease.project === lease.project) {
    if (parent.closed || parent.session.closed) throw new OperatorError('Operation owner has finished.');
    return childDispatch(parent, command, action, commandPhase(command));
  }
  if (!trackedCommand(command)) return action();
  const previous = await readOperation(lease.project);
  let replacementExpected = previous;
  if (previous) {
    // A new writer is proof only that the old lock was released/recovered, never proof that its work succeeded.
    const archived = structuredClone(previous);
    if (archived.state === 'running') {
      archived.state = 'interrupted';
      archived.revision++;
      archived.updated = new Date().toISOString();
      for (const d of archived.dispatches) if (d.state === 'reserved') d.state = 'uncertain';
      await writeRecord(lease, previous, archived);
      replacementExpected = archived;
    }
    const history = await safePath(directory(lease.project), `history/${archived.id}.json`);
    await durableDirectory(path.dirname(history), 0o700);
    const old = await readArtifact(path.dirname(history), path.basename(history), 2 * 1024 * 1024);
    if (old !== undefined && old !== encode(archived)) throw new OperatorError('Retained operation history changed.');
    if (old === undefined) await atomicBytes(history, Buffer.from(encode(archived)), 0o600);
  }
  const record: DurableOperation = {
    version: 1, id: randomUUID(), revision: 0, previous: previous?.id ?? null,
    owner: lease.token, command, state: 'running', updated: new Date().toISOString(), dispatches: [], checkpoints: [], progress: null,
  };
  await writeRecord(lease, replacementExpected, record);
  const session: Session = {lease, record, writes: Promise.resolve(), closed: false};
  try {
    const result = await dispatch(session, command, null, action, commandPhase(command));
    await update(session, next => { next.state = 'returned'; });
    return result;
  } catch (error) {
    await update(session, next => { next.state = 'failed'; for (const d of next.dispatches) if (d.state === 'reserved') d.state = 'uncertain'; });
    throw error;
  } finally { session.closed = true; }
}
export function operationProjection(record: DurableOperation): {detail: string; unresolved: boolean} {
  const phases = record.dispatches.filter(d => d.phase);
  const selected = phases.findLast(d => d.state === 'reserved' || d.state === 'uncertain') ?? phases.at(-1);
  return {
    detail: selected ? `Recorded phase: ${selected.phase!.kind} · ${selected.phase!.reference} · ${selected.state}.` : 'No phase dispatch is recorded.',
    unresolved: record.state === 'running' || record.state === 'interrupted',
  };
}
export async function describeOperation(project: string, write: (message: string) => void): Promise<void> {
  const record = await readOperation(project);
  if (!record) return;
  write(`Operation ${record.id} · revision ${record.revision} · ${record.command}: ${record.state} (last recorded execution).`);
  write(operationProjection(record).detail);
  if (record.progress) write(`Saved ${record.progress.kind}: ${record.progress.status} · ${record.progress.reference}.`);
  if (record.state === 'running') write('A running record is not a liveness claim. Inspect writer ownership before recovery.');
  write('Execution status does not grant application approval or prove task completion.');
}

/** Compatibility adapter: pin saved domain bytes without rewriting their schema or granting evidence authority. */
export async function checkpointSavedFile(filePath: string, kind: OperationCheckpoint['kind'], status: OperationCheckpoint['status']): Promise<void> {
  const frame = context.getStore();
  if (!frame) return;
  const project = frame.session.lease.project, root = project + '-harness';
  // Canonicalize the owner prefix only; readArtifact must still reject links inside it.
  let prefix = path.dirname(path.resolve(filePath));
  while (canonical(prefix) !== root && prefix !== path.dirname(prefix)) prefix = path.dirname(prefix);
  if (canonical(prefix) !== root) throw new OperatorError('Operation checkpoint is outside its project owner.');
  const relative = path.relative(prefix, path.resolve(filePath));
  const raw = await readArtifact(root, relative, 8 * 1024 * 1024);
  if (raw === undefined) throw new OperatorError('Operation checkpoint was not saved.');
  await checkpointOperation(project, {kind, reference: relative, digest: createHash('sha256').update(raw).digest('hex'), status});
}
