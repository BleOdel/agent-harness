import {reportCommandFailure} from './protocol.ts';
/** Shared preparation transitions; adapters provide evidence operations, not retry decisions. */
import type { PreparationNextAction, PreparationSelection } from './preparation-selection.ts';
import { CheckBudgetExceeded, ensureCheckBudget, type CheckLimits, type CheckSpend } from '../acceptance/budget.ts';
import { CheckRequestInterrupted, transientCheckFailure } from '../acceptance/request-failure.ts';
import { ScopeRepairBlocked } from '../acceptance/scoped-review.ts';
import { OperatorError } from '../verbs/io.ts';
export type WorkflowOutcome = 'ready' | 'paused' | 'blocked';
export interface WorkflowRun {
    started: string;
    limits: CheckLimits;
    spend: CheckSpend;
    status: 'running' | WorkflowOutcome;
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
export interface PreparationSnapshot {
    key: string;
    legacyKey?: string;
    stage?: string;
    ready: boolean;
    retryCounts?: Record<string, number>;
    selection?: PreparationSelection;
}
interface Services {
    wait?: (ms: number) => Promise<void>;
    snapshot: () => Promise<PreparationSnapshot>;
    resume: (snapshot: PreparationSnapshot) => Promise<void>;
    repair: (scope: string, snapshot: PreparationSnapshot) => Promise<void>;
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
            // Flush the adapter-selected phase before dispatch, including when no retry was needed.
            await services.save();
            if (state.pendingRetry) {
                const pending = state.pendingRetry;
                await services.repair(pending.scope, snapshot);
                if (!state.retried.includes(pending.key))
                    state.retried.push(pending.key);
                delete state.pendingRetry;
                await services.save();
            }
            else
                await services.resume(snapshot);
        }
        catch (error) {
            state.problem = (error as Error).message;
            if (error instanceof CheckRequestInterrupted && transientCheckFailure(error)) {
                const current = await services.snapshot();
                if (!snapshot.key.startsWith('new:') && snapshot.key !== 'new' && current.key !== snapshot.key) {
                    state.problem = 'Preparation inputs changed during the request. Inspect saved progress before retrying.';
                    await services.save();
                    services.write(state.problem);
                    return 'blocked';
                }
                const key = current.key + ':' + (current.stage ?? '') + ':' + error.kind;
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
                reportCommandFailure(error);
                await services.save();
                services.write(error.message);
                if (error instanceof CheckRequestInterrupted)
                    services.write(error.remedy ?? '');
                return 'paused';
            }
            if (error instanceof ScopeRepairBlocked) {
                const current = await services.snapshot();
                if (!snapshot.key.startsWith('new:') && snapshot.key !== 'new' && current.key !== snapshot.key) {
                    state.problem = 'Preparation inputs changed during the request. Inspect saved progress before retrying.';
                    await services.save();
                    services.write(state.problem);
                    return 'blocked';
                }
                const key = current.key + ':' + error.scope;
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
            reportCommandFailure(error);
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
