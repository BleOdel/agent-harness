import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assessSmokeTap, smokeEnvironment, operationalSmoke } from '../src/reliability/smoke.ts';
const good = '# tests 2\n# pass 2\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n';
test('operational qualification refuses missing runtime, incomplete output and required skips', async () => {
  assert.equal(assessSmokeTap(good, 0, false).passed, true);
  for (const bad of ['', good.replace('# skipped 0', '# skipped 1'), good.replace('# pass 2', '# pass 1'), good.replace('# fail 0', '# fail 1'), good + good, good.replace('# tests 2', '# tests 0')]) assert.equal(assessSmokeTap(bad, 0, false).passed, false);
  assert.equal(assessSmokeTap(good, 1, false).passed, false);
  assert.equal(assessSmokeTap(good, 0, true).passed, false);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'smoke-unavailable-'));
  try {
    assert.equal(await operationalSmoke(dir, {}), false);
    const report = JSON.parse(await readFile(path.join(dir, 'qualification.json'), 'utf8'));
    assert.equal(report.status, 'unavailable'); assert.match(report.problem, /immutable/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('smoke environment never inherits provider secrets or a real harness project', () => {
  assert.deepEqual(smokeEnvironment({ PATH: '/bin', HOME: '/fixture', OPENAI_API_KEY: 'synthetic', HARNESS_PROJECT: '/real', HARNESS_CONFIG: '/real-config', HARNESS_VERIFY_NATIVE: '1', NODE_OPTIONS: '--require bad.js' }), { PATH: '/bin', HOME: '/fixture' });
});
