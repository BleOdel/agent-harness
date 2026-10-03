/** Desired behavior for known audit failures. Run explicitly; failures are never counted as fixes. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { captureBaseline } from '../src/workspace/candidate.ts';
import { validateTorchCheckpoint } from '../src/torch/schema.ts';

const known = { skip: process.env.HARNESS_KNOWN_DEFECTS === '1' ? false : 'Known audit defects: explicit non-qualifying lane, HARNESS_KNOWN_DEFECTS=1' };
test('F06 executable mode changes candidate identity', known, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'audit-mode-'));
  try {
    const project = path.join(root, 'project'); await mkdir(project);
    const file = path.join(project, 'run.sh'); await writeFile(file, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    const before = await captureBaseline(project, path.join(root, 'before'));
    await chmod(file, 0o755);
    const after = await captureBaseline(project, path.join(root, 'after'));
    assert.notEqual(after.digest, before.digest, 'chmod-only source drift must invalidate candidate identity');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('F13 incomplete serialized classifier checkpoint is rejected', known, () => {
  const dict = (keys: string[]) => ({ dict: keys.map(key => [key, null]) });
  const value = { protocol: 'torch-cpu@1', context: 'audit', completed: 1, runtime: '2.14.0+cpu',
    model: dict(['0.weight', '0.bias', '3.weight', '3.bias', '5.weight', '5.bias']),
    optimizer: { dict: [['state', { dict: [] }], ['param_groups', []]] },
    scheduler: dict(['last_epoch', '_step_count']), torchRng: Array(5056).fill(0),
    pythonRng: [3, { tuple: Array(625).fill(null) }, null], permutation: [], cursor: 0, epoch: 1, losses: [1], centers: null };
  assert.throws(() => validateTorchCheckpoint(value, 'audit', 1, 'classifier'), /checkpoint|tensor|optimizer|state/i);
});
