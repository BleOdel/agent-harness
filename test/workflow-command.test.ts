import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeWorkflowCommand, type CommandServices } from '../src/workflow/commands.ts';
import type { WorkflowEvent } from '../src/workflow/protocol.ts';
import { withWriter } from '../src/workspace/writer-lock.ts';
import { withOperationPhase, checkpointOperation } from '../src/workflow/operations.ts';
import { CheckRequestInterrupted } from '../src/acceptance/request-failure.ts';
import { CheckBudgetExceeded } from '../src/acceptance/budget.ts';
import { EvidenceCapabilityGap } from '../src/acceptance/browser-design.ts';
import { choose, confirmed } from '../src/guide/dialogue.ts';
async function fixture(t: import('node:test').TestContext) { const root = await mkdtemp(path.join(tmpdir(), 'command-api-')); t.after(() => rm(root, { recursive: true, force: true })); const project = root + '/app'; await mkdir(project); await writeFile(project + '/features.json', JSON.stringify([{ id: 'one', title: 'One', status: 'todo', priority: 'must', criteria: ['Print Hello'], dependsOn: [] }])); return project; }
const request = { command: 'prepare' as const, args: ['one', '--max-requests', '1'] };
test('noninteractive API never asks stdin; decisions carry exact choices and no approval', async (t) => {
    const project = await fixture(t), events: WorkflowEvent[] = [];
    const services: Partial<CommandServices> = { prepare: async (_p, io) => { await choose(io, 'Review actions', ['Approve these behaviours', 'Save for later']); return 'ready'; } };
    const result = await executeWorkflowCommand(project, request, { interactive: false, json: true, emit: e => events.push(e), services });
    assert.equal(result.outcome, 'decision_required');
    assert.equal(result.exitCode, 3);
    assert.deepEqual(result.decision?.choices.map(c => c.label), ['Approve these behaviours', 'Save for later']);
    assert.equal(events[0]!.type, 'started');
    assert.equal(events.at(-1)!.type, 'terminal');
    assert.equal(events.filter(e => e.type === 'terminal').length, 1);
    assert.deepEqual(events.map(e => e.sequence), events.map((_, i) => i + 1));
    await assert.rejects(readFile(project + '-harness/acceptance/approved.json'), { code: 'ENOENT' });
});
for (const [failure, outcome, exitCode] of [[new CheckRequestInterrupted('provider', 'auth expired'), 'provider_failure', 5], [new CheckBudgetExceeded('requests'), 'paused_allowance', 2], [new EvidenceCapabilityGap('No keyboard driver'), 'capability_failure', 4]] as const) {
    test(`command terminal distinguishes ${outcome}`, async (t) => { const project = await fixture(t); const result = await executeWorkflowCommand(project, request, { interactive: false, services: { prepare: async () => { throw failure; } } }); assert.equal(result.outcome, outcome); assert.equal(result.exitCode, exitCode); });
}
test('events follow durable reservation/checkpoint ordering and include the owning operation', async (t) => {
    const project = await fixture(t), events: WorkflowEvent[] = [];
    const result = await executeWorkflowCommand(project, request, { interactive: false, emit: e => events.push(e), services: { prepare: async () => { await withWriter(project, 'checks prepare', () => withOperationPhase(project, 'preparing', 'one', async () => { await checkpointOperation(project, { kind: 'preparation', reference: 'fixture', digest: 'a'.repeat(64), status: 'paused' }); })); return 'paused'; } } });
    assert.equal(result.outcome, 'paused_allowance');
    const reserve = events.findIndex(e => e.type === 'dispatch');
    const checkpoint = events.findIndex(e => e.type === 'checkpoint');
    assert.ok(reserve > 0 && checkpoint > reserve);
    assert.ok(events[checkpoint]!.operationId);
    assert.equal(events[checkpoint]!.operationId, events[reserve]!.operationId);
});
test('interactive client uses the same command API and preserves explicit confirmation', async (t) => {
    const project = await fixture(t);
    let asked = 0;
    const result = await executeWorkflowCommand(project, request, { dialogue: { write: () => { }, ask: async () => { asked++; return 'n'; } }, services: { prepare: async (_p, io) => { assert.equal(await confirmed(io, 'Approve?'), false); return 'ready'; } } });
    assert.equal(asked, 1);
    assert.equal(result.outcome, 'decision_required');
});
import { driveCheckWorkflow } from '../src/workflow/preparation.ts';
import { commandProgress } from '../src/workflow/protocol.ts';
for (const failure of [new CheckRequestInterrupted('provider', 'fixture auth expired'), new EvidenceCapabilityGap('fixture missing browser driver')])
    test(`controller preserves ${failure.constructor.name} through its paused or blocked return`, async (t) => {
        const project = await fixture(t);
        const result = await executeWorkflowCommand(project, request, { interactive: false, services: { prepare: async () => driveCheckWorkflow({ version: 1, retried: [], runs: [] }, { snapshot: async () => ({ key: 'new', ready: false }), save: async () => { }, write: () => { }, repair: async () => { }, resume: async () => { throw failure; } }) } });
        assert.equal(result.outcome, failure instanceof CheckRequestInterrupted ? 'provider_failure' : 'capability_failure');
    });
test('late progress cannot appear after the terminal result', async (t) => {
    const project = await fixture(t), events: WorkflowEvent[] = [];
    let release!: () => void, late!: Promise<void>;
    const signal = new Promise<void>(r => release = r);
    await executeWorkflowCommand(project, request, { interactive: false, emit: e => events.push(e), services: { prepare: async () => { late = signal.then(() => { commandProgress('late provider callback'); }); return 'ready'; } } });
    const before = events.length;
    release();
    await late;
    assert.equal(events.length, before);
    assert.equal(events.at(-1)!.type, 'terminal');
});
test('noninteractive confirmation returns a decision and cannot approve', async (t) => {
    const project = await fixture(t);
    let approved = false;
    const result = await executeWorkflowCommand(project, request, { json: true, emit: () => { }, services: { prepare: async (_p, io) => { approved = await confirmed(io, 'Approve this exact draft?'); return 'ready'; } } });
    assert.equal(approved, false);
    assert.equal(result.outcome, 'decision_required');
    assert.match(result.decision!.question, /Approve this exact draft/);
});
import { readdir } from 'node:fs/promises';
import { checkRequestBudget } from '../src/acceptance/budget.ts';
test('explicit repair persists its request allowance before work and prevents an extra dispatch', async (t) => {
    const project = await fixture(t), events: WorkflowEvent[] = [];
    const result = await executeWorkflowCommand(project, { command: 'repair', args: ['one', '--max-requests', '1'] }, { json: true, emit: e => events.push(e), services: { repair: async (_p, io, scope) => {
                assert.equal(scope, 'one');
                const allowance = await checkRequestBudget(1000);
                const dir = project + '-harness/acceptance/repair-runs';
                const files = await readdir(dir);
                assert.equal(files.length, 1);
                assert.equal(JSON.parse(await readFile(dir + '/' + files[0], 'utf8')).spend.requests, 1);
                await allowance.record({ totalTokens: 7, costUsd: 0.01 } as import('../src/agent/events.ts').AgentUsage, true);
                await checkRequestBudget(1000);
                assert.fail('second request must not run');
            } } });
    assert.equal(result.outcome, 'paused_allowance');
    assert.equal(events.filter(e => e.type === 'allowance').length, 1);
    assert.ok(events.some(e => e.type === 'usage' && e.data.reportedTokens === 7));
    await assert.rejects(readFile(project + '-harness/acceptance/approved.json'), { code: 'ENOENT' });
});
import { executeGuideCommand } from '../src/verbs/guide.ts';
test('guide command adapter reads status through the shared API without a subprocess or stdin', async (t) => {
    const project = await fixture(t), output: string[] = [];
    assert.equal(await executeGuideCommand(project, ['status'], { write: s => output.push(s), ask: async () => assert.fail('status cannot prompt') }), 0);
    assert.ok(output.length > 0);
});
