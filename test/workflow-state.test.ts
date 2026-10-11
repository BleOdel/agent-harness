import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { saveContinuation, readContinuation } from '../src/workflow/store.ts';
import { driveContinuation, type ContinueState } from '../src/workflow/controller.ts';
const state = (): ContinueState => ({ version: 1, task: 'author', status: 'paused', message: 'Retained', updated: new Date().toISOString(), attempts: 1, maxBuilds: 2, recoveries: 1, events: [], checkDeadline: 1, checkRequestBase: 3 });
async function fixture(t: import('node:test').TestContext) { const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-state-')); t.after(() => rm(root, { recursive: true, force: true })); const project = root + '/app'; await mkdir(project); return project; }
test('stale continuation writers cannot replace newer progress or restore spent attempts', async (t) => {
    const project = await fixture(t);
    await saveContinuation(project, state());
    const older = (await readContinuation(project))!, newer = (await readContinuation(project))!;
    newer.attempts = 2;
    newer.message = 'Latest';
    await saveContinuation(project, newer);
    const bytes = await readFile(project + '-harness/continuation.json', 'utf8');
    older.message = 'Obsolete';
    await assert.rejects(saveContinuation(project, older), /Stale/);
    assert.equal(await readFile(project + '-harness/continuation.json', 'utf8'), bytes);
    await assert.rejects(saveContinuation(project, state()), /Stale/);
});
test('read-only legacy status keeps exact bytes; first guarded write archives legacy and increments revision', async (t) => {
    const project = await fixture(t), file = project + '-harness/continuation.json';
    await mkdir(path.dirname(file));
    const original = JSON.stringify(state());
    await writeFile(file, original);
    const saved = (await readContinuation(project))!;
    assert.equal(await readFile(file, 'utf8'), original);
    saved.message = 'Resumed';
    await saveContinuation(project, saved);
    const after = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(after.revision, 1);
    assert.equal(after.attempts, 1);
    assert.equal(after.checkDeadline, 1);
    const archive = project + '-harness/operations/legacy', names = await readdir(archive);
    assert.equal(names.length, 1);
    assert.equal(await readFile(path.join(archive, names[0]!), 'utf8'), original);
    await saveContinuation(project, saved);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).revision, 2);
    assert.equal((await readdir(archive)).length, 1);
});
test('a ready draft resumes directly at approval even with an expired preparation allowance', async () => {
    const saved = state();
    const calls: string[] = [];
    await driveContinuation(saved, { snapshot: async () => ({ done: false, checks: 'ready' }), prepare: async () => { assert.fail('must reuse ready draft'); }, review: async () => { calls.push('review'); }, build: async () => assert.fail('approval remains required'), save: async () => { }, write: () => { } });
    assert.deepEqual(calls, ['review']);
    assert.equal(saved.status, 'approval');
    assert.equal(saved.attempts, 1);
    assert.equal(saved.checkDeadline, 1);
});
import { readControllerState, saveControllerState, inheritControllerState } from '../src/workflow/state.ts';
import { parseWorkflowState, type WorkflowState } from '../src/acceptance/workflow.ts';
import { withWriter, writerPath, recoverWriter } from '../src/workspace/writer-lock.ts';
import { readOperation } from '../src/workflow/operations.ts';
import { selectContinuationPhase } from '../src/workflow/controller.ts';
import { continueCommand } from '../src/verbs/continue.ts';
import { readWorkspace } from '../src/view/workspace.ts';
import { symlink, link } from 'node:fs/promises';
test('preparation uses the same guarded authority and preserves request spend and retry reservations', async (t) => {
    const project = await fixture(t), file = project + '-harness/acceptance/workflow.json';
    await mkdir(path.dirname(file), { recursive: true });
    const legacy: WorkflowState = { version: 1, retried: ['kept'], pendingRetry: { key: 'key', scope: 'scope', epoch: 1 }, runs: [{ started: new Date().toISOString(), limits: { maxRequests: 3, maxSeconds: 600, requestSeconds: 180 }, spend: { requests: 2 }, status: 'paused' }] };
    await writeFile(file, JSON.stringify(legacy));
    const a = (await readControllerState(project, 'preparation', parseWorkflowState))!, b = (await readControllerState(project, 'preparation', parseWorkflowState))!;
    a.runs[0]!.spend.requests = 3;
    await saveControllerState(project, 'preparation', a, parseWorkflowState, 'paused');
    await assert.rejects(saveControllerState(project, 'preparation', b, parseWorkflowState, 'paused'), /Stale/);
    const retained = (await readControllerState(project, 'preparation', parseWorkflowState))!;
    assert.equal(retained.runs[0]!.spend.requests, 3);
    assert.deepEqual(retained.pendingRetry, legacy.pendingRetry);
    assert.deepEqual(retained.retried, ['kept']);
    await saveContinuation(project, state());
    assert.equal((await readContinuation(project))!.revision, 1);
});
test('explicit renewal carries the read expectation; implicit replacement and foreign project writes are refused', async (t) => {
    const project = await fixture(t), other = await fixture(t);
    await saveContinuation(project, state());
    const saved = (await readContinuation(project))!, replacement = { ...saved, attempts: 0, checkDeadline: 2000 };
    await assert.rejects(saveContinuation(project, replacement), /Stale/);
    await assert.rejects(saveContinuation(other, saved), /another project/);
    inheritControllerState(saved, replacement);
    await saveContinuation(project, replacement);
    assert.equal(replacement.revision, 2);
    assert.equal((await readContinuation(project))!.attempts, 0);
    await assert.rejects(saveContinuation(project, saved), /Stale/);
});
test('the real renewal command retains recovery history and archives the previous allowance', async (t) => {
    const project = await fixture(t);
    await writeFile(project + '/features.json', JSON.stringify([{ id: 'author', title: 'Author', priority: 'must', status: 'done', dependsOn: [], criteria: ['one'] }]));
    await saveContinuation(project, state());
    await continueCommand(project, ['author', '--renew', '--max-builds', '3'], { write: () => { }, ask: async () => assert.fail() });
    const saved = (await readContinuation(project))!;
    assert.equal(saved.status, 'complete');
    assert.equal(saved.maxBuilds, 3);
    assert.equal(saved.attempts, 0);
    assert.equal(saved.recoveries, 1);
    assert.equal(saved.checkDeadline, undefined);
    assert.equal(saved.revision, 2);
    const archive = (await readdir(project + '-harness')).filter(n => /^continuation-.*\.json$/.test(n));
    assert.equal(archive.length, 1);
    assert.equal(JSON.parse(await readFile(project + '-harness/' + archive[0], 'utf8')).attempts, 1);
});
test('CLI and dashboard parse the same revisioned status without migrating legacy state', async (t) => {
    const project = await fixture(t), file = project + '-harness/continuation.json';
    await mkdir(path.dirname(file));
    const original = JSON.stringify(state());
    await writeFile(file, original);
    assert.deepEqual((await readWorkspace(project)).continuation, await readContinuation(project));
    assert.equal(await readFile(file, 'utf8'), original);
    await writeFile(file, JSON.stringify({ ...state(), revision: 0 }));
    await assert.rejects(readContinuation(project), /revision/);
    const view = await readWorkspace(project);
    assert.equal(view.continuation, undefined);
    assert.ok(view.warnings.some(w => w.includes('revision')));
});
test('status writes refuse replaced owners, aliased state files, and unsafe revision values', async (t) => {
    const project = await fixture(t);
    await saveContinuation(project, state());
    const file = project + '-harness/continuation.json', original = await readFile(file, 'utf8');
    await assert.rejects(withWriter(project, 'continue', async () => {
        const operation = (await readOperation(project))!;
        await writeFile(project + '-harness/operations/current.json', JSON.stringify({ ...operation, revision: operation.revision + 1 }));
        await saveContinuation(project, (await readContinuation(project))!);
    }), /Stale/);
    assert.equal(await readFile(file, 'utf8'), original);
    for (const alias of ['symbolic', 'hard'] as const) {
        const other = await fixture(t);
        await mkdir(other + '-harness');
        if (alias === 'symbolic')
            await symlink(file, other + '-harness/continuation.json');
        else
            await link(file, other + '-harness/continuation.json');
        await assert.rejects(readContinuation(other), /link/);
        await assert.rejects(saveContinuation(other, state()), /link/);
        await rm(other + '-harness/continuation.json');
    }
    await assert.rejects(saveContinuation(project, { ...state(), revision: Number.MAX_SAFE_INTEGER + 1 }), /revision/);
});
test('phase selection puts verified domain facts ahead of expired budgets and refreshes after approval', async () => {
    const s = state();
    s.attempts = s.maxBuilds;
    assert.equal(selectContinuationPhase(s, { done: false, checks: 'ready' }), 'review');
    assert.equal(selectContinuationPhase(s, { done: false, checks: 'approved' }), 'budget');
    assert.equal(selectContinuationPhase(s, { done: true, checks: 'blocked' }), 'complete');
    assert.equal(selectContinuationPhase(s, { done: false, checks: 'blocked', stage: 'r1' }), 'staged');
    let reviewed = false;
    await driveContinuation(s, { snapshot: async () => reviewed ? { done: false, checks: 'approved', stage: 'r1' } : { done: false, checks: 'ready' }, prepare: async () => assert.fail(), review: async () => { reviewed = true; }, build: async () => assert.fail(), save: async () => { }, write: () => { } });
    assert.equal(s.status, 'approval');
    assert.match(s.message, /r1/);
});
import { spawn } from 'node:child_process';
import { once } from 'node:events';
for (const boundary of ['before', 'after'] as const)
    test(`process death ${boundary} status publication preserves a resumable single authority`, { timeout: 15000 }, async (t) => {
        const project = await fixture(t);
        await saveContinuation(project, state());
        const script = `import {withWriter} from ${JSON.stringify(new URL('../src/workspace/writer-lock.ts', import.meta.url).href)};
 import {readContinuation,saveContinuation} from ${JSON.stringify(new URL('../src/workflow/store.ts', import.meta.url).href)};
 await withWriter(process.argv[1],'continue',async()=>{const s=await readContinuation(process.argv[1]);s.attempts=2;
 if(process.argv[2]==='after')await saveContinuation(process.argv[1],s);process.send('ready');await new Promise(()=>setInterval(()=>{},1000));});`;
        const child = spawn(process.execPath, ['--input-type=module', '-e', script, project, boundary], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        t.after(() => { if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGKILL'); });
        let errors = '';
        child.stderr!.on('data', c => { errors += c; });
        await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw Error(errors || 'exited'); })]);
        const exit = once(child, 'exit');
        child.kill('SIGKILL');
        await exit;
        const saved = (await readContinuation(project))!;
        assert.equal(saved.attempts, boundary === 'after' ? 2 : 1);
        assert.equal(saved.revision, boundary === 'after' ? 2 : 1);
        const lock = JSON.parse(await readFile(await writerPath(project), 'utf8'));
        await recoverWriter(project, lock.token);
        saved.message = 'Recovered';
        await saveContinuation(project, saved);
        const resumed = (await readContinuation(project))!;
        assert.equal(resumed.attempts, boundary === 'after' ? 2 : 1);
        assert.equal(resumed.revision, boundary === 'after' ? 3 : 2);
        assert.equal(resumed.checkDeadline, 1);
        assert.equal(resumed.recoveries, 1);
    });

test('the shared preparation reader rejects unsafe request accounting before reuse',async t=>{
 const project=await fixture(t),file=project+'-harness/acceptance/workflow.json';await mkdir(path.dirname(file),{recursive:true});
 const run={started:new Date().toISOString(),limits:{maxRequests:3,maxSeconds:600,requestSeconds:180},spend:{requests:Number.MAX_SAFE_INTEGER+1},status:'paused'};
 await writeFile(file,JSON.stringify({version:1,retried:[],runs:[run]}));await assert.rejects(readControllerState(project,'preparation',parseWorkflowState),/allowance/);
 run.spend.requests=Number.MAX_SAFE_INTEGER;await writeFile(file,JSON.stringify({version:1,retried:[],runs:[run,run]}));await assert.rejects(readControllerState(project,'preparation',parseWorkflowState),/accounting/);
});
