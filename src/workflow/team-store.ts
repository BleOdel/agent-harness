/** Guarded immutable team journal; state.json is a disposable cache, never read authority. */
import { randomUUID, createHash } from 'node:crypto';
import { link, mkdir, open, readdir, rename, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { reduceTeam } from './team.ts';
import { checkpointSavedFile, assertOperationOwner } from './operations.ts';
import { acquireWriter, canonicalProject, withWriter } from '../workspace/writer-lock.ts';
import { safePath } from '../workspace/safe-path.ts';
import { readArtifact } from '../workspace/artifact.ts';
import { digest, type EventPayload, type TeamEvent, type TeamState, type TeamPlan, type Policy } from '../team/schema.ts';
import type { Snapshot } from '../workspace/candidate.ts';
import type { ExecutionPin } from '../project/execution.ts';
async function syncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, "r");
    try {
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
export async function atomicJson(file: string, value: unknown, exclusive = false, beforePublish?: () => Promise<void>): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
        await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        await beforePublish?.();
        if (exclusive) {
            await link(temporary, file);
            await unlink(temporary);
        }
        else
            await rename(temporary, file);
        await syncDirectory(path.dirname(file));
    }
    catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
    }
}
interface Journal {
    events: TeamEvent[];
    fingerprint: string;
    state: TeamState;
}
const observations = new WeakMap<TeamState, {
    root: string;
    fingerprint: string;
}>();
function owner(root: string): string | undefined { const teams = path.dirname(root), base = path.dirname(teams); return path.basename(teams) === 'teams' && base.endsWith('-harness') ? base.slice(0, -8) : undefined; }
async function checkedRoot(root: string): Promise<string> {
    root = path.resolve(root);
    const project = owner(root);
    if (project) {
        const stat = await lstat(project + '-harness');
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw Error('Team owner must be a real directory, not a link.');
    }
    if (project)
        await safePath(project + '-harness', path.relative(project + '-harness', root) + '/events/00000001.json');
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw Error('Team journal must be a real directory, not a link.');
    return canonicalProject(root);
}
async function owned<T>(root: string, action: (operationId?: string) => Promise<T>): Promise<T> {
    const initialOwner = owner(path.resolve(root));
    if (initialOwner) {
        try {
            const stat = await lstat(initialOwner + '-harness');
            if (!stat.isDirectory() || stat.isSymbolicLink())
                throw Error('Team owner must be a real directory, not a link.');
            await safePath(initialOwner + '-harness', path.relative(initialOwner + '-harness', path.resolve(root)) + '/events/00000001.json');
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw error;
        }
    }
    await mkdir(root, { recursive: true, mode: 0o700 });
    root = await checkedRoot(root);
    const project = owner(root);
    if (project)
        return withWriter(project, 'team state', async () => action(await assertOperationOwner(project)), true);
    // Standalone legacy adapters/tests have no project owner. Serialize their writes locally.
    const lease = await acquireWriter(path.join(root, '.journal'), 'team state');
    try {
        await lease.assertOwned();
        return await action();
    }
    finally {
        await lease.release();
    }
}
async function journal(root: string): Promise<Journal> {
    root = await checkedRoot(root);
    await safePath(root, 'events/00000001.json');
    const entries = await readdir(path.join(root, 'events'));
    const names = entries.filter(n => n.endsWith('.json')).sort();
    if (names.length > 100000 || names.some((n, i) => n !== String(i + 1).padStart(8, '0') + '.json'))
        throw Error('Team event sequence has a gap or invalid filename.');
    const hash = createHash('sha256'), events: TeamEvent[] = [];
    let state: TeamState | undefined;
    for (const name of names) {
        await safePath(root, 'events/' + name);
        const raw = await readArtifact(root, 'events/' + name, 8 * 1024 * 1024);
        if (raw === undefined)
            throw Error('Team journal changed while reading.');
        hash.update(name + '\0' + raw + '\0');
        const event = JSON.parse(raw) as TeamEvent;
        state = reduceTeam(state, event);
        events.push(event);
    }
    if (!state)
        throw Error('No committed team creation event.');
    return { events, state, fingerprint: hash.digest('hex') };
}
function remember(root: string, j: Journal): TeamState { observations.set(j.state, { root, fingerprint: j.fingerprint }); return j.state; }
async function assertOwner(root: string): Promise<void> {
    const project = owner(root);
    if (project)
        await assertOperationOwner(project);
}
async function projection(root: string, j: Journal) {
    const state = j.state;
    await safePath(root, 'state.json');
    await atomicJson(path.join(root, 'state.json'), state, false, async () => {
        await assertOwner(root);
        await safePath(root, 'state.json');
        if ((await journal(root)).fingerprint !== j.fingerprint)
            throw Error('Stale team projection; reload the journal.');
    });
    await checkpointSavedFile(path.join(root, 'events', String(state.seq).padStart(8, '0') + '.json'), 'team', state.status === 'staged' ? 'approval' : state.status === 'applied' || state.status === 'undone' ? 'complete' : state.status === 'running' ? 'checkpoint' : 'attention');
}
/** Ordinary status is read-only. Explicit cache repair runs under the same writer as event publication. */
export async function readState(root: string, repairProjection = false): Promise<TeamState> {
    root = await checkedRoot(root);
    if (repairProjection)
        return owned(root, async () => { const j = await journal(root); await projection(root, j); return remember(root, j); });
    return remember(root, await journal(root));
}
export async function createState(root: string, plan: TeamPlan, baseline: Snapshot, policy: Policy, runId = `team-${randomUUID()}`, verificationDigest?: string, execution?: ExecutionPin): Promise<TeamState> {
    return owned(root, async (operationId) => {
        root = await checkedRoot(root);
        const event: TeamEvent = { version: execution ? 4 : 3, ...(operationId ? { operationId } : {}), ...(execution ? { execution } : {}), seq: 1, at: new Date().toISOString(), type: 'created', ...(verificationDigest === undefined ? {} : { verificationDigest }), runId, plan, planDigest: digest(plan), baseline, policy };
        reduceTeam(undefined, event);
        await safePath(root, 'events/00000001.json');
        await atomicJson(path.join(root, 'events', '00000001.json'), event, true, async () => { await assertOwner(root); await safePath(root, 'events/00000001.json'); });
        const j = await journal(root);
        await projection(root, j);
        return remember(root, j);
    });
}
/** Optional expected state is mandatory for controller decisions; legacy callers retain serialized append. */
export async function appendEvent(root: string, payload: EventPayload, expected?: TeamState): Promise<TeamState> {
    return owned(root, async (operationId) => {
        root = await checkedRoot(root);
        const j = await journal(root), previous = j.state;
        if (expected) {
            const receipt = observations.get(expected);
            if (!receipt || receipt.root !== root)
                throw Error('Team decision requires its original journal read.');
            if (receipt.fingerprint !== j.fingerprint)
                throw Error('Stale team decision; reload the journal before dispatch.');
        }
        const identity = 'attemptId' in payload ? 'attemptId' : 'transactionId' in payload ? 'transactionId' : undefined;
        if (identity) {
            const same = j.events.find(e => identity in e && (e as unknown as Record<string, unknown>)[identity] === (payload as unknown as Record<string, unknown>)[identity] && e.type === payload.type);
            if (same) {
                const { version: _v, seq: _s, at: _a, runId: _r, operationId: _o, ...stored } = same;
                if (digest(stored) !== digest(payload))
                    throw Error('Conflicting duplicate attempt result.');
                await projection(root, j);
                return remember(root, j);
            }
        }
        const event = { ...payload, ...(operationId ? { operationId } : {}), version: previous.version, seq: previous.seq + 1, at: new Date().toISOString(), runId: previous.runId } as TeamEvent;
        reduceTeam(previous, event);
        const file = 'events/' + String(event.seq).padStart(8, '0') + '.json';
        await safePath(root, file);
        await atomicJson(path.join(root, file), event, true, async () => {
            await assertOwner(root);
            await safePath(root, file);
            if ((await journal(root)).fingerprint !== j.fingerprint)
                throw Error('Stale team journal before publication.');
        });
        const committed = await journal(root);
        await projection(root, committed);
        return remember(root, committed);
    });
}
