import {readControllerState, saveControllerState, validateStateRevision} from '../workflow/state.ts';
import { describeOperation, withOperationPhase } from '../workflow/operations.ts';
import { caseKind, routeBlueprint } from './evidence-kind.ts';
import { readActivePreparation } from './active-preparation.ts';
import { CheckRequestInterrupted, transientCheckFailure } from './request-failure.ts';
/** One resumable controller; checkpoints and writer locks remain owned by existing check operations. */
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { CheckBudgetExceeded, withCheckBudget, ensureCheckBudget, defaultCheckLimits, validateCheckLimits, describeCheckSpend, type CheckLimits, type CheckSpend } from './budget.ts';
import { parseProposal } from './draft.ts';
import { blueprintProposal, parseBlueprint } from './preparation.ts';
import { assertServerRuntimes } from './server-runtime.ts';
import { assertRecipeStep } from './recipes/catalog.ts';
import { ScopeRepairBlocked, scopeDigest } from './scoped-review.ts';
import { readyCheckDraft, resumePreparation, repairSavedCheck, guidedSetup } from './guided.ts';
import { readArtifact } from '../planning/store.ts';
import { canonicalProject, withWriter } from '../workspace/writer-lock.ts';
import { choose, type Dialogue } from '../guide/dialogue.ts';
import { readFeatures } from '../features.ts';
import { OperatorError } from '../verbs/io.ts';
export type WorkflowOutcome = 'ready' | 'paused' | 'blocked';
interface WorkflowRun {
    started: string;
    limits: CheckLimits;
    spend: CheckSpend;
    status: 'running' | WorkflowOutcome;
}
export interface PreparationNextAction {
    taskId: string;
    operation: string;
    phase: 'outline' | 'generation' | 'review';
    source: string;
    check?: string;
    command: string;
}
export interface WorkflowState {
    revision?: number;
    operationId?: string;
    version: 1;
    nextAction?: PreparationNextAction;
    interruptions?: string[];
    retried: string[];
    runs: WorkflowRun[];
    pendingRetry?: {
        key: string;
        scope: string;
        epoch: number;
    };
    problem?: string;
}
interface Services {
    wait?: (ms: number) => Promise<void>;
    snapshot: () => Promise<{
        key: string;
        legacyKey?: string;
        stage?: string;
        ready: boolean;
        retryCounts?: Record<string, number>;
    }>;
    resume: () => Promise<void>;
    repair: (scope: string) => Promise<void>;
    save: () => Promise<void>;
    write: (s: string) => void;
}
export async function driveCheckWorkflow(state: WorkflowState, services: Services): Promise<WorkflowOutcome> {
    for (let step = 0; step < 100; step++) {
        const snapshot = await services.snapshot();
        if (snapshot.ready) {
            delete state.problem;
            delete state.pendingRetry;
            return 'ready';
        }
        // Legacy reservations bind to the same task/source digests. Carry spent grants
        // forward; introducing an operation ID must not mint another retry allowance.
        if (snapshot.legacyKey) {
            const prefix = snapshot.legacyKey + ':';
            let migrated = false;
            if (state.pendingRetry && state.pendingRetry.key === prefix + state.pendingRetry.scope) {
                state.pendingRetry.key = snapshot.key + ':' + state.pendingRetry.scope;
                migrated = true;
            }
            for (const old of [...state.retried])
                if (old.startsWith(prefix)) {
                    const next = snapshot.key + ':' + old.slice(prefix.length);
                    if (!state.retried.includes(next)) {
                        state.retried.push(next);
                        migrated = true;
                    }
                }
            if (migrated)
                await services.save();
        }
        if (state.pendingRetry) {
            const pending = state.pendingRetry;
            if (pending.key !== snapshot.key + ':' + pending.scope) {
                state.problem = 'Saved retry describes older preparation inputs.';
                await services.save();
                return 'blocked';
            }
            if ((snapshot.retryCounts?.[pending.scope] ?? 0) >= pending.epoch) {
                if (!state.retried.includes(pending.key))
                    state.retried.push(pending.key);
                delete state.pendingRetry;
                await services.save();
            }
        }
        try {
            ensureCheckBudget();
            if (state.pendingRetry) {
                const pending = state.pendingRetry;
                await services.repair(pending.scope);
                if (!state.retried.includes(pending.key))
                    state.retried.push(pending.key);
                delete state.pendingRetry;
                await services.save();
            }
            else
                await services.resume();
        }
        catch (error) {
            state.problem = (error as Error).message;
            if (error instanceof CheckRequestInterrupted && transientCheckFailure(error)) {
                const current = await services.snapshot(), key = current.key + ':' + (current.stage ?? '') + ':' + error.kind;
                if (!(state.interruptions ?? []).includes(key)) {
                    try {
                        ensureCheckBudget();
                    }
                    catch (budget) {
                        if (budget instanceof CheckBudgetExceeded) {
                            await services.save();
                            services.write(budget.message);
                            return 'paused';
                        }
                        throw budget;
                    }
                    (state.interruptions ??= []).push(key);
                    await services.save();
                    services.write('A transient provider interruption occurred. Retrying this saved stage once within the same allowance.');
                    await (services.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(2000);
                    continue;
                }
            }
            if (error instanceof CheckBudgetExceeded || error instanceof CheckRequestInterrupted) {
                await services.save();
                services.write(error.message);
                if (error instanceof CheckRequestInterrupted)
                    services.write(error.remedy ?? '');
                return 'paused';
            }
            if (error instanceof ScopeRepairBlocked) {
                const current = await services.snapshot(), key = current.key + ':' + error.scope;
                if (state.pendingRetry) {
                    if (!state.retried.includes(state.pendingRetry.key))
                        state.retried.push(state.pendingRetry.key);
                    delete state.pendingRetry;
                }
                if (!state.retried.includes(key)) {
                    try {
                        ensureCheckBudget();
                    }
                    catch (budget) {
                        if (budget instanceof CheckBudgetExceeded) {
                            await services.save();
                            services.write(budget.message);
                            return 'paused';
                        }
                        throw budget;
                    }
                    state.pendingRetry = { key, scope: error.scope, epoch: (current.retryCounts?.[error.scope] ?? 0) + 1 };
                    await services.save();
                    services.write(`Retrying blocked check once: ${error.scope}. Completed reviews are retained.`);
                    continue;
                }
            }
            await services.save();
            services.write(state.problem);
            if (error instanceof OperatorError && error.remedy)
                services.write(error.remedy);
            return 'blocked';
        }
    }
    state.problem = 'Preparation made too many transitions without becoming ready.';
    await services.save();
    return 'blocked';
}
const directory = (project: string) => project + '-harness/acceptance';
export async function readPreparationWorkflow(project: string): Promise<WorkflowState> {
    return await readControllerState(project, 'preparation', parseWorkflowState) ?? {version:1, retried:[], runs:[]};
}
export function parseWorkflowState(raw:unknown):WorkflowState {
    const s = raw as WorkflowState;
    if (!s || s.version !== 1 || !Array.isArray(s.retried) || s.retried.some(v => typeof v !== 'string') || !Array.isArray(s.runs))
        throw new OperatorError('Invalid saved preparation workflow.');
    validateStateRevision(s);
    if (s.interruptions !== undefined && (!Array.isArray(s.interruptions) || s.interruptions.length > 1000 || s.interruptions.some(k => typeof k !== 'string')))
        throw new OperatorError('Invalid interruption history.');
    for (const r of s.runs) {
        if (!r || typeof r.started !== 'string' || !['running', 'ready', 'paused', 'blocked'].includes(r.status) || !r.limits || !r.spend || !Number.isSafeInteger(r.spend.requests) || r.spend.requests < 0)
            throw new OperatorError('Invalid saved preparation allowance.');
        validateCheckLimits(r.limits);
        for (const value of [r.spend.reportedTokens, r.spend.reportedCostUsd, r.spend.unreported, r.spend.recorded])
            if (value !== undefined && (!Number.isFinite(value) || value < 0))
                throw new OperatorError('Invalid saved preparation usage.');
    }
    if (!Number.isSafeInteger(s.runs.reduce((n,r)=>n+r.spend.requests,0)))
        throw new OperatorError('Invalid saved request accounting total.');
    if (s.pendingRetry && (typeof s.pendingRetry.key !== 'string' || typeof s.pendingRetry.scope !== 'string' || !Number.isInteger(s.pendingRetry.epoch) || s.pendingRetry.epoch < 1))
        throw new OperatorError('Invalid saved preparation retry.');
    return s;
}
export async function prepareChecks(project: string, io: Dialogue, limits: CheckLimits = defaultCheckLimits, taskId?: string): Promise<WorkflowOutcome> {
    validateCheckLimits(limits);
    project = await canonicalProject(project);
    return withWriter(project, 'checks prepare', async () => {
        const state = await readPreparationWorkflow(project), run: WorkflowRun = { started: new Date().toISOString(), limits, spend: { requests: 0 }, status: 'running' };
        state.runs.push(run);
        const save = async () => {
            await saveControllerState(project, 'preparation', state, parseWorkflowState, run.status === 'ready' ? 'approval' : run.status === 'blocked' ? 'attention' : run.status === 'paused' ? 'paused' : 'checkpoint');
        };
        io.write(`Preparation allowance: ${limits.maxRequests} model requests, ${limits.maxSeconds}s total, ${limits.requestSeconds}s per request. Completed reviews are reused; approval remains separate.`);
        await save();
        await describeCheckProgress(project, io.write);
        const snapshot = async () => {
            const progress = await preparationProgress(project);
            if (progress.nextAction)
                state.nextAction = progress.nextAction;
            else
                delete state.nextAction;
            return { ...progress, ready: (!taskId || progress.nextAction?.taskId === taskId) && await readyCheckDraft(project) };
        };
        try {
            run.status = await withCheckBudget(limits, run.spend, save, io.write, () => driveCheckWorkflow(state, { snapshot, save, write: io.write, repair: scope => withOperationPhase(project, 'repairing', scope, () => repairSavedCheck(project, io, scope)), resume: () => withOperationPhase(project, 'preparing', state.nextAction?.taskId ?? taskId ?? 'selected-task', async () => {
                    if (taskId) {
                        const features = await readFeatures(project), selected = features?.ok ? features.features.find(t => t.id === taskId) : undefined;
                        if (!selected)
                            throw new OperatorError('The selected task is no longer available.');
                        for (const name of ['simplification.json', 'recipe-change.json']) {
                            const pending = await readArtifact(directory(project), name, 8 * 1024 * 1024);
                            if (pending && JSON.parse(pending).taskId !== taskId)
                                throw new OperatorError('Another task has unfinished check preparation. Resolve it before switching tasks.');
                        }
                        await guidedSetup(project, selected, io, undefined, undefined, undefined, true, true);
                        return;
                    }
                    if (await resumePreparation(project, io, true))
                        return;
                    const features = await readFeatures(project);
                    if (!features?.ok || !features.features.length)
                        throw new OperatorError('Accept work items before preparing checks.', 'Use harness guide to plan and accept items first.');
                    const index = await choose(io, 'Prepare checks for which task?', features.features.map(t => `${t.title} (${t.id})`));
                    if (index < 0)
                        throw new OperatorError('Preparation cancelled.');
                    await guidedSetup(project, features.features[index]!, io, undefined, undefined, undefined, false, true);
                }) }));
        }
        catch (error) {
            run.status = 'blocked';
            state.problem = (error as Error).message;
            throw error;
        }
        finally {
            await save();
        }
        io.write(run.status === 'ready' ? 'Checks are ready for your approval. Next: harness checks review.' : run.status === 'paused' ? 'Resume with harness checks prepare; completed work is retained.' : 'Preparation needs attention. Details are saved; no automatic retry loop will run.');
        return run.status;
    });
}
/** The same phase owner supplies CLI status and durable retry reconciliation. */
export async function preparationProgress(project: string) {
    const active = await readActivePreparation(directory(project));
    if (!active)
        return { key: 'new', stage: 'outline', retryCounts: {} as Record<string, number> };
    const record = JSON.parse(active.raw), state = active.name === 'preparation.json' ? record.state : undefined;
    const ledger = state?.reviewLedger ?? record.ledger, operation = record.operation?.id ?? 'legacy';
    const cases = state?.blueprint?.cases ?? record.proposal?.manifest?.cases ?? [];
    const failed = ledger?.entries?.find((e: any) => e.scope !== '$contract' && (e.pendingRepair || e.review?.verdict === 'repair'))?.scope;
    const check = failed ?? state?.pendingCase?.id ?? cases.find((c: any) => state ? !state.cases?.some((g: any) => g.id === c.id) : !ledger?.entries?.some((e: any) => e.scope === c.id && e.review?.verdict === 'pass'))?.id;
    const phase: PreparationNextAction['phase'] = !cases.length ? 'outline' : active.name === 'review-progress.json' || (check && state?.cases?.some((c: any) => c.id === check)) ? 'review' : 'generation';
    const nextAction: PreparationNextAction = { taskId: record.taskId, operation, phase, source: active.name, ...(check ? { check } : {}), command: 'harness checks prepare' };
    return { key: `${record.taskId}:${record.taskDigest}:${record.sourceDigest}:${operation}`, legacyKey: `${record.taskDigest}:${record.sourceDigest}`, stage: check ?? phase, retryCounts: Object.fromEntries((ledger?.entries ?? []).map((e: {
            scope: string;
            retryCount?: number;
        }) => [e.scope, e.retryCount ?? 0])), nextAction };
}
async function describeCheckProgress(project: string, write: (s: string) => void): Promise<void> {
    const planningRaw = await readArtifact(directory(project), 'outline-planning.json', 8 * 1024 * 1024);
    if (planningRaw) {
        const p = JSON.parse(planningRaw);
        write(`Initial planning checkpoints: interface ${p.interface ? 'saved' : 'pending'}; ${p.criteria?.length ?? 0} criterion outline(s) saved${p.pending ? '; active ' + p.pending.stage : ''}. These are unapproved designs, not application evidence.`);
    }
    const raw = (await readActivePreparation(directory(project)))?.raw;
    if (!raw)
        return;
    const progress = await preparationProgress(project);
    if (progress.nextAction) {
        const n = progress.nextAction;
        write(`Active preparation: ${n.taskId}; ${n.phase}${n.check ? ' ' + n.check : ''}; source ${n.source}; operation ${n.operation}.`);
    }
    const record = JSON.parse(raw), features = await readFeatures(project), task = features?.ok ? features.features.find(t => t.id === record.taskId) : undefined;
    if (record.state?.blueprint) {
        const b = routeBlueprint(record.state.blueprint), counts = { command: 0, browser: 0, manual: 0 };
        for (const c of b.cases)
            counts[caseKind(c)]++;
        write(`Evidence routing: ${counts.command} command, ${counts.browser} browser, ${counts.manual} manual behaviours. Browser journeys use Chromium; manual requirements remain unresolved.`);
    }
    if (!task)
        return;
    const ledger = record.state?.reviewLedger ?? record.ledger;
    let p = record.proposal ? parseProposal(record.proposal, task) : record.state?.blueprint ? blueprintProposal(task, parseBlueprint(record.state.blueprint, task)) : undefined;
    if (!p || !ledger)
        return;
    if (record.state)
        p.manifest.cases = p.manifest.cases.map(c => record.state.cases.find((g: {
            id: string;
        }) => g.id === c.id) ?? c);
    const scopes = ['$contract', ...p.manifest.cases.map(c => c.id)];
    let reviewed = 0, stale = 0;
    for (const scope of scopes) {
        const entry = ledger.entries?.find((e: {
            scope: string;
            digest: string;
        }) => e.scope === scope && e.digest === scopeDigest(task, p, scope));
        const check = p.manifest.cases.find(c => c.id === scope);
        let current = true;
        if (check)
            try {
                assertServerRuntimes({ version: 1, cases: [check] });
                for (const step of check.steps)
                    assertRecipeStep(step);
            }
            catch {
                current = false;
                stale++;
            }
        if (current && entry?.review?.verdict === 'pass')
            reviewed++;
    }
    write(`Saved check reviews for ${task.title}: ${reviewed}/${scopes.length} sections; ${stale} helper refreshes needed. Source and task freshness are verified before resuming.`);
}
export async function checkWorkflowStatus(project: string, write: (s: string) => void): Promise<void> {
    project = await canonicalProject(project);
    await describeOperation(project, write);
    await describeCheckProgress(project, write);
    const state = await readPreparationWorkflow(project), last = state.runs.at(-1);
    const pendingRaw = await readArtifact(directory(project), 'simplification.json', 8 * 1024 * 1024);
    if (pendingRaw) {
        const pending = JSON.parse(pendingRaw), saved = pending.state;
        const features = await readFeatures(project), task = features?.ok ? features.features.find(t => t.id === pending.taskId) : undefined;
        const reviewed = saved.proposal && task ? (saved.cases ?? []).filter((c: {
            id: string;
        }) => saved.ledger?.entries?.some((e: {
            scope: string;
            digest: string;
            review?: {
                verdict: string;
            };
        }) => e.scope === c.id && e.digest === scopeDigest(task, saved.proposal, c.id) && e.review?.verdict === 'pass')).length : 0;
        write(`Simplification: ${pending.scope}; ${saved.cases?.length ?? 0} generated checks saved; ${reviewed} independently reviewed; ${saved.generationResponses?.length ?? 0} generated replies retained.`);
        if (saved.interruptions?.length)
            write(`Provider/allowance interruptions: ${saved.interruptions.length}; request spend remains recorded separately from check-defect attempts.`);
        if (saved.pendingRefinement)
            write(`Subdividing: ${saved.pendingRefinement.scope}. Completed stages are reused.`);
        const generated = new Set((saved.cases ?? []).map((c: {
            id: string;
        }) => c.id));
        const active = new Set((saved.outline?.manifest?.cases ?? []).filter((c: {
            id: string;
        }) => !generated.has(c.id)).map((c: {
            id: string;
        }) => c.id));
        for (const [id, error] of Object.entries(saved.generationErrors ?? {}))
            if (active.has(id))
                write(`${id}: ${String(error)}`);
        const runs = path.join(directory(project), 'simplification-runs');
        const files = await readdir(runs).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT')
            return []; throw error; });
        const name = files.filter(f => f.endsWith('.json')).sort().at(-1), raw = name ? await readArtifact(runs, name, 65536) : undefined;
        const recent = raw ? JSON.parse(raw) as WorkflowRun : undefined;
        const latest = recent && (!last || recent.started > last.started) ? recent : last;
        if (latest) {
            write(`Last allowance: ${latest.status}; ${latest.spend.requests}/${latest.limits.maxRequests} requests.`);
            write(describeCheckSpend(latest.spend));
        }
        write(`Continue: harness checks simplify ${pending.scope}. Existing approvals are unchanged.`);
        return;
    }
    if (!last) {
        write('No bounded preparation run is recorded. Start or resume with harness checks prepare.');
        return;
    }
    write(`Last recorded preparation: ${last.status}; ${last.spend.requests}/${last.limits.maxRequests} requests.`);
    write(describeCheckSpend(last.spend));
    if (state.runs.length > 1) {
        const total: CheckSpend = { requests: 0, recorded: 0 };
        for (const { spend } of state.runs) {
            total.requests += spend.requests;
            total.recorded = (total.recorded ?? 0) + (spend.recorded ?? 0);
            total.unreported = (total.unreported ?? 0) + (spend.unreported ?? 0);
            if (spend.reportedTokens !== undefined)
                total.reportedTokens = (total.reportedTokens ?? 0) + spend.reportedTokens;
            if (spend.reportedCostUsd !== undefined)
                total.reportedCostUsd = (total.reportedCostUsd ?? 0) + spend.reportedCostUsd;
        }
        write(`All ${state.runs.length} bounded preparation runs: ${total.requests} requests. ${describeCheckSpend(total)}`);
    }
    if (state.problem)
        write(state.problem);
    write('Continue: harness checks prepare. Final approval: harness checks review.');
}
