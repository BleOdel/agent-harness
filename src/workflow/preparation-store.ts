/** One owner and exact-byte expectations for the resumable preparation records.
 * Domain JSON stays unchanged: migration markers hash these exact bytes.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { canonicalProject, withWriter } from '../workspace/writer-lock.ts';
import { harnessDirectory } from '../record/record.ts';
import { readArtifact, atomicWrite as writeOtherFile } from '../planning/store.ts';
import { atomicBytes, syncDirectory } from '../workspace/atomic.ts';
import { safePath } from '../workspace/safe-path.ts';
import { assertOperationOwner, checkpointSavedFile } from './operations.ts';
import { OperatorError } from '../verbs/io.ts';
const files = ['preparation.json', 'review-progress.json', 'guided-draft.json', 'simplification.json', 'recipe-change.json', 'outline-response.json', 'outline-planning.json'];
const limit = 8 * 1024 * 1024;
interface Frame {
    project: string;
    root: string;
    expected: Map<string, string | undefined>;
    active: boolean;
    accepting: boolean;
    tail: Promise<void>;
    failure?: unknown;
}
const scope = new AsyncLocalStorage<Frame>();
function managed(relative: string): boolean { return files.includes(relative) || /^regenerations\/[a-z][a-z0-9-]{0,79}\.json$/u.test(relative); }
async function names(root: string): Promise<string[]> {
    await safePath(path.dirname(root), 'acceptance/regenerations/probe.json');
    const entries = await readdir(path.join(root, 'regenerations')).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return [];
        throw e;
    });
    if (entries.length > 1000)
        throw new OperatorError('Too many preparation regeneration checkpoints.');
    return [...files, ...entries.map(name => 'regenerations/' + name).filter(managed)];
}
async function read(root: string, name: string): Promise<string | undefined> {
    await safePath(path.dirname(root), 'acceptance/' + name);
    return readArtifact(root, name, limit);
}
async function compare(frame: Frame): Promise<void> {
    if (!frame.active)
        throw new OperatorError('Preparation checkpoint scope is closed.');
    await assertOperationOwner(frame.project);
    for (const name of new Set([...frame.expected.keys(), ...await names(frame.root)]))
        if (await read(frame.root, name) !== frame.expected.get(name))
            throw new OperatorError('Stale preparation checkpoint: ' + name + '. Reload saved progress before continuing.');
}
export async function withPreparationWriter<T>(project: string, command: string, action: () => Promise<T>): Promise<T> {
    project = await canonicalProject(project);
    const inherited = scope.getStore();
    if (inherited) {
        if (!inherited.accepting || inherited.project !== project)
            throw new OperatorError('Preparation checkpoint scope is closed or belongs to another project.');
        return withWriter(project, command, async () => {
            await inherited.tail;
            await compare(inherited);
            return action();
        });
    }
    return withWriter(project, command, async () => {
        const root = path.join(harnessDirectory(project), 'acceptance'), expected = new Map<string, string | undefined>();
        // Writer acquisition creates the sidecar root before any provider request.
        for (const name of await names(root))
            expected.set(name, await read(root, name));
        const frame: Frame = { project, root, expected, active: true, accepting: true, tail: Promise.resolve() };
        return scope.run(frame, async () => {
            try {
                const result = await action();
                await frame.tail;
                if (frame.failure) throw frame.failure;
                return result;
            } finally {
                frame.accepting = false;
                await frame.tail;
                frame.active = false;
            }
        });
    });
}
function context(file: string): {
    frame: Frame;
    name: string;
    root: string;
} | undefined {
    const resolved = path.resolve(file), frame = scope.getStore();
    // Only these domain records use the consolidated store; histories and approvals keep their own lifecycle.
    const marker = resolved.lastIndexOf('/acceptance/'), relative = marker < 0 ? '' : resolved.slice(marker + 12);
    if (!managed(relative))
        return;
    if (!frame || !frame.accepting)
        throw new OperatorError('A live preparation checkpoint scope is required.');
    return { frame, name: relative, root: resolved.slice(0, marker) };
}
function enqueue(frame: Frame, action: () => Promise<void>): Promise<void> {
    const next = frame.tail.then(async () => {
        if (frame.failure) throw frame.failure;
        await action();
    });
    frame.tail = next.catch(error => { frame.failure = error; });
    return next;
}
export async function atomicWrite(file: string, text: string): Promise<void> {
    const current = context(file);
    if (!current)
        return writeOtherFile(file, text);
    const { frame, name } = current;
    if (Buffer.byteLength(text) > limit)
        throw new OperatorError('Preparation checkpoint exceeds the 8 MiB storage limit.');
    return enqueue(frame, async () => {
        if (await canonicalProject(current.root) !== path.dirname(frame.root))
            throw new OperatorError('Preparation checkpoint belongs to another project.');
        await compare(frame);
        const target = await safePath(path.dirname(frame.root), 'acceptance/' + name);
        await atomicBytes(target, Buffer.from(text), 0o600, path.dirname(target), () => compare(frame));
        // Publication precedes the journal pin. Keep the new expectation even if journaling fails.
        frame.expected.set(name, text);
        await checkpointSavedFile(target, 'preparation', 'checkpoint');
    });
}
export async function removePreparationFile(file: string, options?: {
    force?: boolean;
}): Promise<void> {
    const current = context(file);
    if (!current)
        return rm(file, options);
    const { frame, name } = current;
    return enqueue(frame, async () => {
        if (await canonicalProject(current.root) !== path.dirname(frame.root))
            throw new OperatorError('Preparation checkpoint belongs to another project.');
        await compare(frame);
        const target = await safePath(path.dirname(frame.root), 'acceptance/' + name);
        await rm(target, options);
        frame.expected.set(name, undefined);
        await syncDirectory(path.dirname(target));
    });
}
