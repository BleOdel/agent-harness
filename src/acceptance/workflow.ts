import {describeWorkflowStatus} from '../workflow/reconciliation.ts';
import { driveCheckWorkflow, type WorkflowState, type WorkflowRun, type WorkflowOutcome } from '../workflow/preparation.ts';
import { readPreparationSelection, assertPreparationSelection } from '../workflow/preparation-selection.ts';
import { readControllerState, saveControllerState, validateStateRevision } from '../workflow/state.ts';
import { withOperationPhase } from '../workflow/operations.ts';
import { caseKind, routeBlueprint } from './evidence-kind.ts';
/** One resumable controller; checkpoints and writer locks remain owned by existing check operations. */
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { withCheckBudget, defaultCheckLimits, validateCheckLimits, describeCheckSpend, type CheckLimits, type CheckSpend } from './budget.ts';
import { parseProposal } from './draft.ts';
import { blueprintProposal, parseBlueprint } from './preparation.ts';
import { assertServerRuntimes } from './server-runtime.ts';
import { assertRecipeStep } from './recipes/catalog.ts';
import { scopeDigest } from './scoped-review.ts';
import { readyCheckDraft, resumePreparation, repairSavedCheck, guidedSetup } from './guided.ts';
import { readArtifact } from '../planning/store.ts';
import { canonicalProject, withWriter } from '../workspace/writer-lock.ts';
import { choose, type Dialogue } from '../guide/dialogue.ts';
import { readFeatures } from '../features.ts';
import { OperatorError } from '../verbs/io.ts';
export { driveCheckWorkflow } from '../workflow/preparation.ts';
export type { WorkflowState, WorkflowOutcome } from '../workflow/preparation.ts';
export type { PreparationNextAction } from '../workflow/preparation-selection.ts';
const directory = (project: string) => project + '-harness/acceptance';
export async function readPreparationWorkflow(project: string): Promise<WorkflowState> {
    return await readControllerState(project, 'preparation', parseWorkflowState) ?? { version: 1, retried: [], runs: [] };
}
export function parseWorkflowState(raw: unknown): WorkflowState {
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
    if (!Number.isSafeInteger(s.runs.reduce((n, r) => n + r.spend.requests, 0)))
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
        const snapshot = async () => {
            const selection = await readPreparationSelection(project, taskId), progress = selection.progress;
            if (progress.nextAction)
                state.nextAction = progress.nextAction;
            else
                delete state.nextAction;
            return { ...progress, selection, ready: !selection.pending && await readyCheckDraft(project, taskId) };
        };
        try {
            await describeCheckProgress(project, io.write);
            run.status = await withCheckBudget(limits, run.spend, save, io.write, () => driveCheckWorkflow(state, { snapshot, save, write: io.write, repair: (scope, snapshot) => withOperationPhase(project, 'repairing', scope, async () => { await assertPreparationSelection(project, snapshot.selection!); await repairSavedCheck(project, io, scope); }), resume: snapshot => withOperationPhase(project, 'preparing', snapshot.selection?.taskId ?? taskId ?? 'selected-task', async () => {
                    await assertPreparationSelection(project, snapshot.selection!);
                    if (snapshot.selection!.pending) {
                        await resumePreparation(project, io, true, snapshot.selection);
                        return;
                    }
                    if (taskId) {
                        const features = await readFeatures(project), selected = features?.ok ? features.features.find(t => t.id === taskId) : undefined;
                        if (!selected)
                            throw new OperatorError('The selected task is no longer available.');
                        await guidedSetup(project, selected, io, undefined, undefined, undefined, true, true);
                        return;
                    }
                    if (await resumePreparation(project, io, true, snapshot.selection))
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
    return (await readPreparationSelection(project)).progress;
}
async function describeCheckProgress(project: string, write: (s: string) => void): Promise<void> {
    const planningRaw = await readArtifact(directory(project), 'outline-planning.json', 8 * 1024 * 1024);
    if (planningRaw) {
        const p = JSON.parse(planningRaw);
        write(`Initial planning checkpoints: interface ${p.interface ? 'saved' : 'pending'}; ${p.criteria?.length ?? 0} criterion outline(s) saved${p.pending ? '; active ' + p.pending.stage : ''}. These are unapproved designs, not application evidence.`);
    }
    const selection = await readPreparationSelection(project), raw = selection.primary?.raw, progress = selection.progress;
    if (progress.nextAction) {
        const n = progress.nextAction;
        write(`Active preparation: ${n.taskId}; ${n.phase}${n.check ? ' ' + n.check : ''}; source ${n.source}; operation ${n.operation}.`);
        if (selection.pending)
            write(`Continue: ${n.command}. Existing approvals are unchanged.`);
    }
    if (!raw)
        return;
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
    const workflow = await describeWorkflowStatus(project, write);
    if (workflow.action && workflow.action.kind !== 'preparation') {
        write('The workflow action above takes priority over saved preparation guidance.');
        return;
    }
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
        const files = await readdir(runs).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT')
                return [];
            throw error;
        });
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
