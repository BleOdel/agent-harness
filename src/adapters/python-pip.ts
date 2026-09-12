import type { ProjectAdapter, VerificationRecipe } from './contract.ts';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { sourceFiles } from "../workspace/candidate.ts";
import { failed, passed } from '../gates/gate.ts';
import { EnvironmentBlocked } from '../workspace/dependencies.ts';
import { installPython, preparePython, pythonEnvironmentKey, pythonInputs, pythonRun, pythonRuntime, PYTHON_ENV, PYTHON_EXCLUSIONS } from './python/environment.ts';
import { testPython } from './python/tests.ts';
const command = ['python', '-m', 'pytest'];
function assertRecipe(recipe: VerificationRecipe): void {
 if (recipe.version !== 1 || recipe.adapter.id !== 'python-pip' || recipe.adapter.version !== 1 || JSON.stringify(recipe.testCommand) !== JSON.stringify(command) || recipe.scripts !== undefined) throw new EnvironmentBlocked('python-pip@1 requires the fixed python -m pytest recipe; custom test commands and selectors are unsupported.');
}
export const pythonPip: ProjectAdapter = {
 reference: { id: 'python-pip', version: 1 }, markers: ['pyproject.toml', 'requirements.lock', '.python-version'], defaultTestCommand: command,
 source: { generatedDirectories: PYTHON_EXCLUSIONS, sharedInputs: ['pyproject.toml', 'requirements.lock', '.python-version'] },
 artifacts: ['dist/*.whl'], executionEnvironment: PYTHON_ENV,
 runtime: pythonRuntime, prepare: preparePython, install: installPython,
 async matches(environment, source, layout) { return environment.key === pythonEnvironmentKey(await pythonInputs(source), layout.imageId, environment.runtime); },
 async recipe(_source, selected) { const recipe: VerificationRecipe = { version: 1, adapter: this.reference, testCommand: [...selected] }; assertRecipe(recipe); await pythonInputs(_source); return recipe; },
 async pin(_work, recipe) { assertRecipe(recipe); },
 async checks(_source, recipe, _counter, timeoutMs) {
  assertRecipe(recipe);
  return [
   { name: 'tests', applies: true, check: layout => testPython(layout, timeoutMs) },
   { name: 'build', applies: true, async check(layout) {
    const fingerprint = async () => JSON.stringify(await sourceFiles(layout.workDirectory, '', PYTHON_EXCLUSIONS));
    const sourceBefore = await fingerprint();
    const result = await pythonRun(layout, layout.workDirectory, ['/work/.venv/bin/python', '-I', '/harness-instrumentation/package.py', 'build'], timeoutMs);
    if (result.code !== 0 || result.timedOut || result.outputLimited) return failed(result.timedOut ? 'timed-out' : 'build-not-reproducible', 'Python wheel build failed', result.stderr + result.stdout);
    const wheel = JSON.parse(result.stdout.split('\n').find(l => l.startsWith('HARNESS_WHEEL='))?.slice('HARNESS_WHEEL='.length) ?? 'null');
    if (!wheel || !/^[A-Za-z0-9_.+-]+\.whl$/u.test(wheel.file)) return failed('build-not-reproducible', 'Python wheel report missing or invalid');
    const before = await readFile(path.join(layout.workDirectory, 'dist', wheel.file));
    await rm(path.join(layout.workDirectory, 'dist'), { recursive: true, force: true });
    const again = await pythonRun(layout, layout.workDirectory, ['/work/.venv/bin/python', '-I', '/harness-instrumentation/package.py', 'build'], timeoutMs);
    const after = await readFile(path.join(layout.workDirectory, 'dist', wheel.file)).catch(() => Buffer.alloc(0));
    if (again.code !== 0 || again.timedOut || again.outputLimited || sourceBefore !== await fingerprint() || !before.equals(after)) return failed('build-not-reproducible', 'Python wheel build is not reproducible', again.stdout + again.stderr);
    return passed('build: repeated pure-Python wheels match; installed package tested offline; output retention is not yet supported');
   } },
  ];
 },
 test(layout, selected, _counter, timeoutMs) { if (layout.checksDirectory) throw new EnvironmentBlocked("Python team contract suites are not supported yet. Use operator-approved acceptance cases to check application behaviour."); assertRecipe({ version: 1, adapter: this.reference, testCommand: [...selected] }); return testPython(layout, timeoutMs); },
};
