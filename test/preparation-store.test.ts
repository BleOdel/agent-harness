import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { withPreparationWriter, atomicWrite, removePreparationFile } from '../src/workflow/preparation-store.ts';
async function fixture(t: import('node:test').TestContext) { const root = await mkdtemp(path.join(os.tmpdir(), 'preparation-store-')); t.after(() => rm(root, { recursive: true, force: true })); const project = root + '/app', dir = project + '-harness/acceptance'; await mkdir(project); await mkdir(dir, { recursive: true }); return { project, dir }; }
test('preparation publication rejects a replaced sibling checkpoint and keeps approvals intact', async (t) => {
    const { project, dir } = await fixture(t), file = dir + '/preparation.json', sibling = dir + '/review-progress.json';
    await writeFile(file, '{"old":true}\n');
    await writeFile(sibling, '{"review":1}');
    await writeFile(dir + '/checks.json', 'approved bytes');
    await assert.rejects(withPreparationWriter(project, 'checks draft', async () => { await writeFile(sibling, '{"review":2}'); await atomicWrite(file, '{"old":false}'); }), /Stale preparation/);
    assert.equal(await readFile(file, 'utf8'), '{"old":true}\n');
    assert.equal(await readFile(sibling, 'utf8'), '{"review":2}');
    assert.equal(await readFile(dir + '/checks.json', 'utf8'), 'approved bytes');
});
test('nested preparation stages reuse current bytes and preserve digest-sensitive JSON', async (t) => {
    const { project, dir } = await fixture(t), file = dir + '/preparation.json';
    await withPreparationWriter(project, 'checks draft', async () => { await atomicWrite(file, '{"stage":1}'); await withPreparationWriter(project, 'checks outline', () => atomicWrite(file, '{"stage":2}\n')); await atomicWrite(dir + '/review-progress.json', '{"complete":true}'); await removePreparationFile(file); });
    await assert.rejects(readFile(file), { code: 'ENOENT' });
    assert.equal(await readFile(dir + '/review-progress.json', 'utf8'), '{"complete":true}');
    await withPreparationWriter(project, 'checks resume', () => atomicWrite(dir + '/review-progress.json', '{"resumed":true}'));
    assert.equal(await readFile(dir + '/review-progress.json', 'utf8'), '{"resumed":true}');
});
test('stale removal cannot erase a newer checkpoint', async (t) => {
    const { project, dir } = await fixture(t), file = dir + '/simplification.json';
    await writeFile(file, 'before');
    await assert.rejects(withPreparationWriter(project, 'checks simplify', async () => { await writeFile(file, 'after'); await removePreparationFile(file, { force: true }); }), /Stale preparation/);
    assert.equal(await readFile(file, 'utf8'), 'after');
});
test('late provider callbacks and unscoped writes cannot publish checkpoint files', async (t) => {
    const { project, dir } = await fixture(t);
    let release!: () => void;
    let late!: Promise<void>;
    await withPreparationWriter(project, 'checks draft', async () => { late = new Promise<void>(r => { release = r; }).then(() => atomicWrite(dir + '/preparation.json', 'late')); });
    release();
    await assert.rejects(late, /scope|closed/i);
    await assert.rejects(atomicWrite(dir + '/preparation.json', 'unowned'), /scope/i);
    await assert.rejects(readFile(dir + '/preparation.json'), { code: 'ENOENT' });
});
test('preparation store notices new regeneration records and refuses aliased paths', async (t) => {
    const { project, dir } = await fixture(t);
    await mkdir(dir + '/regenerations');
    await assert.rejects(withPreparationWriter(project, 'checks regenerate', async () => { await writeFile(dir + '/regenerations/task.json', 'newer'); await atomicWrite(dir + '/review-progress.json', 'obsolete'); }), /Stale preparation/);
    await symlink(dir + '/regenerations/task.json', dir + '/preparation.json');
    await assert.rejects(withPreparationWriter(project, 'checks draft', async () => { }), /symlink|regular/i);
});
test('queued checkpoint writes keep their submission order', async (t) => {
    const { project, dir } = await fixture(t), file = dir + '/outline-planning.json';
    await withPreparationWriter(project, 'checks outline', async () => { await Promise.all([atomicWrite(file, 'one'), atomicWrite(file, 'two'), atomicWrite(file, 'three')]); });
    assert.equal(await readFile(file, 'utf8'), 'three');
});
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writerPath, recoverWriter } from '../src/workspace/writer-lock.ts';
import { readOperation } from '../src/workflow/operations.ts';
test('prepare versus repair has one owner; killed publication resumes exact checkpoints without approval', { timeout: 15000 }, async (t) => {
    const { project, dir } = await fixture(t);
    const script = `import {withPreparationWriter,atomicWrite} from ${JSON.stringify(new URL('../src/workflow/preparation-store.ts', import.meta.url).href)};
 await withPreparationWriter(process.argv[1],'checks prepare',async()=>{await atomicWrite(process.argv[1]+'-harness/acceptance/preparation.json','{"completed":["outline"],"requests":2}');process.send('saved');await new Promise(()=>setInterval(()=>{},1000));});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, project], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let errors = '';
    child.stderr!.on('data', c => { errors += c; });
    t.after(() => { if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL'); });
    await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw Error(errors || 'exited early'); })]);
    await assert.rejects(withPreparationWriter(project, 'checks repair', async () => assert.fail('competing repair entered')), /locked/i);
    const saved = await readFile(dir + '/preparation.json', 'utf8'), operation = await readOperation(project);
    assert.equal(operation?.checkpoints.at(-1)?.reference, 'acceptance/preparation.json');
    assert.equal(operation?.progress?.status, 'checkpoint');
    const exit = once(child, 'exit');
    child.kill('SIGKILL');
    await exit;
    await recoverWriter(project, JSON.parse(await readFile(await writerPath(project), 'utf8')).token);
    await withPreparationWriter(project, 'checks prepare', async () => { assert.equal(await readFile(dir + '/preparation.json', 'utf8'), saved); await atomicWrite(dir + '/review-progress.json', '{"requests":2,"ready":false}'); });
    assert.equal(await readFile(dir + '/preparation.json', 'utf8'), saved);
    await assert.rejects(readFile(dir + '/checks.json'), { code: 'ENOENT' });
    assert.notEqual((await readOperation(project))?.id, operation?.id);
});

test('parallel nested preparation commands cannot dispatch under the same inherited owner',async t=>{
 const {project}=await fixture(t);
 await withPreparationWriter(project,'checks prepare',async()=>{
  let release!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});
  const first=withPreparationWriter(project,'checks outline',async()=>{entered();await held;});await ready;
  try{await assert.rejects(withPreparationWriter(project,'checks repair',async()=>assert.fail('second dispatch')),/nested writer/i);}finally{release();await first;}
 });
});
