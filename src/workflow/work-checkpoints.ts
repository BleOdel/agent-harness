import { checkpointSavedFile, assertOperationOwner } from './operations.ts';
import { withWriter } from '../workspace/writer-lock.ts';
import { safePath } from '../workspace/safe-path.ts';
/** Unverified source checkpoints live outside the project and are never applied directly. */
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, rmdir, open } from 'node:fs/promises';
import path from 'node:path';
import { assertSnapshot, captureBaseline, copySource, sourceFiles, type Snapshot } from '../workspace/candidate.ts';
import { sourceExclusion } from '../workspace/changes.ts';
import { atomicBytes, syncDirectory } from '../workspace/atomic.ts';
import { harnessDirectory } from '../record/record.ts';
import { readArtifact } from '../planning/store.ts';
import { OperatorError } from '../verbs/io.ts';
export interface CheckpointInputs {
    goal: string;
    workDigest: string;
    approvalDigest: string;
    executionDigest: string;
    baseline: Pick<Snapshot, 'identityVersion' | 'digest' | 'controls' | 'exclusions' | 'productDigest'>;
}
export type WorkFailure = "timeout" | "output-limit" | "provider-auth" | "provider-quota" | "provider-network" | "provider" | "exit" | "cancelled" | "verification" | "host-interrupted";
export function classifyWorkFailure(message: string): WorkFailure { if (/auth|token.*expired|refresh.*token|401/i.test(message))
    return "provider-auth"; if (/quota|usage.limit|rate.limit|429/i.test(message))
    return "provider-quota"; if (/network|transport|disconnect|ECONN|fetch failed/i.test(message))
    return "provider-network"; return "provider"; }
interface State extends CheckpointInputs {
    version: 1 | 2;
    failure?: {
        kind: WorkFailure;
        workerStopped: true;
    };
    project: string;
    runId: string;
    savedAt: string;
    attempt: number;
    instruction: string;
    partial: Pick<Snapshot, 'identityVersion' | 'digest' | 'files' | 'exclusions'>;
    status: 'available' | 'completed' | 'superseded' | 'discarded';
    updatedBy?: string;
}
export interface WorkCheckpoint extends State {
    directory: string;
}
const receipts = new WeakMap<WorkCheckpoint, {
    raw: string;
    value: string;
}>();
function remember(c: WorkCheckpoint, raw: string): WorkCheckpoint { receipts.set(c, { raw, value: JSON.stringify(c) }); return c; }
async function current(c: WorkCheckpoint): Promise<string> {
    const expected = receipts.get(c);
    if (!expected || expected.value !== JSON.stringify(c))
        throw new OperatorError('Read an unchanged checkpoint receipt before using saved work.');
    await safePath(harnessDirectory(c.project), `implementation/${c.runId}/state.json`);
    const raw = await readArtifact(c.directory, 'state.json', 4 * 1024 * 1024);
    if (raw !== expected.raw)
        throw new OperatorError('Stale implementation checkpoint; reload saved work.');
    return raw;
}
const root = (project: string) => path.join(harnessDirectory(project), 'implementation');
const validId = (id: string) => /^r[1-9][0-9]*$/.test(id);
const hex = (s: unknown) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const remedy = 'Saved work was retained. Restore the original inputs, or use harness work --fresh <item-id> to start from the current project.';
async function boundedSource(directory: string, exclusions: readonly string[]): Promise<void> {
    let bytes = 0, count = 0;
    async function walk(prefix = ''): Promise<void> {
        for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (sourceExclusion(relative, exclusions) || relative === '.harness-claim.json')
                continue;
            const stat = await lstat(path.join(directory, relative));
            if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1))
                throw new OperatorError(`Cannot checkpoint ${relative}: symlink, hard link or special file.`);
            if (stat.isDirectory())
                await walk(relative);
            else {
                bytes += stat.size;
                if (++count > 10000 || stat.size > 8 * 1024 * 1024 || bytes > 64 * 1024 * 1024)
                    throw new OperatorError('Partial source exceeds checkpoint limits (10,000 files, 8 MiB per file, 64 MiB total).');
            }
        }
    }
    await walk();
}
async function writeState(checkpoint: WorkCheckpoint): Promise<void> { const { directory, ...state } = checkpoint; const bytes = Buffer.from(JSON.stringify(state, null, 2) + '\n'); if (bytes.length > 4 * 1024 * 1024)
    throw new OperatorError('Checkpoint metadata exceeds the 4 MiB limit.'); await atomicBytes(path.join(directory, 'state.json'), bytes, 0o600); }
async function saveWorkCheckpointUnlocked(project: string, runId: string, worker: string, input: CheckpointInputs & {
    attempt: number;
    instruction: string;
    failure?: {
        kind: WorkFailure;
        workerStopped: true;
    };
}): Promise<WorkCheckpoint> {
    project = await realpath(project);
    if (!validId(runId))
        throw new OperatorError('Invalid checkpoint run id.');
    await boundedSource(worker, input.baseline.exclusions ?? []);
    await safePath(harnessDirectory(project), `implementation/${runId}/state.json`);
    await mkdir(root(project), { recursive: true, mode: 0o700 });
    const pending = await mkdtemp(path.join(root(project), '.pending-'));
    try {
        const partial = await captureBaseline(worker, path.join(pending, 'source'), input.baseline.exclusions);
        const state: WorkCheckpoint = { ...input, baseline: { identityVersion: 2, digest: input.baseline.digest, ...(input.baseline.productDigest ? { productDigest: input.baseline.productDigest } : {}), ...(input.baseline.controls ? { controls: input.baseline.controls } : {}), ...(input.baseline.exclusions ? { exclusions: input.baseline.exclusions } : {}) }, version: 2, failure: input.failure ?? { kind: "verification", workerStopped: true }, project, runId, savedAt: new Date().toISOString(), partial: { identityVersion: 2, digest: partial.digest, files: partial.files, ...(partial.exclusions ? { exclusions: partial.exclusions } : {}) }, status: 'available', directory: pending };
        // Flush source bytes before publishing the manifest; a visible checkpoint is complete.
        for (const file of Object.keys(partial.files)) {
            const h = await open(path.join(pending, 'source', file), 'r');
            try {
                await h.sync();
            }
            finally {
                await h.close();
            }
        }
        const directories = new Set(['source']);
        for (const file of Object.keys(partial.files)) {
            let d = path.posix.dirname(`source/${file}`);
            while (d !== '.') {
                directories.add(d);
                d = path.posix.dirname(d);
            }
        }
        for (const d of [...directories].sort((a, b) => b.length - a.length))
            await syncDirectory(path.join(pending, d));
        await rm(path.join(pending, 'source.json'));
        await writeState(state);
        const directory = path.join(root(project), runId);
        await rename(pending, directory);
        await syncDirectory(root(project));
        await checkpointSavedFile(path.join(directory, 'state.json'), 'implementation', 'paused');
        return remember({ ...state, directory }, (await readArtifact(directory, 'state.json', 4 * 1024 * 1024))!);
    }
    finally {
        await rm(pending, { recursive: true, force: true });
    }
}
async function readCheckpoint(project: string, runId: string): Promise<WorkCheckpoint | undefined> {
    if (!validId(runId))
        throw new OperatorError('Invalid checkpoint run id.');
    const directory = path.join(root(project), runId);
    await safePath(harnessDirectory(project), `implementation/${runId}/state.json`).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT')
        throw e; });
    const stat = await lstat(directory).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT')
        return undefined; throw e; });
    if (!stat)
        return;
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new OperatorError('Checkpoint must be a real directory.');
    const raw = await readArtifact(directory, 'state.json', 4 * 1024 * 1024);
    if (!raw)
        return;
    const s = JSON.parse(raw) as State;
    if (!s || (s.version !== 1 && s.version !== 2) || s.project !== project || s.runId !== runId || typeof s.goal !== 'string' || !s.goal || typeof s.instruction !== 'string' || !s.instruction || ![1, 2].includes(s.attempt) || !['available', 'completed', 'superseded', 'discarded'].includes(s.status) || ![s.workDigest, s.approvalDigest, s.executionDigest, s.baseline?.digest, s.partial?.digest].every(hex) || !s.partial?.files || typeof s.partial.files !== 'object' || Array.isArray(s.partial.files))
        throw new OperatorError('Invalid saved implementation checkpoint.', remedy);
    if (s.version === 2 && (!s.failure || s.failure.workerStopped !== true || !['timeout', 'output-limit', 'provider-auth', 'provider-quota', 'provider-network', 'provider', 'exit', 'cancelled', 'verification', 'host-interrupted'].includes(s.failure.kind)))
        throw new OperatorError('Invalid checkpoint failure classification.');
    for (const exclusions of [s.baseline.exclusions, s.partial.exclusions])
        if (exclusions !== undefined && (!Array.isArray(exclusions) || exclusions.some(v => typeof v !== 'string')))
            throw new OperatorError('Invalid checkpoint exclusions.');
    if (JSON.stringify(s.baseline.exclusions ?? []) !== JSON.stringify(s.partial.exclusions ?? []) || (s.baseline.controls !== undefined && !hex(s.baseline.controls)))
        throw new OperatorError('Invalid checkpoint source identity.');
    return remember({ ...s, directory }, raw);
}
export async function listWorkCheckpoints(project: string): Promise<WorkCheckpoint[]> {
    project = await realpath(project);
    const entries = await readdir(root(project)).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT')
        return []; throw e; });
    const result: WorkCheckpoint[] = [];
    for (const id of entries.filter(validId).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))) {
        const c = await readCheckpoint(project, id);
        if (c?.status === 'available')
            result.push(c);
    }
    return result;
}
export async function findWorkCheckpoint(project: string, goal?: string, runId?: string): Promise<WorkCheckpoint | undefined> {
    project = await realpath(project);
    if (runId) {
        const c = await readCheckpoint(project, runId);
        if (!c || c.status !== 'available')
            throw new OperatorError(`No available implementation checkpoint for ${runId}.`);
        if (goal !== undefined && c.goal !== goal)
            throw new OperatorError('Checkpoint belongs to a different task.');
        return c;
    }
    return (await listWorkCheckpoints(project)).find(c => c.goal === goal);
}
export function assertCheckpointInputs(c: WorkCheckpoint, input: CheckpointInputs): void {
    if (c.baseline.identityVersion !== 2 || c.partial.identityVersion !== 2)
        throw new OperatorError('Legacy byte-only checkpoint retained for recovery; fresh mode-aware verification is required.', remedy);
    for (const name of ['goal', 'workDigest', 'approvalDigest', 'executionDigest'] as const)
        if (c[name] !== input[name])
            throw new OperatorError(`Cannot resume ${c.runId}: ${name} changed.`, remedy);
    if (c.baseline.productDigest !== input.baseline.productDigest)
        throw new OperatorError(`Cannot resume ${c.runId}: product specification changed.`, remedy);
    if (c.baseline.digest !== input.baseline.digest || c.baseline.controls !== input.baseline.controls || JSON.stringify(c.baseline.exclusions ?? []) !== JSON.stringify(input.baseline.exclusions ?? []))
        throw new OperatorError(`Cannot resume ${c.runId}: project source or requirements changed.`, remedy);
}
async function restoreWorkCheckpointUnlocked(c: WorkCheckpoint, target: string): Promise<void> {
    await current(c);
    if (c.status !== 'available')
        throw new OperatorError('Implementation checkpoint is retired.');
    const directory = path.join(c.directory, 'source'), stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new OperatorError('Checkpoint source must be a real directory.');
    await boundedSource(directory, c.partial.exclusions ?? []);
    await assertSnapshot({ ...c.partial, directory });
    await current(c);
    await mkdir(target, { recursive: true });
    const parents = new Set<string>();
    for (const file of Object.keys(await sourceFiles(target, '', c.partial.exclusions))) {
        await rm(path.join(target, file));
        let d = path.dirname(file);
        while (d !== '.') {
            parents.add(d);
            d = path.dirname(d);
        }
    }
    // Remove only empty source directories: an old directory may now be a file.
    for (const d of [...parents].sort((a, b) => b.length - a.length))
        await rmdir(path.join(target, d)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT')
            throw error; });
    // A previous claim cannot stand in for completion after an interruption.
    await rm(path.join(target, '.harness-claim.json'), { force: true });
    await copySource(directory, target, c.partial.exclusions);
    await assertSnapshot({ ...c.partial, directory: target });
}
export async function saveWorkCheckpoint(...args: Parameters<typeof saveWorkCheckpointUnlocked>): Promise<WorkCheckpoint> {
    return withWriter(args[0], 'work checkpoint', () => saveWorkCheckpointUnlocked(...args));
}
export async function restoreWorkCheckpoint(c: WorkCheckpoint, target: string): Promise<void> {
    return withWriter(c.project, 'work checkpoint', () => restoreWorkCheckpointUnlocked(c, target));
}
export async function retireWorkCheckpoint(c: WorkCheckpoint, status: 'completed' | 'superseded' | 'discarded', updatedBy: string): Promise<void> {
    await withWriter(c.project, 'work checkpoint', async () => {
        if (!validId(updatedBy))
            throw new OperatorError('Invalid checkpoint successor run id.');
        await current(c);
        if (c.status !== 'available') {
            if (c.status === status && c.updatedBy === updatedBy)
                return;
            throw new OperatorError('Implementation checkpoint is already retired.');
        }
        const { directory, ...state } = { ...c, status, updatedBy };
        const raw = JSON.stringify(state, null, 2) + '\n';
        await atomicBytes(path.join(directory, 'state.json'), Buffer.from(raw), 0o600, directory, async () => { await assertOperationOwner(c.project); await current(c); });
        Object.assign(c, { status, updatedBy });
        remember(c, raw);
        // Retirement is checkpoint bookkeeping, not proof that a task completed.
        await checkpointSavedFile(path.join(directory, 'state.json'), 'implementation', 'checkpoint');
    });
}
