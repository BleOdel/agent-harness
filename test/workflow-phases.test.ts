import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {withWriter, writerPath} from '../src/workspace/writer-lock.ts';
import {withOperationPhase, readOperation, parseOperation, describeOperation, operationProjection} from '../src/workflow/operations.ts';
import {nextAction} from '../src/view/guidance.ts';
import {emptyWorkspace} from '../src/view/workspace.ts';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'phase-test-'));
  const project = path.join(root, 'app');
  await mkdir(project);
  t.after(() => rm(root, {recursive:true, force:true}));
  return project;
}
function latch() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return {promise, release}; }

test('phase reservations precede work and retain causal command ownership', async t => {
  const project = await fixture(t);
  await withWriter(project, 'continue', async () => {
    await withOperationPhase(project, 'preparing', 'task-a', async () => {
      const state = (await readOperation(project))!;
      assert.equal(state.dispatches.at(-1)?.phase?.kind, 'preparing');
      assert.equal(state.dispatches.at(-1)?.phase?.reference, 'task-a');
      assert.equal(state.dispatches.at(-1)?.state, 'reserved');
      await withWriter(project, 'checks repair', async () => {
        const nested = (await readOperation(project))!;
        assert.equal(nested.dispatches.at(-1)?.parent, state.dispatches.at(-1)?.id);
      });
    });
    await withOperationPhase(project, 'building', 'r1/attempt-1', async () => {});
  });
  const state = (await readOperation(project))!;
  assert.equal(state.state, 'returned');
  assert.equal(state.dispatches.every(d => d.state === 'returned'), true);
  assert.equal(state.progress, null, 'returning from phases creates no acceptance or application proof');
});

test('phases require an active owner and reject competing siblings before dispatch', async t => {
  const project = await fixture(t), gate = latch(), entered = latch();
  let effects = 0;
  await assert.rejects(withOperationPhase(project, 'building', 'r1', async () => { effects++; }), /owner/i);
  await withWriter(project, 'work', async () => {
    const first = withOperationPhase(project, 'building', 'r1', async () => { entered.release(); await gate.promise; });
    await entered.promise;
    try { await assert.rejects(withOperationPhase(project, 'applying', 'r1', async () => { effects++; }), /active/i); }
    finally { gate.release(); await first; }
  });
  assert.equal(effects, 0);
  assert.equal((await readOperation(project))!.dispatches.length, 2);
});

test('a parent cannot release its writer while an unawaited child phase runs', async t => {
  const project = await fixture(t), entered = latch(), gate = latch();
  let child!: Promise<void>, returned = false;
  const parent = withWriter(project, 'work', async () => {
    child = withOperationPhase(project, 'verifying', 'r1', async () => { entered.release(); await gate.promise; });
    await entered.promise;
  });
  const result = parent.then(() => { returned = true; return null; }, e => { returned = true; return e; });
  await entered.promise;
  await new Promise(resolve => setTimeout(resolve, 30));
  const held = !returned;
  const lockExists = await readFile(await writerPath(project), 'utf8').then(() => true, () => false);
  const running = await readOperation(project);
  gate.release(); const childError = await child.then(() => null, error => error);
  const error = await result;
  assert.equal(held, true);
  assert.equal(lockExists, true);
  assert.equal(running?.state, 'running');
  assert.equal(childError,null);
  assert.match(String(error), /await.*child|child.*await/i);
  assert.equal((await readOperation(project))!.state, 'failed');
});

test('a late phase callback cannot resurrect a finished owner', async t => {
  const project = await fixture(t), gate = latch();
  let delayed!: Promise<void>, effects = 0;
  await withWriter(project, 'work', async () => {
    delayed = gate.promise.then(() => withOperationPhase(project, 'applying', 'r1', async () => { effects++; }));
  });
  gate.release(); await assert.rejects(delayed, /finished/i);
  assert.equal(effects, 0);
});

test('phase dispatch refuses stale durable state before executing a side effect', async t => {
  const project = await fixture(t); let effects = 0;
  await assert.rejects(withWriter(project, 'work', async () => {
    const state = (await readOperation(project))!;
    state.revision++;
    await writeFile(project + '-harness/operations/current.json', JSON.stringify(state));
    await withOperationPhase(project, 'applying', 'r1', async () => { effects++; });
  }), /stale/i);
  assert.equal(effects, 0);
});

test('CLI and dashboard use the same active phase projection, never a success inference', async t => {
  const project = await fixture(t);
  await withWriter(project, 'work', () => withOperationPhase(project, 'reviewing', 'r1/attempt-2', async () => {
    const operation = (await readOperation(project))!;
    const projection = operationProjection(operation);
    assert.match(projection.detail, /reviewing.*r1\/attempt-2/);
    const lines: string[] = []; await describeOperation(project, s => { lines.push(s); });
    assert.ok(lines.includes(projection.detail));
    const action = nextAction([], [], [], {...emptyWorkspace(), operation});
    assert.ok(action.message.includes(projection.detail));
    assert.equal(action.command, 'harness continue status');
  }));
});

test('legacy operation bytes still parse; invalid phase metadata is rejected', async t => {
  const project = await fixture(t);
  await withWriter(project, 'continue', async () => {});
  const legacy = (await readOperation(project))!;
  assert.deepEqual(parseOperation(legacy), legacy);
  const bad = structuredClone(legacy) as any;
  bad.dispatches[0].phase = {kind:'applying', reference:'r1', approved:true};
  assert.throws(() => parseOperation(bad), /fields/i);
  bad.dispatches[0].phase = {kind:'unknown', reference:'r1'};
  assert.throws(() => parseOperation(bad), /phase/i);
});

import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {recoverWriter} from '../src/workspace/writer-lock.ts';
import {driveContinuation, type ContinueState} from '../src/workflow/controller.ts';
import {saveContinuation, readContinuation} from '../src/workflow/store.ts';

for (const [command, kind, next] of [['checks prepare', 'preparing', 'repairing'], ['continue', 'building', 'verifying'], ['stage review', 'reviewing', 'applying']] as const) {
  test(`a process death inside ${kind} retains uncertainty before ${next} can start`, {timeout:15000}, async t => {
    const project = await fixture(t);
    const script = `import {withWriter} from ${JSON.stringify(new URL('../src/workspace/writer-lock.ts', import.meta.url).href)};
      import {withOperationPhase} from ${JSON.stringify(new URL('../src/workflow/operations.ts', import.meta.url).href)};
      await withWriter(process.argv[1], process.argv[2], () => withOperationPhase(process.argv[1], process.argv[3], 'task-a', async () => {
        process.send('phase-reserved'); await new Promise(() => setInterval(() => {}, 1000));
      }));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, project, command, kind], {stdio:['ignore', 'ignore', 'pipe', 'ipc']});
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let errors = ''; child.stderr!.on('data', chunk => { errors += chunk; });
    await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw Error(errors || 'child exited'); })]);
    const original = (await readOperation(project))!;
    assert.equal(original.dispatches.at(-1)?.phase?.kind, kind);
    assert.equal(original.dispatches.at(-1)?.state, 'reserved');
    await assert.rejects(withWriter(project, command, async () => assert.fail('duplicate side effect')), /locked/);
    const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    const lock = JSON.parse(await readFile(await writerPath(project), 'utf8'));
    await recoverWriter(project, lock.token);
    await withWriter(project, command, () => withOperationPhase(project, next, 'task-a', async () => {}));
    const history = parseOperation(JSON.parse(await readFile(`${project}-harness/operations/history/${original.id}.json`, 'utf8')));
    assert.equal(history.state, 'interrupted');
    assert.equal(history.dispatches.at(-1)?.state, 'uncertain');
    const resumed = (await readOperation(project))!;
    assert.equal(resumed.previous, original.id);
    assert.equal(resumed.dispatches.at(-1)?.phase?.kind, next);
    assert.equal(resumed.dispatches.at(-1)?.state, 'returned');
    assert.equal(resumed.progress, null, 'recovery is not evidence of application success');
  });
}

test('resumed continuation dispatches only the unfinished phase and keeps its allowance', async t => {
  const project = await fixture(t);
  let approved = false, staged = false;
  const state: ContinueState = {version:1,task:'author',status:'running',message:'start',updated:new Date().toISOString(),attempts:0,maxBuilds:1,recoveries:0,events:[]};
  const calls: string[] = [];
  const services = {
    dispatch: <T>(kind: import('../src/workflow/operations.ts').OperationPhase, action: () => Promise<T>) => withOperationPhase(project, kind, 'author', action),
    snapshot: async () => ({done:false,checks:approved?'approved' as const:'missing' as const,...(staged?{stage:'r1'}:{})}),
    prepare: async () => { calls.push('prepare'); return 'ready' as const; },
    review: async () => { calls.push('review'); },
    build: async () => { calls.push('build'); staged = true; },
    save: (s: ContinueState) => saveContinuation(project,s), write: (_s:string) => {},
  };
  await withWriter(project,'continue',()=>driveContinuation(state,services));
  assert.equal(state.status,'approval');
  assert.deepEqual(calls,['prepare','review']);
  approved = true;
  await withWriter(project,'continue',async()=>driveContinuation((await readContinuation(project))!,services));
  assert.deepEqual(calls,['prepare','review','build']);
  const resumed = (await readOperation(project))!;
  assert.deepEqual(resumed.dispatches.filter(d=>d.phase).map(d=>d.phase!.kind),['building']);
  assert.equal(resumed.progress?.status,'approval');
  assert.equal((await readContinuation(project))!.attempts,1);
  await withWriter(project,'continue',async()=>driveContinuation((await readContinuation(project))!,services));
  assert.deepEqual(calls,['prepare','review','build'],'a staged candidate must never trigger another builder');
});

import {checkpointOperation} from '../src/workflow/operations.ts';
test('saved progress binds to the phase that produced it and cannot name a different dispatch', async t => {
  const project = await fixture(t);
  await withWriter(project,'work',()=>withOperationPhase(project,'staging','r1',async()=>{
    const state=(await readOperation(project))!;
    const phase=state.dispatches.at(-1)!;
    await checkpointOperation(project,{kind:'stage',reference:'staging/r1/state.json',digest:'a'.repeat(64),status:'approval'});
    assert.equal((await readOperation(project))!.progress?.dispatchId,phase.id);
    await assert.rejects(checkpointOperation(project,{kind:'stage',reference:'staging/r1/state.json',digest:'b'.repeat(64),status:'complete',dispatchId:state.dispatches[0]!.id}),/dispatch/i);
    assert.equal((await readOperation(project))!.progress?.status,'approval');
  }));
  const tampered=(await readOperation(project))!;
  tampered.checkpoints[0]!.dispatchId='00000000-0000-0000-0000-000000000000';
  tampered.progress=tampered.checkpoints[0]!;
  assert.throws(()=>parseOperation(tampered),/dispatch/i);
});
