import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { preparationProgress, checkWorkflowStatus } from '../src/acceptance/workflow.ts';
import { resumePreparation } from '../src/acceptance/guided.ts';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function fixture(t: test.TestContext) {
    const root = await mkdtemp(path.join(tmpdir(), 'preparation-selection-')), project = root + '/app', dir = project + '-harness/acceptance';
    await mkdir(project);
    await mkdir(dir, { recursive: true });
    t.after(() => rm(root, { recursive: true, force: true }));
    const proposal = { version: 1, contract: 'Current contract', coverage: [{ criterion: 1, cases: ['privacy'] }], manifest: { version: 1, cases: [{ id: 'privacy', tasks: ['author'], description: 'Privacy', steps: [{ command: ['node', '-p', '1'], exitCode: 0, stdout: '1\n' }] }] } };
    const record = { version: 1, taskId: 'author', taskDigest: 'task-digest', sourceDigest: 'source-digest', operation: { id: 'author-operation', sequence: 2 }, proposal, ledger: { version: 1, entries: [] } };
    const raw = JSON.stringify(record);
    await writeFile(dir + '/review-progress.json', raw);
    return { project, dir, record, raw };
}
test('pending simplification owns status instead of the older full review', async (t) => {
    const f = await fixture(t);
    await writeFile(f.dir + '/simplification.json', JSON.stringify({ version: 1, taskId: 'author', taskDigest: f.record.taskDigest, sourceDigest: f.record.sourceDigest, baseDigest: hash(f.record.proposal), scope: 'privacy', state: {} }));
    const progress = await preparationProgress(f.project);
    assert.equal(progress.nextAction?.phase, 'simplification');
    assert.equal(progress.nextAction?.source, 'simplification.json');
    assert.equal(progress.nextAction?.check, 'privacy');
});
test('legacy recipe records without taskId bind to the exact retained review', async (t) => {
    const f = await fixture(t);
    await writeFile(f.dir + '/recipe-change.json', JSON.stringify({ version: 1, taskDigest: f.record.taskDigest, sourceDigest: f.record.sourceDigest, baseDigest: hash(f.raw), scope: 'privacy' }));
    const progress = await preparationProgress(f.project);
    assert.equal(progress.nextAction?.phase, 'recipe');
    assert.equal(progress.nextAction?.taskId, 'author');
    assert.equal(progress.nextAction?.source, 'recipe-change.json');
});
test('conflicting pending branches block status and resume before any model or question', async (t) => {
    const f = await fixture(t);
    for (const file of ['simplification.json', 'recipe-change.json'])
        await writeFile(f.dir + '/' + file, JSON.stringify({ version: 1, taskId: 'author' }));
    await assert.rejects(preparationProgress(f.project), /Conflicting/);
    await assert.rejects(resumePreparation(f.project, { write: () => { }, ask: async () => assert.fail('must not prompt') }), /Conflicting/);
    assert.equal(await readFile(f.dir + '/review-progress.json', 'utf8'), f.raw);
});
import { readPreparationSelection, assertPreparationSelection } from '../src/workflow/preparation-selection.ts';
import { driveCheckWorkflow, type WorkflowState } from '../src/workflow/preparation.ts';
import { CheckRequestInterrupted } from '../src/acceptance/request-failure.ts';
import { ScopeRepairBlocked } from '../src/acceptance/scoped-review.ts';
import { symlink } from 'node:fs/promises';
test('a newer generation owner blocks an old migration instead of resuming an older review', async (t) => {
    const f = await fixture(t);
    await writeFile(f.dir + '/recipe-change.json', JSON.stringify({ version: 1, taskDigest: f.record.taskDigest, sourceDigest: f.record.sourceDigest, baseDigest: hash(f.raw), scope: 'privacy' }));
    await writeFile(f.dir + '/preparation.json', JSON.stringify({ ...f.record, taskId: 'reader', operation: { id: 'reader-operation', sequence: 3 }, state: {} }));
    await assert.rejects(readPreparationSelection(f.project), /matching active review/);
});
test('pending migration identity, exact base and requested task must all match', async (t) => {
    const f = await fixture(t), valid = { version: 1, taskId: 'author', taskDigest: f.record.taskDigest, sourceDigest: f.record.sourceDigest, baseDigest: hash(f.record.proposal), scope: 'privacy', state: {} };
    for (const patch of [{ taskId: 'other' }, { taskDigest: 'changed' }, { sourceDigest: 'changed' }, { baseDigest: 'different' }, { scope: 'other' }]) {
        await writeFile(f.dir + '/simplification.json', JSON.stringify({ ...valid, ...patch }));
        await assert.rejects(readPreparationSelection(f.project), /different|match|unknown/);
    }
    await writeFile(f.dir + '/simplification.json', JSON.stringify(valid));
    await assert.rejects(readPreparationSelection(f.project, 'reader'), /Another task/);
    const before = await readFile(f.dir + '/simplification.json', 'utf8');
    assert.equal((await readPreparationSelection(f.project, 'author')).kind, 'simplify');
    assert.equal(await readFile(f.dir + '/simplification.json', 'utf8'), before);
});
test('published migration cleanup is selected without requiring the superseded original case', async (t) => {
    for (const name of ['simplification.json', 'recipe-change.json']) {
        const f = await fixture(t);
        const pending = { version: 1, taskId: 'author', taskDigest: f.record.taskDigest, sourceDigest: f.record.sourceDigest, scope: 'old-case', baseDigest: 'old-base', ...(name === 'simplification.json' ? { completedDigest: hash(f.record.proposal) } : { committedDigest: hash(f.raw) }) };
        await writeFile(f.dir + '/' + name, JSON.stringify(pending));
        assert.equal((await readPreparationSelection(f.project)).pending?.name, name);
    }
});
test('selection receipts reject changed saved records before resume and are not transferable', async (t) => {
    const f = await fixture(t), selection = await readPreparationSelection(f.project);
    assert.equal(selection.kind, 'resume');
    await assertPreparationSelection(f.project, selection);
    await writeFile(f.dir + '/guided-draft.json', '{}');
    await assert.rejects(assertPreparationSelection(f.project, selection), /Stale/);
    await assert.rejects(resumePreparation(f.project, { write: () => { }, ask: async () => assert.fail() }, true, selection), /Stale/);
    const other = await fixture(t);
    await assert.rejects(assertPreparationSelection(other.project, selection), /original project/);
    await assert.rejects(assertPreparationSelection(f.project, { ...selection }), /original project/);
    assert.throws(() => { (selection as any).kind = 'recipe'; }, TypeError);
});
test('selection refuses aliased phase files without changing their target', async (t) => {
    const f = await fixture(t);
    await symlink(f.dir + '/review-progress.json', f.dir + '/preparation.json');
    await assert.rejects(readPreparationSelection(f.project), /link/);
    assert.equal(await readFile(f.dir + '/review-progress.json', 'utf8'), f.raw);
});
test('status projects the same pending recipe selected for resume', async (t) => {
    const f = await fixture(t);
    await writeFile(f.dir + '/recipe-change.json', JSON.stringify({ version: 1, taskDigest: f.record.taskDigest, sourceDigest: f.record.sourceDigest, baseDigest: hash(f.raw), scope: 'privacy' }));
    const lines: string[] = [];
    await checkWorkflowStatus(f.project, s => lines.push(s));
    assert.match(lines.join('\n'), /Active preparation: author; recipe privacy; source recipe-change.json/);
    assert.match(lines.join('\n'), /checks use-recipe privacy/);
});
for (const failure of ['provider', 'repair'] as const)
    test(`a ${failure} failure cannot grant a retry to changed preparation inputs`, async () => {
        const state: WorkflowState = { version: 1, retried: [], runs: [] };
        let key = 'author:old-source:operation', calls = 0;
        const result = await driveCheckWorkflow(state, { snapshot: async () => ({ key, ready: false }), resume: async () => { calls++; key = 'reader:new-source:operation'; throw failure === 'provider' ? new CheckRequestInterrupted('provider', '502 temporarily unavailable') : new ScopeRepairBlocked('privacy', 'blocked'); }, repair: async () => assert.fail(), save: async () => { }, write: () => { }, wait: async () => assert.fail() });
        assert.equal(result, 'blocked');
        assert.equal(calls, 1);
        assert.equal(state.pendingRetry, undefined);
        assert.deepEqual(state.retried, []);
        assert.equal(state.interruptions, undefined);
        assert.match(state.problem!, /inputs changed/);
    });
import { prepareChecks } from '../src/acceptance/workflow.ts';
test('a selector failure closes its durable allowance as blocked rather than leaving a running status', async (t) => {
    const f = await fixture(t);
    for (const file of ['simplification.json', 'recipe-change.json'])
        await writeFile(f.dir + '/' + file, '{}');
    await assert.rejects(prepareChecks(f.project, { write: () => { }, ask: async () => assert.fail() }, { maxRequests: 1, maxSeconds: 1, requestSeconds: 1 }), /Conflicting/);
    const saved = JSON.parse(await readFile(f.dir + '/workflow.json', 'utf8'));
    assert.equal(saved.runs.at(-1).status, 'blocked');
    assert.equal(saved.runs.at(-1).spend.requests, 0);
    assert.match(saved.problem, /Conflicting/);
});
test('the selected preparation phase is durably saved before invoking its adapter', async () => {
    const state: WorkflowState = { version: 1, retried: [], runs: [] };
    let selected = false, recorded = false;
    const outcome = await driveCheckWorkflow(state, { snapshot: async () => { selected = true; return { key: 'task:source:owner', ready: false }; }, save: async () => { assert.equal(selected, true); recorded = true; }, write: () => { }, repair: async () => assert.fail(), resume: async (snapshot) => { assert.equal(snapshot.key, 'task:source:owner'); assert.equal(recorded, true); throw new CheckRequestInterrupted('provider', '401 authentication required'); } });
    assert.equal(outcome, 'paused');
});

import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readPreparationWorkflow,parseWorkflowState} from '../src/acceptance/workflow.ts';
import {saveControllerState} from '../src/workflow/state.ts';
import {withWriter,writerPath,recoverWriter} from '../src/workspace/writer-lock.ts';
test('process death after a scoped renewal keeps the same owner and cannot grant another repair',{timeout:15000},async t=>{
 const f=await fixture(t),progress=await preparationProgress(f.project);
 const state:WorkflowState={version:1,retried:[],runs:[{started:new Date().toISOString(),limits:{maxRequests:2,maxSeconds:60,requestSeconds:30},spend:{requests:1},status:'running'}],pendingRetry:{key:progress.key+':privacy',scope:'privacy',epoch:1},nextAction:progress.nextAction!};
 const script=`import {withWriter} from ${JSON.stringify(new URL('../src/workspace/writer-lock.ts',import.meta.url).href)};
 import {saveControllerState} from ${JSON.stringify(new URL('../src/workflow/state.ts',import.meta.url).href)};
 import {parseWorkflowState} from ${JSON.stringify(new URL('../src/acceptance/workflow.ts',import.meta.url).href)};
 import {readFile,writeFile} from 'node:fs/promises';
 await withWriter(process.argv[1],'checks prepare',async()=>{await saveControllerState(process.argv[1],'preparation',JSON.parse(process.argv[2]),parseWorkflowState,'checkpoint');
 const file=process.argv[1]+'-harness/acceptance/review-progress.json';const r=JSON.parse(await readFile(file,'utf8'));r.ledger.entries=[{scope:'privacy',retryCount:1}];await writeFile(file,JSON.stringify(r));process.send('renewed');await new Promise(()=>setInterval(()=>{},1000));});`;
 const child=spawn(process.execPath,['--input-type=module','-e',script,f.project,JSON.stringify(state)],{stdio:['ignore','ignore','pipe','ipc']});t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});let errors='';child.stderr!.on('data',c=>{errors+=c;});
 await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw Error(errors||'exited early');})]);const exit=once(child,'exit');child.kill('SIGKILL');await exit;
 const lock=JSON.parse(await readFile(await writerPath(f.project),'utf8'));await recoverWriter(f.project,lock.token);
 const saved=await readPreparationWorkflow(f.project);let resumes=0;
 await withWriter(f.project,'checks prepare',async()=>{
  const result=await driveCheckWorkflow(saved,{snapshot:async()=>({...await preparationProgress(f.project),ready:false}),resume:async()=>{resumes++;throw new CheckRequestInterrupted('provider','401 authentication required');},repair:async()=>assert.fail('renewal already committed'),save:()=>saveControllerState(f.project,'preparation',saved,parseWorkflowState,'paused'),write:()=>{}});assert.equal(result,'paused');
 });
 const retained=await readPreparationWorkflow(f.project);assert.equal(resumes,1);assert.equal(retained.pendingRetry,undefined);assert.deepEqual(retained.retried,[state.pendingRetry!.key]);assert.equal(retained.runs[0]!.spend.requests,1);assert.equal((await preparationProgress(f.project)).key,progress.key);
});
