/** Invocation events describe execution; they are never approvals or application evidence. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
export type CommandOutcome = 'success' | 'paused_allowance' | 'decision_required' | 'capability_failure' | 'provider_failure' | 'failed';
export const outcomeExitCode: Record<CommandOutcome, number> = { success: 0, paused_allowance: 2, decision_required: 3, capability_failure: 4, provider_failure: 5, failed: 1 };
export interface PendingChoice {
    id: string;
    label: string;
    command?: string;
}
export interface Decision {
    question: string;
    choices: PendingChoice[];
}
export class PendingDecision extends Error {
    readonly decision: Decision;
    constructor(question: string, choices: PendingChoice[]) { super(question); this.name = 'PendingDecision'; this.decision = { question, choices }; }
}
export interface CommandResult {
    outcome: CommandOutcome;
    exitCode: number;
    message: string;
    decision?: Decision;
}
export interface WorkflowEvent {
    version: 1;
    invocationId: string;
    sequence: number;
    command: string;
    project: string;
    type: 'started' | 'progress' | 'dispatch' | 'checkpoint' | 'status' | 'allowance' | 'usage' | 'decision' | 'terminal';
    operationId?: string;
    data: Record<string, unknown>;
}
interface Session {
    id: string;
    sequence: number;
    command: string;
    project: string;
    json: boolean;
    closed: boolean;
    emit: (event: WorkflowEvent) => void;
    failure?: unknown;
}
const context = new AsyncLocalStorage<Session>();
export function workflowEvent(type: WorkflowEvent['type'], data: Record<string, unknown>, operationId?: string): void {
    const s = context.getStore();
    if (!s || s.closed)
        return;
    s.emit({ version: 1, invocationId: s.id, sequence: ++s.sequence, command: s.command, project: s.project, type, ...(operationId ? { operationId } : {}), data });
}
export function commandProgress(text: string): boolean {
    const s = context.getStore();
    if (!s)
        return false;
    if (!s.closed)
        for (let offset = 0; offset < text.length || offset === 0; offset += 8000)
            workflowEvent('progress', { text: text.slice(offset, offset + 8000) });
    return s.json;
}
export function reportCommandFailure(error: unknown): void { const s = context.getStore(); if (s && !s.closed && s.failure === undefined)
    s.failure = error; }
export function commandFailure(): unknown { return context.getStore()?.failure; }
export async function commandSession(project: string, command: string, json: boolean, emit: (e: WorkflowEvent) => void, run: () => Promise<CommandResult>): Promise<CommandResult> {
    const s: Session = { id: randomUUID(), sequence: 0, command, project, json, closed: false, emit };
    return context.run(s, async () => {
        workflowEvent('started', { approvalImplied: false });
        try {
            const result = await run();
            if (result.decision)
                workflowEvent('decision', { ...result.decision });
            workflowEvent('terminal', { ...result });
            return result;
        }
        finally {
            s.closed = true;
        }
    });
}
