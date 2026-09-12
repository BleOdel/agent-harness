import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { guide } from '../src/verbs/guide.ts';
import { init } from '../src/verbs/init.ts';
import { setupProject } from '../src/verbs/project.ts';
import { projectTestCommand, readProfile, savedProfile, profilePath } from '../src/project/profile.ts';
import { createRunWorkspace, destroyRunWorkspace } from '../src/workspace/sandbox-lifecycle.ts';
import { createPlan, latestPlanDirectory } from '../src/planning/store.ts';
import { pythonPip } from '../src/adapters/python-pip.ts';
import { buildPlanCommand } from '../src/verbs/plan.ts';
test('Guide creates Python with one choice, carries its test default, saves setup and preserves local environments outside copies', async () => {
 const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'python-guide-'))), project = path.join(root, 'file_analysis'); await mkdir(project);
 const answers = [project, '2', '0'], output: string[] = [], commands: string[][] = [];
 try {
  await guide(project, { ask: async () => answers.shift()!, write: line => output.push(line) }, async (_project, args) => { commands.push([...args]); await init(project, args.slice(1)); return 0; });
  assert.deepEqual(commands, [['init', '--python']]); assert.match(output.join('\n'), /python-pip@1/);
  assert.equal((await readProfile(project)).adapter.id, 'python-pip'); assert.deepEqual(await projectTestCommand(project), ['python', '-m', 'pytest']);
  const configuration = ['1', 'none', 'none', 'y'];
  await setupProject(project, { ask: async (prompt: string) => prompt.startsWith('Save') ? 'y' : prompt.includes('skills') ? 'none' : configuration.shift()!, write: line => output.push(line) });
  assert.equal((await savedProfile(project))?.adapter.id, 'python-pip'); assert.match(output.join('\n'), /Python needs a runner image/);
  await assert.rejects(init(project, ['--python']), /already has/);
  for (const directory of ['.venv', '.pytest_cache', '.harness-python']) { await mkdir(path.join(project, directory)); await writeFile(path.join(project, directory, 'local.txt'), 'local only'); }
  const work = await createRunWorkspace(project, pythonPip.source.generatedDirectories);
  try { for (const directory of ['.venv', '.pytest_cache', '.harness-python']) await assert.rejects(readFile(path.join(work.baseline.directory, directory, 'local.txt')), { code: 'ENOENT' }); } finally { await destroyRunWorkspace(work); }
  const plan = await createPlan(project, 'File analysis');
  for (const directory of ['.venv', '.pytest_cache', '.harness-python']) await assert.rejects(readFile(path.join(plan.work, directory, 'local.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(project, '.venv/local.txt'), 'utf8'), 'local only');
  await writeFile(profilePath(project), JSON.stringify({ ...(await savedProfile(project)), adapter: { id: 'unsupported', version: 1 } }));
  await assert.rejects(createPlan(project, 'Invalid environment'), /Unsupported adapter/);
  assert.equal(await latestPlanDirectory(project), plan.directory, 'Failed selection must not hide the prior plan');
 } finally { await rm(root, { recursive: true, force: true }); }
});
test('Python planning carries its adapter policy through interview and automatic item generation', () => {
 for (const phase of ['draft', 'items'] as const) {
  const command = buildPlanCommand({ topic: 'File analysis', skills: ['grill-me'], skillsConfigured: true, provider: undefined, model: undefined, phase, adapter: 'python-pip' });
  assert.match(command.at(-1)!, /Python/); assert.match(command.at(-1)!, /requirements.lock/); assert.match(command.at(-1)!, /shared-inputs/);
 }
});
