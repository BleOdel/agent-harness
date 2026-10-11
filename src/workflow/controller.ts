import type { OperationPhase } from './operations.ts';
import type { CheckLimits } from '../acceptance/budget.ts';
import { OperatorError } from '../verbs/io.ts';
/** Emitted only after work durably retained a timeout checkpoint. */
export class ImplementationInterrupted extends OperatorError {
    readonly checkpoint: string;
    constructor(error: OperatorError, checkpoint: string) { super(error.message, error.remedy); this.checkpoint = checkpoint; }
}
export type ContinueStatus = 'running' | 'paused' | 'attention' | 'approval' | 'complete';
export interface ContinueState {
    operationId?: string;
    revision?: number;
    version: 1;
    task: string;
    status: ContinueStatus;
    message: string;
    updated: string;
    checkLimits?: CheckLimits;
    checkRequestBase?: number;
    checkDeadline?: number;
    attempts: number;
    maxBuilds: number;
    recoveries: number;
    events: {
        at: string;
        stage: string;
        message: string;
    }[];
}
export interface ContinueSnapshot {
    stage?: string;
    done: boolean;
    checks: 'missing' | 'ready' | 'approved' | 'blocked';
    reason?: string;
}
/** Domain facts take priority over allowance exhaustion; ready approval never needs a model turn. */
export function selectContinuationPhase(state:ContinueState,snapshot:ContinueSnapshot):'staged'|'complete'|'blocked'|'prepare'|'review'|'budget'|'build' {
    if(snapshot.stage)return 'staged';
    if(snapshot.done)return 'complete';
    if(snapshot.checks==='blocked')return 'blocked';
    if(snapshot.checks==='missing')return 'prepare';
    if(snapshot.checks==='ready')return 'review';
    return state.attempts>=state.maxBuilds?'budget':'build';
}
export interface ContinueServices {
    dispatch?: <T>(phase: OperationPhase, action: () => Promise<T>) => Promise<T>;
    snapshot: () => Promise<ContinueSnapshot>;
    prepare: () => Promise<'ready' | 'paused' | 'blocked'>;
    review: () => Promise<void>;
    build: () => Promise<void>;
    save: (state: ContinueState) => Promise<void>;
    write: (message: string) => void;
}
export async function driveContinuation(state: ContinueState, s: ContinueServices): Promise<ContinueState> {
    const dispatch = s.dispatch ?? (<T>(_phase: OperationPhase, action: () => Promise<T>) => action());
    const set = async (status: ContinueStatus, stage: string, message: string) => {
        state.status = status;
        state.message = message.slice(0, 10000);
        state.updated = new Date().toISOString();
        state.events.push({ at: state.updated, stage, message: message.slice(0, 4000) });
        state.events = state.events.slice(-30);
        await s.save(state);
        s.write(message);
    };
    try {
        for (;;) {
            const snap = await s.snapshot();
            const phase = selectContinuationPhase(state,snap);
            if (phase === 'staged') {
                await set('approval', 'staged', `Candidate ${snap.stage} passed automated checks and awaits final review. Preview: harness stage preview ${snap.stage}. Record observations and apply: harness stage review ${snap.stage}. No rebuild or model request is needed.`);
                return state;
            }
            if (phase === 'complete') {
                await set('complete', 'review', 'Task is complete. Review the applied result and retained evidence. Nothing was published.');
                return state;
            }
            if (phase === 'blocked') {
                await set('attention', 'decision', snap.reason ?? 'The approved verification requirements need a decision.');
                return state;
            }
            if (phase === 'prepare') {
                await set('running', 'prepare', 'Preparing the saved requirements; recoverable failures stay inside the allowance.');
                const outcome = await dispatch('preparing', s.prepare);
                if (outcome !== 'ready') {
                    await set(outcome === 'paused' ? 'paused' : 'attention', 'prepare', outcome === 'paused' ? 'Preparation stopped at its allowance or provider limit. All checkpoints are retained.' : 'Preparation needs a decision or a harness capability fix. The saved diagnosis is attached in acceptance/workflow.json.');
                    return state;
                }
            }
            if (phase === 'prepare' || phase === 'review') {
                await set('approval', 'review', 'The proposed checks and interface choices are ready for your approval.');
                await dispatch('reviewing', s.review);
                const approved = await s.snapshot();
                const next = selectContinuationPhase(state,approved);
                if (next === 'staged' || next === 'complete') continue;
                if (approved.checks !== 'approved') {
                    await set(approved.checks === 'blocked' ? 'attention' : 'approval', 'review', approved.reason ?? 'Approval is still needed. No implementation started.');
                    return state;
                }
            }
            if (state.attempts >= state.maxBuilds) {
                await set('paused', 'budget', 'Build allowance reached. The latest checkpoint is retained.');
                return state;
            }
            // Reserve before dispatch: a killed controller cannot silently reuse an attempt.
            state.attempts++;
            await set('running', 'build', `Building and verifying ${state.task}; dispatch ${state.attempts}/${state.maxBuilds}.`);
            try {
                await dispatch('building', s.build);
            }
            catch (error) {
                if (error instanceof ImplementationInterrupted && state.recoveries < 1 && state.attempts < state.maxBuilds) {
                    state.recoveries++;
                    await set('running', 'recover', `Implementation timed out. Resuming retained checkpoint ${error.checkpoint} once; every verification gate will run again.`);
                    continue;
                }
                throw error;
            }
            const after = await s.snapshot();
            if (after.stage)
                continue;
            if (!after.done) {
                await set('attention', 'build', 'The build returned without completing the task. Inspect its retained result before continuing.');
                return state;
            }
        }
    }
    catch (error) {
        await set(error instanceof ImplementationInterrupted ? 'paused' : 'attention', 'diagnosis', `${(error as Error).message}${error instanceof OperatorError && error.remedy ? '\n' + error.remedy : ''}`);
        return state;
    }
}
