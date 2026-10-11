/** Read-only reconciliation. Execution receipts never replace domain evidence or approval. */
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { canonicalProject, withWriter, writerPath } from '../workspace/writer-lock.ts';
import { readArtifact } from '../workspace/artifact.ts';
import { safePath } from '../workspace/safe-path.ts';
import { readOperation, operationProjection, type DurableOperation } from './operations.ts';
import { readContinuation } from './store.ts';
import { listStages } from '../staging/store.ts';
import { listWorkCheckpoints } from './work-checkpoints.ts';
import { unfinishedWorkAttempts } from '../workspace/work-attempts.ts';
import { readPreparationSelection } from './preparation-selection.ts';
import { readApproval } from '../acceptance/checks.ts';
import { readFeatures } from '../features.ts';
import { readState } from './team-store.ts';
import { OperatorError } from '../verbs/io.ts';
export interface WorkflowAction {
    kind: 'owner' | 'application' | 'worker' | 'team' | 'stage' | 'operation' | 'continuation' | 'implementation' | 'preparation' | 'attention';
    title: string;
    message: string;
    command: string;
    href: string;
}
export interface WorkflowStatus {
    version: 1;
    fingerprint: string;
    operation?: DurableOperation;
    action?: WorkflowAction;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const attention = (message: string): WorkflowAction => ({ kind: 'attention', title: 'Project data needs attention', message, command: 'harness doctor', href: '#attention' });
const action = (kind: WorkflowAction['kind'], title: string, message: string, command: string, href = '#attention'): WorkflowAction => ({ kind, title, message, command, href });
async function optional(root: string, name: string): Promise<string | undefined> {
    try {
        await safePath(root, name);
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return;
        throw error;
    }
    return readArtifact(root, name, 8 * 1024 * 1024);
}
async function collect(project: string) {
    const root = project + '-harness', lock = await writerPath(project);
    const ownerRaw = await optional(path.dirname(lock), path.basename(lock)), guard = await optional(path.dirname(lock), path.basename(lock) + '.recovery');
    let owner: {
        token: string;
        pid: number;
        host: string;
        command: string;
    } | undefined;
    if (ownerRaw) {
        const v = JSON.parse(ownerRaw);
        if (v.version !== 1 || !/^[-a-f0-9]{36}$/.test(v.token) || !Number.isSafeInteger(v.pid) || v.pid < 1 || typeof v.host !== 'string' || typeof v.command !== 'string')
            throw new OperatorError('Invalid retained writer owner.');
        owner = v;
    }
    const operation = await readOperation(project), application = await optional(root, 'application.json'), stagedApplication = await optional(root, 'staged-application.json');
    const features = await readFeatures(project);
    if (features && !features.ok)
        throw new OperatorError(features.reason);
    const stages = await listStages(project), attempts = await unfinishedWorkAttempts(project), implementations = await listWorkCheckpoints(project), continuation = await readContinuation(project), preparation = await readPreparationSelection(project), approval = await readApproval(project);
    const teams: {
        id: string;
        seq: number;
        status: string;
        unfinished: boolean;
    }[] = [];
    const entries = await readdir(path.join(root, 'teams')).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT')
        return []; throw e; });
    if (entries.length > 256)
        throw new OperatorError('Team status exceeds the bounded inspection limit.');
    for (const id of entries.filter(n => /^team-[A-Za-z0-9_-]+$/.test(n)).sort()) {
        await safePath(root, `teams/${id}/events/probe.json`);
        const s = await readState(path.join(root, 'teams', id), false);
        teams.push({ id, seq: s.seq, status: s.status, unfinished: s.attempts.some(a => ['running', 'submitted', 'verified'].includes(a.status)) });
    }
    return { owner, ownerRaw, guard, operation, application, stagedApplication, features: features?.ok ? features.features : [], stages, attempts, implementations, continuation, preparation, approval, teams };
}
type Facts = Awaited<ReturnType<typeof collect>>;
function recovery(f: Facts): WorkflowAction | undefined {
    if (f.guard)
        return attention('An explicit writer recovery is in progress or was interrupted. Inspect its retained guard before starting another command.');
    if (f.owner) {
        let dead = false;
        if (f.owner.host === hostname())
            try {
                process.kill(f.owner.pid, 0);
            }
            catch (e) {
                dead = (e as NodeJS.ErrnoException).code === 'ESRCH';
            }
        return action('owner', dead ? 'Recover the stopped writer' : 'Inspect operation ownership', `Writer ${f.owner.command} on ${f.owner.host}, pid ${f.owner.pid}, retains ownership. ${dead ? 'The local process is absent; explicit lock recovery does not reconcile workers or apply source.' : 'Process presence does not prove worker health. Wait or inspect the owner; do not steal its lock.'}`, dead ? `harness recover-lock ${f.owner.token}` : 'harness continue status');
    }
    if (f.application && f.stagedApplication)
        return attention('Both shared and legacy staged application journals are pending. Inspect the retained journals before selecting a recovery route.');
    if (f.application) {
        const p = JSON.parse(f.application);
        if (p.version === 2 && /^application-[a-f0-9-]+$/.test(p.id) && /^[a-f0-9]{64}$/.test(p.intentDigest))
            return action('application', 'Recover the interrupted application', 'The shared application journal takes priority over saved task and operation labels. Recovery revalidates retained source and intent before changing anything.', 'harness recover-application');
        if (p.version === 1 && /^team-[A-Za-z0-9_-]+$/.test(p.teamRunId))
            return action('application', 'Recover the legacy team application', 'The retained legacy journal must be reconciled before new work.', `harness team recover ${quote(p.teamRunId)}`);
        return attention('The application recovery marker is invalid; no recovery command was inferred.');
    }
    if (f.stagedApplication) {
        const p = JSON.parse(f.stagedApplication);
        if (p.version !== 1 || !/^r[1-9][0-9]*$/.test(p.id))
            return attention('The staged application marker is invalid.');
        return action('application', 'Recover the staged application', 'Resume the exact staged journal; completion and final review will be validated.', `harness stage apply ${p.id}`);
    }
    const applying = f.stages.filter(s => s.status === 'applying');
    if (applying.length > 1)
        return attention('Multiple staged applications claim to be applying. Inspect their retained intents.');
    if (applying[0])
        return action('application', 'Recover the staged application', 'The retained applying state requires recovery even if its pointer was not published.', `harness stage apply ${applying[0].id}`);
    if (f.attempts.length)
        return action('worker', 'Inspect unfinished implementation workers', `Unfinished runs: ${f.attempts.map(a => a.runId + ' (' + a.status + ')').join(', ')}. Confirm container termination and inspect retained source before resuming. A workspace pointer is not a verified checkpoint.`, 'harness look');
    const team = f.teams.find(t => t.unfinished || ['running', 'applying'].includes(t.status));
    if (team)
        return action('team', 'Recover the interrupted team', `${team.id} has retained ${team.status} state or unfinished attempts. Team recovery reconciles worker cleanup before recording interruption.`, `harness team recover ${quote(team.id)}`);
}
function select(f: Facts): WorkflowAction | undefined {
    const blocked = recovery(f);
    if (blocked)
        return blocked;
    const pending = f.stages.find(s => s.status === 'pending');
    if (pending)
        return action('stage', 'Review the staged candidate', `${pending.task}: the retained candidate awaits exact final review. No rebuild is needed.`, `harness stage review ${pending.id}`, '#review');
    const team = f.teams.find(t => t.status === 'staged');
    if (team)
        return action('team', 'Review staged team changes', 'The retained team candidate has not been applied.', `harness team inspect ${quote(team.id)}`, '#review');
    // An unresolved dispatch cannot be erased by a terminal-looking continuation or checkpoint.
    if (f.operation && operationProjection(f.operation).unresolved)
        return action('operation', 'Reconcile interrupted execution', 'No writer or unfinished application/worker was found. Explicit recovery records the interrupted execution; it does not approve checks, complete tasks or apply source.', `harness recover-operation ${f.operation.id} ${f.operation.revision}`);
    const state = f.continuation, task = state ? f.features.find(t => t.id === state.task) : undefined;
    if (state) {
        if (!task)
            return attention('The saved continuation task no longer exists. Inspect retained requirements before continuing.');
        if (task.status === 'done' && state.status !== 'complete')
            return action('continuation', 'Reconcile completed task status', 'The task is recorded done but continuation still shows ' + state.status + '. Continue rereads domain state before any model dispatch.', `harness continue ${quote(state.task)}`, '#journey');
        if (task.status !== 'done')
            return action('continuation', 'Continue the saved task', state.status === 'complete' ? 'The task was reopened after the saved continuation completed. Reconcile its current requirements and retained allowance.' : state.message, `harness continue ${quote(state.task)}`, '#journey');
    }
    const stopped = f.teams.find(t => ['stopped', 'aborted'].includes(t.status));
    if (stopped)
        return action('team', 'Review the stopped team', 'Worker recovery is clear; inspect the retained team before granting more work.', `harness team inspect ${quote(stopped.id)}`);
    const saved = f.implementations.find(c => f.features.find(t => t.id === c.goal)?.status !== 'done');
    if (saved)
        return action('implementation', 'Resume the saved implementation', `${saved.goal}: unverified files are retained. All source, approval and runtime bindings and verification gates will run again.`, `harness work --resume ${saved.runId}`, '#journey');
    const taskId = f.preparation.taskId;
    if (taskId && f.features.find(t => t.id === taskId)?.status !== 'done' && !f.approval?.manifest.cases.some(c => c.tasks.includes('*') || c.tasks.includes(taskId)) && f.preparation.progress.nextAction)
        return action('preparation', 'Continue saved check preparation', 'Saved progress is an unapproved design. Completed reviews and spent allowances remain retained.', f.preparation.progress.nextAction.command, '#journey');
}
export async function readWorkflowStatus(project: string): Promise<WorkflowStatus> {
    project = await canonicalProject(project);
    try {
        const first = await collect(project), second = await collect(project), fingerprint = digest(second);
        if (digest(first) !== fingerprint)
            return { version: 1, fingerprint, action: attention('Workflow changed while status was being read. Reload status before choosing an action.') };
        const next = select(second);
        return { version: 1, fingerprint, ...(second.operation ? { operation: second.operation } : {}), ...(next ? { action: next } : {}) };
    }
    catch (error) {
        return { version: 1, fingerprint: digest(String(error)), action: attention((error as Error).message) };
    }
}
export async function describeWorkflowStatus(project: string, write: (message: string) => void): Promise<WorkflowStatus> {
    const status = await readWorkflowStatus(project), op = status.operation;
    if (op) {
        write(`Operation ${op.id} · revision ${op.revision} · ${op.command}: ${op.state} (last recorded execution).`);
        write(operationProjection(op).detail);
    }
    if (status.action) {
        write(status.action.title + ': ' + status.action.message);
        write('Next: ' + status.action.command);
    }
    if (op || status.action)
        write('Recorded execution and recovery guidance do not prove task completion or grant application approval.');
    return status;
}
function domains(f: Facts) { const { operation: _operation, owner: _owner, ownerRaw: _raw, guard: _guard, ...rest } = f; return rest; }
export async function recoverOperation(project: string, id: string, revision: number): Promise<void> {
    project = await canonicalProject(project);
    const before = await collect(project);
    if (before.operation?.id !== id || before.operation.revision !== revision)
        throw new OperatorError('Stale operation guidance; reload status before recovery.');
    if (!operationProjection(before.operation).unresolved)
        throw new OperatorError('This operation has no unresolved execution.');
    const blocked = recovery(before);
    if (blocked)
        throw new OperatorError(blocked.message, blocked.command);
    await withWriter(project, 'operation recovery', async () => {
        const current = await collect(project);
        if (digest(domains(current)) !== digest(domains(before)))
            throw new OperatorError('Workflow changed during operation recovery; inspect retained records.');
        // withOperation archives unresolved dispatches as uncertain. No domain state is rewritten.
    }, false, { id, revision });
}
