/** One read-only selection for preparation dispatch, retry identity and operator status. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readArtifact } from '../workspace/artifact.ts';
import { safePath } from '../workspace/safe-path.ts';
import { canonicalProject } from '../workspace/writer-lock.ts';
import { readActivePreparation } from '../acceptance/active-preparation.ts';
import { OperatorError } from '../verbs/io.ts';
export interface PreparationNextAction {
    taskId: string;
    operation: string;
    phase: 'outline' | 'generation' | 'review' | 'simplification' | 'recipe';
    source: string;
    check?: string;
    command: string;
}
export interface PreparationProgress {
    key: string;
    legacyKey?: string;
    stage: string;
    retryCounts: Record<string, number>;
    nextAction?: PreparationNextAction;
}
export interface PreparationSelection {
    readonly kind: 'select' | 'start' | 'resume' | 'simplify' | 'recipe';
    readonly taskId?: string;
    readonly primary?: {
        name: string;
        raw: string;
    };
    readonly pending?: {
        name: string;
        raw: string;
    };
    readonly progress: PreparationProgress;
}
const names = ['preparation.json', 'review-progress.json', 'simplification.json', 'recipe-change.json', 'guided-draft.json'] as const;
const observations = new WeakMap<PreparationSelection, {
    project: string;
    taskId: string | undefined;
    fingerprint: string;
}>();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 500 && !value.includes('\0'); }
export async function readPreparationSelection(project: string, taskId?: string): Promise<PreparationSelection> {
    project = await canonicalProject(project);
    const root = project + '-harness', directory = path.join(root, 'acceptance');
    const raw: Record<string, string | undefined> = {};
    for (const name of names) {
        try {
            await safePath(root, 'acceptance/' + name);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw error;
        }
        raw[name] = await readArtifact(directory, name, 8 * 1024 * 1024);
    }
    if (raw['simplification.json'] && raw['recipe-change.json'])
        throw new OperatorError('Conflicting saved preparation branches: simplification and recipe migration are both pending.', 'Inspect the retained records before continuing; nothing was selected or discarded.');
    const active = await readActivePreparation(directory);
    // Detect a phase file replaced while the multi-file selection was read.
    if (active && raw[active.name] !== active.raw)
        throw new OperatorError('Preparation changed while selecting its owner. Reload saved progress.');
    const record = active ? JSON.parse(active.raw) : undefined;
    if (record && (!text(record.taskId) || !text(record.taskDigest) || !text(record.sourceDigest)))
        throw new OperatorError('Invalid saved preparation identity.');
    const name = raw['simplification.json'] ? 'simplification.json' : raw['recipe-change.json'] ? 'recipe-change.json' : undefined;
    let kind: PreparationSelection['kind'] = 'select', progress: PreparationProgress = { key: 'new', stage: 'outline', retryCounts: {} };
    let selectedTask = taskId ?? record?.taskId;
    if (name) {
        const pending = JSON.parse(raw[name]!);
        if (!record || active?.name !== 'review-progress.json')
            throw new OperatorError('Pending check migration has no matching active review.', 'Inspect retained preparation; a newer task or generation phase must not be replaced.');
        if (pending.version !== 1 || !text(pending.scope) || !text(pending.baseDigest) || pending.taskDigest !== record.taskDigest || pending.sourceDigest !== record.sourceDigest || pending.taskId !== undefined && pending.taskId !== record.taskId)
            throw new OperatorError('Pending check migration describes different preparation inputs.');
        if (taskId !== undefined && taskId !== record.taskId)
            throw new OperatorError('Another task has unfinished check preparation. Resolve it before switching tasks.');
        const simplification = name === 'simplification.json';
        const baseMatches = pending.baseDigest === (simplification ? hash(record.proposal) : hash(active.raw));
        const committed = simplification ? pending.completedDigest === hash(record.proposal) : pending.committedDigest === hash(active.raw);
        if (!baseMatches && !committed)
            throw new OperatorError('Pending check migration does not match the retained review.');
        // A completed migration can retain its cleanup marker after removing the original case.
        if (!committed && !record.proposal?.manifest?.cases?.some((c: {
            id: string;
        }) => c.id === pending.scope))
            throw new OperatorError('Pending check migration names an unknown check.');
        kind = simplification ? 'simplify' : 'recipe';
        selectedTask = record.taskId;
        const phase = simplification ? 'simplification' : 'recipe';
        progress = { key: `${record.taskId}:${record.taskDigest}:${record.sourceDigest}:${record.operation?.id ?? 'legacy'}:${phase}:${pending.baseDigest}`, stage: pending.scope, retryCounts: {}, nextAction: { taskId: record.taskId, operation: record.operation?.id ?? 'legacy', phase, source: name, check: pending.scope, command: `harness checks ${simplification ? 'simplify' : 'use-recipe'} ${pending.scope}` } };
    }
    else if (record && (taskId === undefined || taskId === record.taskId)) {
        kind = 'resume';
        const state = active!.name === 'preparation.json' ? record.state : undefined;
        const ledger = state?.reviewLedger ?? record.ledger, operation = record.operation?.id ?? 'legacy';
        const cases = state?.blueprint?.cases ?? record.proposal?.manifest?.cases ?? [];
        if (!Array.isArray(cases) || ledger !== undefined && !Array.isArray(ledger?.entries))
            throw new OperatorError('Invalid saved preparation progress.');
        const entries = ledger?.entries ?? [];
        const failed = entries.find((e: any) => e.scope !== '$contract' && (e.pendingRepair || e.review?.verdict === 'repair'))?.scope;
        const check = failed ?? state?.pendingCase?.id ?? cases.find((c: any) => state ? !state.cases?.some((g: any) => g.id === c.id) : !entries.some((e: any) => e.scope === c.id && e.review?.verdict === 'pass'))?.id;
        const phase: PreparationNextAction['phase'] = !cases.length ? 'outline' : active!.name === 'review-progress.json' || (check && state?.cases?.some((c: any) => c.id === check)) ? 'review' : 'generation';
        progress = { key: `${record.taskId}:${record.taskDigest}:${record.sourceDigest}:${operation}`, legacyKey: `${record.taskDigest}:${record.sourceDigest}`, stage: check ?? phase, retryCounts: Object.fromEntries(entries.map((e: any) => { if (!text(e.scope) || e.retryCount !== undefined && (!Number.isSafeInteger(e.retryCount) || e.retryCount < 0))
                throw new OperatorError('Invalid saved preparation retry count.'); return [e.scope, e.retryCount ?? 0]; })), nextAction: { taskId: record.taskId, operation, phase, source: active!.name, ...(check ? { check } : {}), command: 'harness checks prepare' } };
    }
    else if (taskId !== undefined) {
        kind = 'start';
        progress = { key: `new:${taskId}`, stage: 'outline', retryCounts: {} };
    }
    const selection: PreparationSelection = Object.freeze({ kind, ...(selectedTask ? { taskId: selectedTask } : {}), ...(active ? { primary: Object.freeze({ ...active }) } : {}), ...(name ? { pending: Object.freeze({ name, raw: raw[name]! }) } : {}), progress: Object.freeze({ ...progress, retryCounts: Object.freeze(progress.retryCounts), ...(progress.nextAction ? { nextAction: Object.freeze(progress.nextAction) } : {}) }) });
    observations.set(selection, { project, taskId, fingerprint: hash({ raw, active: active?.name, kind, selectedTask }) });
    return selection;
}
/** Re-read under the command writer immediately before invoking the selected callback. */
export async function assertPreparationSelection(project: string, selection: PreparationSelection): Promise<void> {
    const expected = observations.get(selection);
    project = await canonicalProject(project);
    if (!expected || expected.project !== project)
        throw new OperatorError('Preparation dispatch requires its original project selection.');
    const current = await readPreparationSelection(project, expected.taskId);
    if (observations.get(current)!.fingerprint !== expected.fingerprint)
        throw new OperatorError('Stale preparation selection; reload saved progress before dispatch.');
}
