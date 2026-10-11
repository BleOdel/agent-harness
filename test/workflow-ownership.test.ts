import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {withWriter} from '../src/workspace/writer-lock.ts';
import {readOperation, checkpointOperation, currentOperationId, assertOperationRevision} from '../src/workflow/operations.ts';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'operation-test-'));
  const project = path.join(root, 'app');
  await mkdir(project);
  t.after(() => rm(root, {recursive: true, force: true}));
  return project;
}

test('continuation and nested work share one owner; reservations precede side effects', async t => {
  const project = await fixture(t);
  await withWriter(project, 'continue', async () => {
    const id = currentOperationId(project);
    assert.ok(id);
    const before = await readOperation(project);
    assert.equal(before?.dispatches[0]?.state, 'reserved');
    await withWriter(project, 'work', async () => {
      assert.equal(currentOperationId(project), id);
      const state = (await readOperation(project))!;
      assert.equal(state.dispatches.length, 2);
      assert.equal(state.dispatches[1]?.parent, state.dispatches[0]?.id);
      assert.equal(state.dispatches[1]?.state, 'reserved');
      await checkpointOperation(project, {kind: 'implementation', reference: 'implementation/r1/state.json', digest: 'a'.repeat(64), status: 'paused'});
    });
  });
  const final = (await readOperation(project))!;
  assert.equal(final.state, 'returned');
  assert.equal(final.progress?.status, 'paused');
  assert.equal(final.dispatches.every(d => d.state === 'returned'), true);
  assert.equal(final.checkpoints.length, 1);
});

test('parallel nested commands cannot use inherited ownership to dispatch twice', async t => {
  const project = await fixture(t);
  await withWriter(project, 'continue', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const first = withWriter(project, 'checks prepare', async () => { entered(); await held; });
    await ready;
    await assert.rejects(withWriter(project, 'work', async () => assert.fail('second side effect')), /nested writer/i);
    release(); await first;
  });
  assert.equal((await readOperation(project))!.dispatches.length, 2);
});

test('stale guidance is rejected and legacy continuation bytes remain untouched', async t => {
  const project = await fixture(t);
  await mkdir(project + '-harness');
  const legacy = '{"version":1,"legacy":"retained exactly"}\n';
  await writeFile(project + '-harness/continuation.json', legacy);
  await withWriter(project, 'checks prepare', async () => {});
  const before = (await readOperation(project))!;
  await withWriter(project, 'checks repair', async () => {
    await assert.rejects(assertOperationRevision(project, before.id, before.revision), /stale/i);
  });
  const after = (await readOperation(project))!;
  assert.notEqual(after.id, before.id);
  assert.equal(after.previous, before.id);
  assert.deepEqual(JSON.parse(await readFile(project + `-harness/operations/history/${before.id}.json`, 'utf8')), before);
  assert.equal(await readFile(project + '-harness/continuation.json', 'utf8'), legacy);
});

test('exceptions preserve a failed dispatch and checkpoint without claiming application success', async t => {
  const project = await fixture(t);
  await assert.rejects(withWriter(project, 'work', async () => {
    await checkpointOperation(project, {kind: 'run', reference: 'r3', digest: 'b'.repeat(64), status: 'attention'});
    throw Error('synthetic failure');
  }), /synthetic failure/);
  const state = (await readOperation(project))!;
  assert.equal(state.state, 'failed');
  assert.equal(state.dispatches[0]?.state, 'failed');
  assert.equal(state.progress?.status, 'attention');
  assert.equal(state.checkpoints[0]?.reference, 'r3');
});

import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {recoverWriter, writerPath} from '../src/workspace/writer-lock.ts';
import {appendRun, readRecord} from '../src/record/record.ts';
import {saveContinuation} from '../src/workflow/store.ts';

for (const [first, competing] of [['checks prepare', 'checks repair'], ['continue', 'work'], ['stage review', 'stage apply']]) {
  test(`${first} versus ${competing}: crash retains one uncertain reservation and explicit recovery`, async t => {
    const project = await fixture(t);
    const source = `import {withWriter} from ${JSON.stringify(new URL('../src/workspace/writer-lock.ts', import.meta.url).href)};
      await withWriter(${JSON.stringify(project)}, ${JSON.stringify(first)}, async () => {
        process.send('reserved'); await new Promise(() => setInterval(() => {}, 1000));
      });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let stderr = ''; child.stderr!.on('data', data => { stderr += data; });
    await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw Error(stderr || 'child exited'); })]);
    const original = (await readOperation(project))!;
    assert.equal(original.state, 'running');
    assert.equal(original.dispatches.length, 1);
    await assert.rejects(withWriter(project, competing!, async () => assert.fail('competing dispatch')), /locked/);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    await assert.rejects(withWriter(project, competing!, async () => assert.fail('unrecovered dispatch')), /locked/);
    const lock = JSON.parse(await readFile(await writerPath(project), 'utf8'));
    await recoverWriter(project, lock.token);
    await withWriter(project, competing!, async () => {});
    const next = (await readOperation(project))!;
    const retained = JSON.parse(await readFile(project + `-harness/operations/history/${original.id}.json`, 'utf8'));
    assert.equal(retained.state, 'interrupted');
    assert.equal(retained.dispatches[0].state, 'uncertain');
    assert.equal(retained.dispatches.length, 1);
    assert.equal(next.previous, original.id);
    assert.equal(next.dispatches.length, 1);
  });
}

test('saved run and continuation adapters bind progress to the actual owner', async t => {
  const project = await fixture(t);
  await withWriter(project, 'continue', async () => {
    await appendRun(project, {id:'r1',at:new Date().toISOString(),project,goal:'demo',attempts:1,outcome:'blocked',gates:[],changes:[]});
    const runs = await readRecord(project);
    assert.equal(runs.runs[0]?.operationId, currentOperationId(project));
    assert.equal((await readOperation(project))?.progress?.status, 'attention');
    await saveContinuation(project, {version:1,task:'demo',status:'paused',message:'allowance reached',updated:new Date().toISOString(),attempts:1,maxBuilds:1,recoveries:0,events:[]});
    assert.equal((await readOperation(project))?.progress?.status, 'paused');
  });
});

test('late inherited callbacks cannot write after their owner returns', async t => {
  const project = await fixture(t);
  let delayed!: Promise<void>;
  let release!: () => void;
  const signal = new Promise<void>(resolve => { release = resolve; });
  await withWriter(project, 'work', async () => {
    delayed = signal.then(() => withWriter(project, 'work', async () => assert.fail('late dispatch')));
  });
  release();
  await assert.rejects(delayed, /nested writer|Operation owner has finished/);
  assert.equal((await readOperation(project))?.dispatches.length, 1);
});

test('status revision guards dispatch itself before any replacement or side effect', async t => {
  const project = await fixture(t);
  await withWriter(project, 'work', async () => {});
  const expected = (await readOperation(project))!;
  await withWriter(project, 'checks prepare', async () => {}, false, {id:expected.id,revision:expected.revision});
  const latest = await readOperation(project);
  await assert.rejects(withWriter(project, 'work', async () => assert.fail('stale dispatch'), false, {id:expected.id,revision:expected.revision}), /Stale operation/);
  assert.deepEqual(await readOperation(project), latest);
});

test('operation compare-and-swap refuses a non-cooperating edit', async t => {
  const project = await fixture(t);
  await assert.rejects(withWriter(project, 'work', async () => {
    const state = (await readOperation(project))!;
    state.revision++;
    await writeFile(project + '-harness/operations/current.json', JSON.stringify(state));
    await checkpointOperation(project, {kind:'run',reference:'r1',digest:'a'.repeat(64),status:'complete'});
  }), /Stale operation/);
  assert.equal((await readOperation(project))?.checkpoints.length, 0);
});

import {nextAction} from '../src/view/guidance.ts';
import {emptyWorkspace} from '../src/view/workspace.ts';

test('dashboard projects unresolved ownership instead of recommending another dispatch', async t => {
  const project = await fixture(t);
  await withWriter(project, 'continue', async () => {
    const operation = (await readOperation(project))!;
    const action = nextAction([], [], [], {...emptyWorkspace(), operation});
    assert.equal(action.command, 'harness continue status');
    assert.match(action.message, new RegExp(operation.id));
    assert.match(action.message, /does not prove/);
  });
});

test('a replaced writer token cannot publish another operation checkpoint', async t => {
  const project = await fixture(t);
  await assert.rejects(withWriter(project, 'work', async () => {
    const file = await writerPath(project);
    const owner = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({...owner, token:'00000000-0000-0000-0000-000000000000'}));
    await assert.rejects(checkpointOperation(project, {kind:'run',reference:'r1',digest:'a'.repeat(64),status:'complete'}), /Writer owner/);
    assert.equal((await readOperation(project))?.checkpoints.length, 0);
  }), /Writer owner/);
  assert.equal((await readOperation(project))?.checkpoints.length, 0);
});

import {appendRunOnce} from '../src/record/record.ts';

test('journal replay pins the exact original record and reports completion without rewriting it', async t => {
  const project = await fixture(t);
  const run = {id:'r1',at:new Date().toISOString(),project,goal:'demo',attempts:1,outcome:'applied' as const,gates:[],changes:[]};
  await withWriter(project, 'stage apply', async () => { await appendRunOnce(project, run); });
  const original = await readFile(project + '-harness/record.jsonl', 'utf8');
  await withWriter(project, 'stage apply', async () => { await appendRunOnce(project, run); });
  assert.equal(await readFile(project + '-harness/record.jsonl', 'utf8'), original);
  const operation = (await readOperation(project))!;
  assert.equal(operation.progress?.kind, 'run');
  assert.equal(operation.progress?.status, 'complete');
});
