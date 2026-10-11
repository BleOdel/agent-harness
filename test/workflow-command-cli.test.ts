import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm, open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { WorkflowEvent } from '../src/workflow/protocol.ts';
async function fixture(t: import('node:test').TestContext) { const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-cli-')); t.after(() => rm(root, { recursive: true, force: true })); await mkdir(root + '/app'); await writeFile(root + '/config', '# fixture\n'); return root; }
async function invoke(root: string, args: string[], redirect = false) {
    const file = redirect ? await open(root + '/output.jsonl', 'w') : undefined;
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HARNESS_') && !['NODE_OPTIONS', 'NODE_TEST_CONTEXT'].includes(k)));
    const child = spawn(process.execPath, [new URL('../src/cli.ts', import.meta.url).pathname, ...args], { env: { ...env, HARNESS_PROJECT: root + '/app', HARNESS_CONFIG: root + '/config' }, stdio: ['pipe', file ? file.fd : 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout?.on('data', x => stdout += x);
    child.stderr!.on('data', x => stderr += x);
    child.stdin!.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    const [code, signal] = await once(child, 'close');
    clearTimeout(timer);
    await file?.close();
    assert.equal(signal, null, 'process must exit without a TTY or hanging');
    if (redirect)
        stdout = await readFile(root + '/output.jsonl', 'utf8');
    return { code, stdout, stderr };
}
function events(stdout: string) { const es = stdout.trim().split('\n').map(s => JSON.parse(s) as WorkflowEvent); assert.equal(es[0]!.type, 'started'); assert.equal(es.at(-1)!.type, 'terminal'); assert.equal(es.filter(e => e.type === 'terminal').length, 1); assert.ok(es.every(e => e.version === 1 && e.invocationId === es[0]!.invocationId)); assert.deepEqual(es.map(e => e.sequence), es.map((_, i) => i + 1)); return es; }
for (const args of [['status', '--json'], ['checks', 'status', '--json'], ['continue', 'status', '--json']])
    test(`${args.join(' ')} runs with closed stdin and redirected output`, async (t) => { const root = await fixture(t); const response = await invoke(root, args, true); assert.equal(response.code, 0, response.stderr); assert.equal(response.stderr, ''); const es = events(response.stdout); assert.equal(es.at(-1)!.data.outcome, 'success'); assert.ok(es.some(e => e.type === 'status')); assert.ok(!es.some(e => e.type === 'dispatch')); });
test('prepare with missing task returns concrete choices over an ordinary pipe and does not dispatch', async (t) => {
    const root = await fixture(t);
    await writeFile(root + '/app/features.json', JSON.stringify([{ id: 'first', title: 'First', priority: 'must', status: 'todo', criteria: ['Print Hello'], dependsOn: [] }, { id: 'second', title: 'Second', priority: 'must', status: 'todo', criteria: ['Print World'], dependsOn: [] }]));
    const response = await invoke(root, ['checks', 'prepare', '--json', '--max-requests', '1']);
    assert.equal(response.code, 3, response.stderr);
    const es = events(response.stdout);
    const decision = es.find(e => e.type === 'decision')!;
    assert.deepEqual((decision.data.choices as {
        label: string;
    }[]).map(c => c.label), ['First (first)', 'Second (second)']);
    assert.ok(!es.some(e => e.type === 'dispatch'));
    await assert.rejects(readFile(root + '/app-harness/acceptance/approved.json'), { code: 'ENOENT' });
});
test('explicit repair reaches saved-state validation without opening a terminal', async (t) => {
    const root = await fixture(t);
    const response = await invoke(root, ['checks', 'repair', 'missing', '--json', '--max-requests', '1']);
    assert.equal(response.code, 3, response.stderr);
    const es = events(response.stdout);
    assert.match(String(es.at(-1)!.data.message), /No saved check review/);
    assert.doesNotMatch(response.stdout, /needs a terminal/);
});
test('plain preparation also exits with closed stdin and a concrete missing-information result', async (t) => {
    const root = await fixture(t);
    const response = await invoke(root, ['checks', 'prepare', '--max-requests', '1']);
    assert.equal(response.code, 3);
    assert.match(response.stdout, /Accept planned work items/);
    assert.doesNotMatch(response.stdout + response.stderr, /needs a terminal/);
});
test('complete continuation succeeds without stdin, a model, or implicit allowance renewal', async (t) => {
    const root = await fixture(t);
    await writeFile(root + '/app/features.json', JSON.stringify([{ id: 'one', title: 'One', status: 'done', priority: 'must', criteria: ['Print Hello'], dependsOn: [] }]));
    const response = await invoke(root, ['continue', 'one', '--json', '--max-builds', '1', '--max-requests', '1']);
    assert.equal(response.code, 0, response.stderr);
    const es = events(response.stdout);
    assert.equal(es.at(-1)!.data.outcome, 'success');
    assert.ok(!es.some(e => e.type === 'dispatch' && e.data.phase));
    const state = JSON.parse(await readFile(root + '/app-harness/continuation.json', 'utf8'));
    assert.equal(state.status, 'complete');
    assert.equal(state.attempts, 0);
    assert.equal(state.maxBuilds, 1);
    const status = await invoke(root, ['continue', 'status', '--json']);
    assert.equal(status.code, 0);
    assert.ok(events(status.stdout).some(e => e.type === 'progress' && String(e.data.text).includes('0/1 build dispatches')));
    assert.deepEqual(JSON.parse(await readFile(root + '/app-harness/continuation.json', 'utf8')),state);
});
test('invalid structured flags still return one parseable terminal result', async (t) => { const root = await fixture(t); const response = await invoke(root, ['status', '--json', '--json']); assert.equal(response.code, 1); const es = events(response.stdout); assert.equal(es.at(-1)!.data.outcome, 'failed'); });
