/** Shared command API for terminal clients and pipes. Domain controllers retain their gates. */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { commandSession, commandFailure, outcomeExitCode, PendingDecision, workflowEvent, type CommandOutcome, type CommandResult, type WorkflowEvent } from './protocol.ts';
import { noninteractiveDialogue, terminalDialogue, choose, type Dialogue } from '../guide/dialogue.ts';
import { prepareChecks, checkWorkflowStatus } from '../acceptance/workflow.ts';
import { repairSavedCheck } from '../acceptance/guided.ts';
import { parseCheckLimits, withCheckBudget, CheckBudgetExceeded, type CheckSpend } from '../acceptance/budget.ts';
import { CheckRequestInterrupted } from '../acceptance/request-failure.ts';
import { EvidenceCapabilityGap } from '../acceptance/browser-design.ts';
import { EvidenceFeasibilityGap } from '../acceptance/feasibility.ts';
import { AmendmentDecision } from '../acceptance/interface-amendments.ts';
import { EnvironmentBlocked } from '../workspace/dependencies.ts';
import { continueCommand } from '../verbs/continue.ts';
import { OperatorError, say } from '../verbs/io.ts';
import { readFeatures } from '../features.ts';
import { canonicalProject, withWriter } from '../workspace/writer-lock.ts';
import { readPreparationSelection } from './preparation-selection.ts';
import { readActivePreparation } from '../acceptance/active-preparation.ts';
import { readWorkflowStatus, describeWorkflowStatus } from './reconciliation.ts';
import { atomicWrite } from '../planning/store.ts';
import { checkpointSavedFile, withOperationPhase } from './operations.ts';
export interface WorkflowRequest {
    command: 'prepare' | 'repair' | 'continue' | 'status';
    args: readonly string[];
    invalid?: string;
}
export interface CommandServices {
    prepare: typeof prepareChecks;
    repair: typeof repairSavedCheck;
    continue: typeof continueCommand;
}
interface Options {
    interactive?: boolean;
    json?: boolean;
    dialogue?: Dialogue;
    emit?: (event: WorkflowEvent) => void;
    services?: Partial<CommandServices>;
}
const result = (outcome: CommandOutcome, message: string): CommandResult => ({ outcome, exitCode: outcomeExitCode[outcome], message });
function decision(question: string, command = 'harness guide'): CommandResult {
    return { ...result('decision_required', question), decision: { question, choices: [{ id: 'inspect', label: 'Review the saved requirements or diagnosis', command }, { id: 'save', label: 'Keep saved progress and stop' }] } };
}
export function commandError(error: unknown): CommandResult {
    if (error instanceof PendingDecision)
        return { ...result('decision_required', error.message), decision: error.decision };
    if (error instanceof CheckRequestInterrupted)
        return result('provider_failure', error.message);
    if (error instanceof CheckBudgetExceeded)
        return result('paused_allowance', error.message);
    if (error instanceof AmendmentDecision)
        return decision(error.message + '\n' + error.remedy, 'harness checks setup');
    if (error instanceof EvidenceCapabilityGap) {
        if (error.blocker?.kind === 'contract-choice' || error.blocker?.kind === 'requirement-conflict')
            return decision(error.message, 'harness checks setup');
        return result('capability_failure', error.message);
    }
    if (error instanceof EvidenceFeasibilityGap) {
        if (error.issues.every(i => ['missing-interface', 'human-observation'].includes(i.kind)))
            return decision(error.message + '\n' + error.remedy);
        return result('capability_failure', error.message + '\n' + error.remedy);
    }
    if (error instanceof EnvironmentBlocked)
        return result('capability_failure', error.message);
    if (error instanceof OperatorError)
        return decision(error.message + (error.remedy ? '\n' + error.remedy : ''));
    return result('failed', error instanceof Error ? error.message : String(error));
}
function inputs(args: readonly string[], command: string) {
    const flags = [...args];
    let task: string | undefined;
    const i = flags.indexOf('--task');
    if (i >= 0) {
        if (!flags[i + 1] || flags[i + 1]!.startsWith('--'))
            throw new Error('--task requires a task ID.');
        task = flags[i + 1]!;
        flags.splice(i, 2);
    }
    const positional = flags[0] && !flags[0].startsWith('--') ? flags.shift() : undefined;
    if (command === 'prepare' && task && positional)
        throw new Error('Supply a task once, as a positional ID or --task.');
    return { task: command === 'prepare' ? task ?? positional : task, scope: command === 'repair' ? positional : undefined, limits: parseCheckLimits(flags, command) };
}
async function selectTask(project: string, task: string | undefined, io: Dialogue): Promise<string> {
    const saved = await readPreparationSelection(project, task);
    task ??= saved.taskId;
    const features = await readFeatures(project);
    if (!features?.ok || !features.features.length)
        throw new PendingDecision('Accept planned work items before preparing checks.', [{ id: 'plan', label: 'Plan and accept tasks', command: 'harness guide' }, { id: 'save', label: 'Stop without changing requirements' }]);
    if (task) {
        if (!features.features.some(f => f.id === task))
            throw new Error('Unknown task: ' + task);
        return task;
    }
    const selected = await choose(io, 'Prepare checks for which task?', features.features.map(f => `${f.title} (${f.id})`));
    if (selected < 0)
        throw new PendingDecision('No task selected.', [{ id: 'select', label: 'Select a task', command: 'harness checks setup' }, { id: 'save', label: 'Stop' }]);
    return features.features[selected]!.id;
}
export async function executeWorkflowCommand(project: string, request: WorkflowRequest, options: Options = {}): Promise<CommandResult> {
    const json = options.json ?? false, emit = options.emit ?? (json ? (e => { process.stdout.write(JSON.stringify(e) + '\n'); }) : (() => { }));
    return commandSession(project, request.command, json, emit, async () => {
        let outcome: CommandResult;
        try {
            if (request.invalid)
                throw new Error(request.invalid);
            project = await canonicalProject(project);
            const interactive = options.interactive ?? (!json && !!process.stdin.isTTY && !!process.stdout.isTTY);
            const io = json ? noninteractiveDialogue() : options.dialogue ?? (interactive ? terminalDialogue() : noninteractiveDialogue());
            const services: CommandServices = { prepare: prepareChecks, repair: repairSavedCheck, continue: continueCommand, ...options.services };
            if (request.command === 'status') {
                if (request.args.some(a => !['checks', 'continue'].includes(a)) || request.args.length > 1)
                    throw new Error('Use harness status [--json].');
                const status = await readWorkflowStatus(project);
                workflowEvent('status', { fingerprint: status.fingerprint, ...(status.action ? { action: status.action } : {}), ...(status.operation ? { operation: { id: status.operation.id, revision: status.operation.revision, state: status.operation.state } } : {}) }, status.operation?.id);
                if (request.args[0] === 'continue')
                    await services.continue(project, ['status'], io);
                else if (request.args[0] === 'checks')
                    await checkWorkflowStatus(project, io.write);
                else
                    await describeWorkflowStatus(project, io.write);
                outcome = result('success', 'Status read; no work dispatched.');
            }
            else if (request.command === 'continue') {
                const state = await services.continue(project, request.args, io);
                outcome = commandFailure() ? commandError(commandFailure()) : !state || state.status === 'complete' ? result('success', 'Continuation finished; inspect retained task evidence.') : state.status === 'paused' ? result('paused_allowance', state.message) : decision(state.message, (await readWorkflowStatus(project)).action?.command ?? 'harness continue status');
            }
            else {
                const parsed = inputs(request.args, request.command);
                if (request.command === 'prepare') {
                    const task = await selectTask(project, parsed.task, io);
                    workflowEvent('progress', { task, allowance: parsed.limits });
                    const status = await services.prepare(project, io, parsed.limits, task);
                    outcome = commandFailure() ? commandError(commandFailure()) : status === 'paused' ? result('paused_allowance', 'Preparation paused at its allowance. Saved progress is retained.') : decision(status === 'ready' ? 'Checks are ready for explicit approval.' : 'Preparation needs a decision; inspect the retained diagnosis.', status === 'ready' ? 'harness checks review' : 'harness checks status');
                }
                else {
                    if (parsed.task) {
                        const active = await readActivePreparation(project + '-harness/acceptance');
                        if (!active || JSON.parse(active.raw).taskId !== parsed.task)
                            throw new Error('The selected task does not own the saved repair.');
                    }
                    await withWriter(project, 'checks repair', async () => {
                        const directory = project + '-harness/acceptance/repair-runs';
                        await mkdir(directory, { recursive: true, mode: 0o700 });
                        const file = path.join(directory, randomUUID() + '.json'), spend: CheckSpend = { requests: 0 };
                        const save = async () => { await atomicWrite(file, JSON.stringify({ version: 1, scope: parsed.scope ?? null, limits: parsed.limits, spend }) + '\n'); await checkpointSavedFile(file, 'preparation', 'checkpoint'); };
                        await save();
                        await withCheckBudget(parsed.limits, spend, save, io.write, () => withOperationPhase(project, 'repairing', parsed.scope ?? 'selected-check', () => services.repair(project, io, parsed.scope)));
                    });
                    outcome = commandFailure() ? commandError(commandFailure()) : result('success', 'Selected repair finished; check approval remains separate.');
                }
            }
        }
        catch (error) {
            outcome = commandError(error);
        }
        if (!json) {
            const write = options.dialogue?.write ?? say;
            write(outcome.message);
            for (const choice of outcome.decision?.choices ?? [])
                write(`  ${choice.id}. ${choice.label}${choice.command ? ' — ' + choice.command : ''}`);
        }
        return outcome;
    });
}
/** Recognize only the operation commands; unrelated commands keep their existing output contract. */
export function workflowInvocation(verb: string | undefined, args: readonly string[]): {
    request: WorkflowRequest;
    json: boolean;
    interactive?: false;
} | undefined {
    let command: WorkflowRequest['command'] | undefined, rest = [...args];
    if (verb === 'checks' && ['prepare', 'repair', 'status'].includes(rest[0] ?? '')) {
        command = rest.shift() as WorkflowRequest['command'];
        if (command === 'status')
            rest.unshift('checks');
    }
    else if (verb === 'continue') {
        command = rest[0] === 'status' ? 'status' : 'continue';
        if (command === 'status')
            rest = ['continue', ...rest.slice(1)];
    }
    else if (verb === 'status')
        command = 'status';
    if (!command)
        return;
    const json = rest.includes('--json'), noninteractive = rest.includes('--non-interactive');
    const invalid = rest.filter(x => x === '--json').length > 1 || rest.filter(x => x === '--non-interactive').length > 1 ? 'Output/input flags must appear only once.' : undefined;
    rest = rest.filter(x => x !== '--json' && x !== '--non-interactive');
    return { request: { command, args: rest, ...(invalid ? { invalid } : {}) }, json, ...(noninteractive ? { interactive: false as const } : {}) };
}
export async function workflowCommand(project: string, verb: string, args: readonly string[]): Promise<void> {
    const invocation = workflowInvocation(verb, args);
    if (!invocation)
        throw new OperatorError('Unsupported workflow command.');
    const outcome = await executeWorkflowCommand(project, invocation.request, invocation);
    process.exitCode = outcome.exitCode;
}
