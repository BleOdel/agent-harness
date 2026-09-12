import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parsePythonLock, pythonEnvironmentKey } from '../src/adapters/python/environment.ts';
import { parsePytestReport } from '../src/adapters/python/tests.ts';
import { pythonScaffold } from '../src/adapters/python/scaffold.ts';
import { getAdapter } from '../src/adapters/registry.ts';
import { defaultProfile, parseProfile } from '../src/project/profile.ts';
const lock = await readFile(new URL('../src/adapters/python/requirements.lock', import.meta.url), 'utf8');
test('Python dependency policy accepts a fully pinned wheel lock and refuses executable/ambiguous inputs', () => {
 assert.equal(parsePythonLock(lock).length, 5);
 for (const line of ['foo', 'foo>=1', 'foo==1', 'foo==1 --hash=md5:123', '-e .', './local', 'foo @ https://example.org/pkg.whl', '--extra-index-url https://example.org', '-r more.txt', 'foo==1; python_version>="3"', 'git+https://example.org/pkg', 'foo[extra]==1']) assert.throws(() => parsePythonLock(lock + line + '\n'), /requirements.lock/);
 assert.throws(() => parsePythonLock(lock + lock), /duplicate/i);
 assert.throws(() => parsePythonLock(lock.replace('pytest==8.3.5', 'pytest==8.3.4')), /tooling/i);
});
test('Python cache key binds every input and the immutable runtime', () => {
 const inputs = { manifest: 'metadata', lock, python: '3.13.12' };
 const base = pythonEnvironmentKey(inputs, 'sha256:a', { python: '3.13.12', pip: '25.3' });
 for (const changed of [{ ...inputs, lock: lock + '# new\n' }, { ...inputs, manifest: 'other' }, { ...inputs, python: '3.13.11' }]) assert.notEqual(pythonEnvironmentKey(changed, 'sha256:a', { python: '3.13.12', pip: '25.3' }), base);
 assert.notEqual(pythonEnvironmentKey(inputs, 'sha256:b', { python: '3.13.12', pip: '25.3' }), base);
});
test('Pytest diagnostic ingestion rejects empty, skipped, failed, incomplete and fabricated duplicate reports', () => {
 const report = { version: 1, collected: ['tests/test_cli.py::test_one'], results: [{ nodeid: 'tests/test_cli.py::test_one', when: 'setup', outcome: 'passed' }, { nodeid: 'tests/test_cli.py::test_one', when: 'call', outcome: 'passed' }, { nodeid: 'tests/test_cli.py::test_one', when: 'teardown', outcome: 'passed' }], exitCode: 0 };
 const output = (value: unknown) => 'HARNESS_PYTEST=' + JSON.stringify(value) + '\n';
 assert.equal(parsePytestReport(output(report), 0, ['tests/test_cli.py']).passed, true);
 for (const value of [{ ...report, collected: [], results: [] }, { ...report, results: report.results.map(r => ({ ...r, outcome: 'skipped' })) }, { ...report, results: [] }, { ...report, exitCode: 1 }, { ...report, results: report.results.map(r => ({ ...r, outcome: 'failed' })) }]) assert.equal(parsePytestReport(output(value), 0, ['tests/test_cli.py']).passed, false);
 assert.equal(parsePytestReport(output(report) + output(report), 0, ['tests/test_cli.py']).passed, false);
 assert.equal(parsePytestReport('HARNESS_PYTEST={', 0, ['tests/test_cli.py']).passed, false);
 assert.equal(parsePytestReport(output(report), 0, ['tests/test_cli.py', 'tests/test_hidden.py']).passed, false);
 assert.equal(parsePytestReport(output(report), 1, ['tests/test_cli.py']).passed, false);
});
test('Python selection has its own toolchain floor and fixed test recipe', async () => {
 await assert.rejects(pythonScaffold('pytest'), /shadow/);
 const profile = defaultProfile('python-pip'); assert.equal(parseProfile(profile).adapter.id, 'python-pip');
 assert.equal(profile.requirements.toolchains.python, 3); assert.equal(profile.requirements.toolchains.npm, undefined);
 const adapter = getAdapter(profile.adapter); assert.deepEqual(adapter.defaultTestCommand, ['python', '-m', 'pytest']);
 await assert.rejects(adapter.recipe('/unused', ['echo', 'passed']), /pytest/);
});
