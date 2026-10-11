/** The public CLI crosses the real runner boundary with local deterministic Pi replies. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { installFixtureCatalog } from './model-fixture.ts';
import { run } from '../src/run.ts';
const configured = !!process.env.HARNESS_DOCKER && !!process.env.HARNESS_IMAGE_ID;
test('Docker: public noninteractive prepare emits ordered provider and allowance outcomes without approving', { skip: configured ? false : 'configure Docker for noninteractive command qualification' }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-cli-docker-')), project = root + '/app', pi = root + '/pi', agent = root + '/agent';
    try {
        for (const d of [project, pi + '/dist', agent])
            await mkdir(d, { recursive: true });
        await installFixtureCatalog(pi);
        await writeFile(agent + '/auth.json', '{}');
        await writeFile(root + '/config', '# isolated fixture');
        await writeFile(project + '/features.json', JSON.stringify([{ id: 'one', title: 'One', priority: 'must', status: 'todo', dependsOn: [], criteria: ['node app.js prints Hello followed by a newline.'] }]));
        await writeFile(project + '/package.json', '{"type":"module"}');
        await writeFile(project + '/app.js', 'console.log("Hello");');
        const env: NodeJS.ProcessEnv = { ...process.env, HARNESS_CONFIG: root + '/config', HARNESS_PROJECT: project, HARNESS_PI_PACKAGE: pi, HARNESS_AGENT_DIR: agent, HARNESS_PROVIDER: 'fixture', HARNESS_MODEL: 'fixture', HARNESS_REASONING_EFFORT: 'medium', HARNESS_AGENT_TIMEOUT: '30' };
        delete env.NODE_TEST_CONTEXT;
        const invoke = () => run(process.execPath, [new URL('../src/cli.ts', import.meta.url).pathname, 'checks', 'prepare', 'one', '--json', '--max-requests', '1', '--max-seconds', '60', '--request-seconds', '30'], { env, timeoutMs: 90000 });
        await writeFile(pi + '/dist/cli.js', `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'fixture auth expired'}}));process.exit(1);`);
        const failed = await invoke();
        assert.equal(failed.code, 5, failed.stderr + '\n' + failed.stdout);
        assert.equal(failed.timedOut, false);
        let es = failed.stdout.trim().split('\n').map(s => JSON.parse(s));
        assert.equal(es.at(-1).data.outcome, 'provider_failure');
        assert.ok(es.some(e => e.type === 'allowance' && e.data.requestsReserved === 1));
        assert.ok(es.some(e => e.type === 'usage' && e.data.complete === false));
        await writeFile(pi + '/dist/cli.js', `const text=JSON.stringify({version:1,additions:'node app.js prints Hello followed by a newline.'});const message={role:'assistant',content:[{type:'text',text}],usage:{totalTokens:10,cost:{total:0.001}}};for(const type of ['message_end','turn_end'])console.log(JSON.stringify({type,message}));console.log(JSON.stringify({type:'agent_end',messages:[message]}));`);
        const paused = await invoke();
        assert.equal(paused.code, 2, paused.stderr + '\n' + paused.stdout);
        es = paused.stdout.trim().split('\n').map(s => JSON.parse(s));
        assert.equal(es[0].type, 'started');
        assert.equal(es.at(-1).data.outcome, 'paused_allowance');
        assert.deepEqual(es.map(e => e.sequence), es.map((_, i) => i + 1));
        assert.equal(es.filter(e => e.type === 'terminal').length, 1);
        assert.ok(es.some(e => e.type === 'usage' && e.data.reportedTokens === 10));
        const state = JSON.parse(await readFile(project + '-harness/acceptance/workflow.json', 'utf8'));
        assert.deepEqual(state.runs.map((r: {
            spend: {
                requests: number;
            };
        }) => r.spend.requests), [1, 1]);
        assert.equal(await readFile(project + '/app.js', 'utf8'), 'console.log("Hello");');
        await assert.rejects(readFile(project + '-harness/acceptance/approved.json'), { code: 'ENOENT' });
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
