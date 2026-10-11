import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink, link, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createState, readState, appendEvent } from '../src/team/state.ts';
import { parseTeamPlan } from '../src/team/schema.ts';
import { withWriter } from '../src/workspace/writer-lock.ts';
import { readOperation } from '../src/workflow/operations.ts';
const plan = () => parseTeamPlan({ version: 1, roles: [{ id: 'builder', instructions: 'Build', skills: [] }], skills: [], contracts: {} }, [{ id: 'one', title: 'One', priority: 'must', status: 'todo', criteria: ['Works'], dependsOn: [], assignedRole: 'builder', changeScope: ['src/**'] }]);
const baseline = { directory: '/host/baseline', digest: 'a'.repeat(64), files: {} };
const policy = { maxAttempts: 2, maxDispatches: 10, maxMs: 600000, maxCostUsd: 10 };
async function fixture(t: import('node:test').TestContext) { const top = await mkdtemp(path.join(os.tmpdir(), 'team-workflow-')); t.after(() => rm(top, { recursive: true, force: true })); const project = top + '/app'; await mkdir(project); const root = project + '-harness/teams/team-fixture'; await mkdir(root, { recursive: true }); await createState(root, plan(), baseline, policy, 'team-fixture'); return { project, root }; }
test('team status reads do not rewrite missing or damaged projections', async (t) => { const { root } = await fixture(t); await writeFile(root + '/state.json', 'damaged'); const state = await readState(root); assert.equal(state.seq, 1); assert.equal(await readFile(root + '/state.json', 'utf8'), 'damaged'); await rm(root + '/state.json'); assert.equal((await readState(root)).seq, 1); await assert.rejects(readFile(root + '/state.json'), { code: 'ENOENT' }); });
test('stale and copied team decisions cannot advance a newer journal', async (t) => { const { root } = await fixture(t); const old = await readState(root), newer = await readState(root); await appendEvent(root, { type: 'stopped', reason: 'budget' }, newer); const files = await readdir(root + '/events'); await assert.rejects(appendEvent(root, { type: 'resumed', resumeId: 'old' }, old), /Stale/); await assert.rejects(appendEvent(root, { type: 'resumed', resumeId: 'copy' }, { ...await readState(root) }), /original|read/); assert.deepEqual(await readdir(root + '/events'), files); assert.equal((await readState(root)).status, 'stopped'); });
test('changed prior event bytes invalidate an otherwise unchanged team sequence', async (t) => { const { root } = await fixture(t); const state = await readState(root); const file = root + '/events/00000001.json'; await writeFile(file, (await readFile(file, 'utf8')) + '\n'); await assert.rejects(appendEvent(root, { type: 'stopped', reason: 'stale' }, state), /Stale/); assert.equal((await readState(root)).seq, 1); });
test('team journal refuses event links and aliased event directories', async (t) => { const { root } = await fixture(t); const file = root + '/events/00000001.json', saved = await readFile(file); await rm(file); await writeFile(root + '/outside.json', saved); await symlink('../outside.json', file); await assert.rejects(readState(root), /link|ELOOP/); await rm(file); await link(root + '/outside.json', file); await assert.rejects(readState(root), /link/); await rm(file); await writeFile(file, saved); const { rename } = await import('node:fs/promises'); await rename(root + '/events', root + '/real-events'); await symlink('real-events', root + '/events'); await assert.rejects(readState(root), /link/); });
test('team event writes belong to the project writer and are operation bound', async (t) => { const { root, project } = await fixture(t); const state = await readState(root); await appendEvent(root, { type: 'stopped', reason: 'budget' }, state); const operation = (await readOperation(project))!; assert.ok(operation); const event = JSON.parse(await readFile(root + '/events/00000002.json', 'utf8')); assert.equal(event.operationId, operation.id); assert.equal((await readState(root)).seq, 2); await withWriter(project, 'work', async () => { const fresh = await readState(root); await appendEvent(root, { type: 'resumed', resumeId: 'resume' }, fresh); }); const next = JSON.parse(await readFile(root + '/events/00000003.json', 'utf8')); assert.equal(next.operationId, (await readOperation(project))!.id); });
test('explicit team projection repair is guarded and leaves immutable events unchanged', async (t) => { const { root } = await fixture(t); const bytes = await readFile(root + '/events/00000001.json', 'utf8'); await writeFile(root + '/state.json', 'broken'); const state = await readState(root, true); assert.deepEqual(JSON.parse(await readFile(root + '/state.json', 'utf8')), state); assert.equal(await readFile(root + '/events/00000001.json', 'utf8'), bytes); });
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writerPath, recoverWriter } from '../src/workspace/writer-lock.ts';
const lockModule = new URL('../src/workspace/writer-lock.ts', import.meta.url).href;
const storeModule = new URL('../src/team/state.ts', import.meta.url).href;
async function childOwner(t: import('node:test').TestContext, project: string, root: string, commit: boolean) {
    const script = `import {withWriter} from ${JSON.stringify(lockModule)};import {readState,appendEvent} from ${JSON.stringify(storeModule)};await withWriter(process.argv[1],'team',async()=>{if(process.argv[3]==='yes')await appendEvent(process.argv[2],{type:'stopped',reason:'retained'},await readState(process.argv[2]));process.send('ready');await new Promise(()=>{setInterval(()=>{},1000);});});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, project, root, commit ? 'yes' : 'no'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr!.on('data', c => stderr += c);
    t.after(() => { child.kill('SIGKILL'); });
    const ready = await Promise.race([once(child, 'message').then(() => true), once(child, 'exit').then(() => false), new Promise<boolean>(r => { const timer = setTimeout(() => r(false), 10000); timer.unref(); })]);
    assert.equal(ready, true, stderr);
    return child;
}
test('team versus ordinary work has one cross-process owner and status remains read-only', async (t) => {
    const { project, root } = await fixture(t);
    const before = await readFile(root + '/state.json', 'utf8');
    const child = await childOwner(t, project, root, false);
    await assert.rejects(withWriter(project, 'work', async () => assert.fail('must not dispatch')), /locked by team/);
    await assert.rejects(appendEvent(root, { type: 'stopped', reason: 'competing' }), /locked by team/);
    assert.equal((await readState(root)).seq, 1);
    assert.equal(await readFile(root + '/state.json', 'utf8'), before);
    const exit = once(child, 'exit');
    child.kill('SIGKILL');
    await exit;
    const lock = JSON.parse(await readFile(await writerPath(project), 'utf8'));
    await recoverWriter(project, lock.token);
});
test('process death after a committed team event replays one outcome without granting success', async (t) => {
    const { project, root } = await fixture(t);
    const child = await childOwner(t, project, root, true);
    const event = await readFile(root + '/events/00000002.json', 'utf8');
    const old = (await readOperation(project))!;
    const exit = once(child, 'exit');
    child.kill('SIGKILL');
    await exit;
    const lock = JSON.parse(await readFile(await writerPath(project), 'utf8'));
    await recoverWriter(project, lock.token);
    await rm(root + '/state.json');
    const replayed = await readState(root);
    assert.equal(replayed.seq, 2);
    assert.equal(replayed.status, 'stopped');
    assert.deepEqual(replayed.integrated, []);
    await readState(root, true);
    assert.equal(await readFile(root + '/events/00000002.json', 'utf8'), event);
    assert.equal((await readdir(root + '/events')).length, 2);
    const history = JSON.parse(await readFile(project + '-harness/operations/history/' + old.id + '.json', 'utf8'));
    assert.equal(history.state, 'interrupted');
    assert.ok(history.dispatches.some((d: {
        state: string;
    }) => d.state === 'uncertain'));
});
test('event commit survives projection failure and exact replay does not append another event', async (t) => {
    const { root } = await fixture(t);
    const s = await readState(root);
    await rm(root + '/state.json');
    await mkdir(root + '/state.json');
    await assert.rejects(appendEvent(root, { type: 'stopped', reason: 'saved' }, s), /regular/);
    assert.equal((await readState(root)).status, 'stopped');
    assert.equal((await readState(root)).seq, 2);
    await rm(root + '/state.json', { recursive: true });
    await readState(root, true);
    assert.equal((await readdir(root + '/events')).length, 2);
});
test('a receipt from another run cannot authorize a transition even with identical state', async (t) => {
    const a = await fixture(t), b = await fixture(t);
    const s = await readState(a.root);
    await assert.rejects(appendEvent(b.root, { type: 'stopped', reason: 'foreign' }, s), /original journal/);
    assert.equal((await readState(b.root)).seq, 1);
});
test('team controller refuses a late worker result after its journal decision changed', async (t) => {
    const top = await mkdtemp(path.join(os.tmpdir(), 'team-late-result-'));
    t.after(() => rm(top, { recursive: true, force: true }));
    const project = top + '/app';
    await mkdir(project);
    const p = plan();
    await writeFile(project + '/features.json', JSON.stringify(p.tasks));
    await writeFile(project + '/base.txt', 'original');
    const { createTeam, driveTeam } = await import('../src/team/controller.ts');
    const { copySource, captureCandidate } = await import('../src/workspace/candidate.ts');
    const root = await createTeam(project, p, top, policy);
    let verified = 0;
    await assert.rejects(driveTeam(root, {
        async execute(a) { const source = a.directory + '/work'; await copySource(a.baseline.directory, source); await mkdir(source + '/src'); await writeFile(source + '/src/new.txt', 'candidate'); const candidate = await captureCandidate(a.baseline, source, a.directory + '/candidate'); await appendEvent(root, { type: 'interrupted', attemptId: a.id, reason: 'Another decision reconciled the attempt' }, await readState(root)); return { outcome: 'submitted', candidate, usage: { tokens: 1, costUsd: 0, complete: true }, observedReads: [], workflowEvidence: [] }; },
        async verify() { verified++; throw Error('must not verify stale result'); }, async verifyIntegration() { throw Error('must not integrate'); }, async cleanup() { }
    }), /Stale team decision/);
    assert.equal(verified, 0);
    const state = await readState(root);
    assert.equal(state.attempts[0]?.status, 'interrupted');
    assert.deepEqual(state.integrated, []);
    await assert.rejects(readFile(project + '/src/new.txt'), { code: 'ENOENT' });
});
test('aliased project owner cannot redirect team reads or create writes', async (t) => {
    const { root, project } = await fixture(t);
    const { rename } = await import('node:fs/promises');
    await rename(project + '-harness', project + '-retained');
    await symlink(project + '-retained', project + '-harness');
    await assert.rejects(readState(root), /link/);
    await assert.rejects(createState(project + '-harness/teams/team-other', plan(), baseline, policy, 'team-other'), /link/);
    await assert.rejects(readFile(project + '-retained/teams/team-other/events/00000001.json'), { code: 'ENOENT' });
});
