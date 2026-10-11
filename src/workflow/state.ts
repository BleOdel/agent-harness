/** Guarded controller records: the existing domain file remains the only status authority. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readArtifact } from '../workspace/artifact.ts';
import { atomicBytes, durableDirectory } from '../workspace/atomic.ts';
import { safePath } from '../workspace/safe-path.ts';
import { canonicalProject, withWriter } from '../workspace/writer-lock.ts';
import { harnessDirectory } from '../record/record.ts';
import { assertOperationOwner, checkpointSavedFile } from './operations.ts';
import { OperatorError } from '../verbs/io.ts';
export interface StateRevision {
    revision?: number;
    operationId?: string;
}
export type StateKind = 'continuation' | 'preparation';
const records = {
    continuation: { file: 'continuation.json', limit: 1024 * 1024, command: 'continue' },
    preparation: { file: 'acceptance/workflow.json', limit: 8 * 1024 * 1024, command: 'checks state' },
} as const;
interface Expected {
    project: string;
    kind: StateKind;
    raw: string;
}
const observed = new WeakMap<object, Expected>();
export function validateStateRevision(value: StateRevision): void {
    if (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || value.revision < 1))
        throw new OperatorError('Invalid controller state revision.');
    if (value.operationId !== undefined && (typeof value.operationId !== 'string' || !value.operationId.trim() || value.operationId.length > 200))
        throw new OperatorError('Invalid controller operation identity.');
}
async function readStateBytes(project: string, kind: StateKind): Promise<string | undefined> {
    const root = harnessDirectory(project), spec = records[kind];
    try {
        await safePath(root, spec.file);
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return undefined;
        throw error;
    }
    return readArtifact(root, spec.file, spec.limit);
}
export async function readControllerState<T extends StateRevision>(project: string, kind: StateKind, parse: (raw: unknown) => T): Promise<T | undefined> {
    project = await canonicalProject(project);
    const raw = await readStateBytes(project, kind);
    if (raw === undefined)
        return undefined;
    const value = parse(JSON.parse(raw));
    validateStateRevision(value);
    observed.set(value, { project, kind, raw });
    return value;
}
/** An explicit renewal uses the old read as its compare-and-swap expectation. */
export function inheritControllerState(previous: object, next: object): void {
    const expected = observed.get(previous);
    if (!expected)
        throw new OperatorError('Read the saved controller state before renewing it.');
    observed.set(next, expected);
}
export async function saveControllerState<T extends StateRevision>(project: string, kind: StateKind, value: T, parse: (raw: unknown) => T, status: 'checkpoint' | 'paused' | 'attention' | 'approval' | 'complete'): Promise<void> {
    project = await canonicalProject(project);
    const spec = records[kind];
    await withWriter(project, spec.command, async () => {
        parse(value);
        validateStateRevision(value);
        const expectation = observed.get(value);
        if (expectation && (expectation.project !== project || expectation.kind !== kind))
            throw new OperatorError('Controller state belongs to another project or kind.');
        const root = harnessDirectory(project), expected = expectation?.raw;
        const compare = async () => { if (await readStateBytes(project, kind) !== expected)
            throw new OperatorError('Stale controller state; reload saved progress before continuing.'); };
        const operationId = await assertOperationOwner(project);
        await compare();
        const revision = expected === undefined ? 1 : (JSON.parse(expected).revision ?? 0) + 1;
        const next = { ...value, revision, operationId };
        parse(next);
        validateStateRevision(next);
        const raw = JSON.stringify(next, null, 2) + '\n', bytes = Buffer.from(raw);
        if (bytes.length > spec.limit)
            throw new OperatorError('Controller state exceeds its bounded storage limit.');
        await durableDirectory(root, 0o700);
        const target = await safePath(root, spec.file);
        if (expected !== undefined && JSON.parse(expected).revision === undefined) {
            const name = `${kind}-${createHash('sha256').update(expected).digest('hex')}.json`;
            const archiveFile = await safePath(root, 'operations/legacy/' + name), archiveRoot = path.dirname(archiveFile);
            await durableDirectory(archiveRoot, 0o700);
            const prior = await readArtifact(archiveRoot, name, spec.limit);
            if (prior !== undefined && prior !== expected)
                throw new OperatorError('Legacy controller archive changed.');
            if (prior === undefined)
                await atomicBytes(await safePath(archiveRoot, name), Buffer.from(expected), 0o600, archiveRoot, async () => { await assertOperationOwner(project); await compare(); });
        }
        await atomicBytes(target, bytes, 0o600, root, async () => { await assertOperationOwner(project); await compare(); });
        // After publication the same object must carry the new expectation even if checkpoint recording fails.
        Object.assign(value, { revision, operationId });
        observed.set(value, { project, kind, raw });
        await checkpointSavedFile(target, kind, status);
    });
}
