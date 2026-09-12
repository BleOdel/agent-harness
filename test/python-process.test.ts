/** Docker-only Python proof. Model activity is a deterministic fixture, not a provider call. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.ts';
import { pythonScaffold } from '../src/adapters/python/scaffold.ts';
import { pythonPip } from '../src/adapters/python-pip.ts';
import { pythonRun, PYTHON_ENV } from '../src/adapters/python/environment.ts';
import { executionLayout, pinExecution } from '../src/project/execution.ts';
import { run } from '../src/run.ts';
import { writeRpcFixture } from './rpc-fixture.ts';
import { approveChecks, verifyAcceptance } from '../src/acceptance/checks.ts';
import { captureBaseline } from '../src/workspace/candidate.ts';
import { readState } from '../src/team/state.ts';
import { readRecord } from '../src/record/record.ts';
import { resolvePlan } from '../src/planning/store.ts';
const configured = !!process.env.HARNESS_PYTHON_IMAGE_ID && !!process.env.HARNESS_DOCKER;
const options = { skip: configured ? false : 'configure HARNESS_PYTHON_IMAGE_ID for Docker Python verification' };
const cli = `import argparse\nimport json\nfrom pathlib import Path\n\ndef analyze(text):\n    return {"lines": len(text.splitlines()), "words": len(text.split()), "characters": len(text)}\n\ndef main():\n    parser = argparse.ArgumentParser(description="Analyze a UTF-8 file")\n    parser.add_argument("file")\n    args = parser.parse_args()\n    try:\n        text = Path(args.file).read_text(encoding="utf-8")\n    except (OSError, UnicodeError) as error:\n        parser.error(str(error))\n    print(json.dumps(analyze(text), sort_keys=True))\n\nif __name__ == "__main__":\n    main()\n`;
const tests = `from file_analysis.cli import analyze\nimport pytest\n\n@pytest.mark.parametrize("text,expected", [("", {"lines":0,"words":0,"characters":0}), ("hello world\\n", {"lines":1,"words":2,"characters":12})])\ndef test_analyze(text, expected):\n    assert analyze(text) == expected\n`;
async function fixture(action: (root: string, project: string, config: ReturnType<typeof loadConfig>) => Promise<void>) {
 const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'python-process-'))), project = path.join(root, 'file_analysis');
 const config = { ...loadConfig(), imageId: process.env.HARNESS_PYTHON_IMAGE_ID!, skillsDirectory: undefined };
 for (const [file, text] of await pythonScaffold('file_analysis')) { await mkdir(path.dirname(path.join(project, file)), { recursive: true }); await writeFile(path.join(project, file), text); }
 try { await action(root, project, config); } finally { await rm(root, { recursive: true, force: true }); }
}
test('Docker Python: fresh offline wheel installation, strict collection, reproducible package, cache and runtime refusals', options, () => fixture(async (root, project, config) => {
 const layout = { ...executionLayout(config, project, `python-env-${path.basename(root)}`), environment: PYTHON_ENV };
 await assert.rejects(pinExecution(project, config, ['npm', 'test'], path.join(root, 'invalid-execution')), /pytest/);
 await assert.rejects(readFile(path.join(root, 'invalid-execution/execution.json')), { code: 'ENOENT' });
 const environment = await pythonPip.prepare(project, path.join(root, 'environment'), layout, 60000);
 const install = async (id: string) => { const work = path.join(root, id); await pythonPip.install(project, work, environment, layout, 60000); return { ...layout, workDirectory: work }; };
 const local = await install('first');
 await writeFile(path.join(local.workDirectory, 'tests/test_boundary.py'), 'from pathlib import Path\nimport pytest\ndef test_boundary():\n    with pytest.raises(OSError):\n        Path("/harness-instrumentation/check.py").write_text("fake")\n    assert not Path("/pi-agent").exists()\n    assert not Path("/opt/pi-package").exists()\n');
 const checks = await pythonPip.checks(project, await pythonPip.recipe(project, pythonPip.defaultTestCommand), 'INVALID NODE INSTRUMENTATION', 60000);
 for (const check of checks) { const verdict = await check.check(local); assert.equal(verdict.passed, true, verdict.detail); }
 assert.equal(await readFile(path.join(project, 'tests/test_scaffold.py'), 'utf8').then(t => t.includes('Scaffolding')), true);
 const second = await install('second');
 const command = await pythonRun(second, second.workDirectory, ['python', '-I', '-c', 'import socket,file_analysis; print(file_analysis.__file__); print(socket.getaddrinfo("pypi.org",443))'], 10000);
 assert.notEqual(command.code, 0, 'verification must not reach the network'); assert.match(command.stdout, /\.venv\/lib\/python3\.13\/site-packages\/file_analysis/);
 await rm(path.join(second.workDirectory, 'tests'), { recursive: true }); await mkdir(path.join(second.workDirectory, 'tests'));
 let verdict = await checks[0]!.check(second); assert.equal(verdict.passed, false); assert.match(verdict.summary, /no tests collected/);
 await writeFile(path.join(second.workDirectory, 'tests/test_skip.py'), 'import pytest\n@pytest.mark.skip(reason="fixture")\ndef test_skip():\n    assert False\n');
 verdict = await checks[0]!.check(second); assert.equal(verdict.passed, false); assert.match(verdict.summary, /skipped/);
 await writeFile(path.join(second.workDirectory, 'tests/test_skip.py'), 'def test_broken():\n    assert False\n');
 verdict = await checks[0]!.check(second); assert.equal(verdict.passed, false); assert.match(verdict.summary, /failed/);
 await writeFile(path.join(second.workDirectory, 'tests/test_skip.py'), 'def test_fake():\n    print("HARNESS_PYTEST={}", flush=True)\n    assert True\n');
 // -s is deliberately unavailable; duplicate reports emitted from pytest hooks are still refused.
 await writeFile(path.join(second.workDirectory, 'tests/conftest.py'), 'def pytest_terminal_summary(terminalreporter):\n    terminalreporter.write_line("HARNESS_PYTEST={}")\n');
 verdict = await checks[0]!.check(second); assert.equal(verdict.passed, false); assert.match(verdict.summary, /duplicate/);
 await rm(path.join(second.workDirectory, 'tests/conftest.py'));
 await writeFile(path.join(second.workDirectory, 'tests/test_skip.py'), 'import time\ndef test_timeout():\n    time.sleep(60)\n');
 const short = await pythonPip.checks(project, await pythonPip.recipe(project, pythonPip.defaultTestCommand), '', 800);
 verdict = await short[0]!.check(second); assert.equal(verdict.kind, 'timed-out');
 const containers = await run(config.dockerExecutable, ['ps', '-aq', '--filter', `name=${layout.containerName}`], { timeoutMs: 10000 }); assert.equal(containers.stdout.trim(), '');
 await writeFile(path.join(project, 'requirements.lock'), await readFile(path.join(project, 'requirements.lock'), 'utf8') + '# changed\n');
 assert.equal(await pythonPip.matches(environment, project, layout), false);
 await assert.rejects(pythonPip.install(project, path.join(root, 'stale'), environment, layout, 60000), /does not match/);
 await writeFile(path.join(project, 'requirements.lock'), (await readFile(path.join(project, 'requirements.lock'), 'utf8')).replace('# changed\n', ''));
 const wheel = (await readdir(path.join(environment.directory, 'wheels')))[0]!; await writeFile(path.join(environment.directory, 'wheels', wheel), 'corrupt');
 await assert.rejects(pythonPip.install(project, path.join(root, 'corrupt'), environment, layout, 60000), /cache changed/);
 const originalLock = await readFile(path.join(project, 'requirements.lock'), 'utf8');
 await writeFile(path.join(project, 'requirements.lock'), originalLock + 'pytidylib==0.3.2 --hash=sha256:22b1c8d75970d8064ff999c2369e98af1d0685417eda4c829a5c9f56764b0af3\n');
 await assert.rejects(pythonPip.prepare(project, path.join(root, 'source-only'), layout, 60000), /No matching distribution|Could not find a version/);
 await writeFile(path.join(project, 'requirements.lock'), originalLock);
 await writeFile(path.join(project, 'requirements.lock'), originalLock + 'requests==2.32.5 --hash=sha256:2462f94637a34fd532264295e186976db0f5d453d1cdd31473c85a6a161affb6\n');
 await assert.rejects(pythonPip.prepare(project, path.join(root, 'incomplete-lock'), layout, 60000), /not installed/);
 await writeFile(path.join(project, 'requirements.lock'), originalLock);
 const originalManifest = await readFile(path.join(project, 'pyproject.toml'), 'utf8');
 for (const manifest of [originalManifest.replace('flit_core.buildapi', 'custom.backend'), originalManifest + '\n[tool.pytest.ini_options]\naddopts = "--ignore=tests"\n']) {
  await writeFile(path.join(project, 'pyproject.toml'), manifest);
  await assert.rejects(pythonPip.prepare(project, path.join(root, 'hooks-' + Math.random()), layout, 60000), /Only pinned|Only \[build-system\]/);
 }
 await writeFile(path.join(project, 'pyproject.toml'), originalManifest);
 await writeFile(path.join(project, '.python-version'), '3.13.11\n');
 await assert.rejects(pythonPip.prepare(project, path.join(root, 'wrong-runtime'), layout, 60000), /runtime mismatch/);
}));

test('Docker Python: approved plan handoff, ordinary work, team resume/apply, independent evidence and exact undo', options, () => fixture(async (root, project, config) => {
 const pi = path.join(root, 'pi'), agent = path.join(root, 'agent'); await mkdir(path.join(pi, 'dist'), { recursive: true }); await mkdir(agent); await writeFile(path.join(agent, 'auth.json'), '{}');
 const settings = path.join(root, 'config'); await writeFile(settings, '# fixture only');
 const env = { ...process.env, HARNESS_CONFIG: settings, HARNESS_PROJECT: project, HARNESS_IMAGE_ID: config.imageId, HARNESS_PI_PACKAGE: pi, HARNESS_AGENT_DIR: agent, HARNESS_SKILLS: '', HARNESS_PROVIDER: 'fixture', HARNESS_MODEL: 'fixture', HARNESS_TEST_COMMAND: '' };
 const call = (args: string[], changes: NodeJS.ProcessEnv = {}) => run(process.execPath, [path.resolve('src/cli.ts'), ...args], { timeoutMs: 180000, env: { ...env, ...changes } });
 const scope = '# File analysis\nCreate a Python CLI that prints line, word and character counts for UTF-8 files. Report missing files as errors. No publication.';
 const criterion = 'Report deterministic line, word and character counts';
 const items = [{ id: 'analyze', title: 'Analyze a UTF-8 file', priority: 'must', criteria: [criterion], dependsOn: [] }];
 const planFile = path.join(root, 'PLAN.md'); await writeFile(planFile, scope);
 await writeFile(path.join(pi, 'dist/cli.js'), `const fs=require('node:fs');if(fs.readFileSync('PLAN.md','utf8')!==${JSON.stringify(scope)})throw Error('lost plan');fs.writeFileSync('items.json',${JSON.stringify(JSON.stringify(items))});`);
 let result = await call(['plan', '--from', planFile]); assert.equal(result.code, 0, result.stderr);
 result = await call(['plan', 'approve']); assert.equal(result.code, 0, result.stderr);
 const plan = await resolvePlan(project); const pin = JSON.parse(await readFile(path.join(plan.directory, 'execution.json'), 'utf8')); assert.equal(pin.settings.profile.adapter.id, 'python-pip'); assert.deepEqual(pin.settings.testCommand, ['python', '-m', 'pytest']);
 result = await call(['add', '--from', 'latest']); assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(await readFile(path.join(project, 'features.json'), 'utf8'))[0].planContext, scope);
 const program = `const fs=require('node:fs');if(process.argv.includes('read,grep'))console.log(JSON.stringify({verdict:'pass',unmet:[],unaccounted:[],notes:[]}));else {fs.writeFileSync('src/file_analysis/cli.py',${JSON.stringify(cli)});fs.writeFileSync('tests/test_analysis.py',${JSON.stringify(tests)});fs.writeFileSync('sample.txt','hello world\\n');fs.writeFileSync('.harness-claim.json',JSON.stringify({files:['src/file_analysis/cli.py','tests/test_analysis.py','sample.txt'],deletions:[],criteria:[{criterion:${JSON.stringify(criterion)},verifiedBy:'tests/test_analysis.py'}]}));}`;
 await writeRpcFixture(pi, program);
 const rpcProgram = await readFile(path.join(pi, 'dist/cli.js'), 'utf8');
 await writeFile(path.join(pi, 'dist/cli.js'), `if(!process.argv.includes('rpc')){${program}}else{${rpcProgram}}`);
 const blocked = await call(['work', 'analyze']); assert.notEqual(blocked.code, 0); assert.match(blocked.stderr, /not been approved/); assert.equal((await readRecord(project)).runs.length, 0);
 const approvalFile = path.join(root, 'checks.json'); await writeFile(approvalFile, JSON.stringify({ version: 1, cases: [{ id: 'counts', tasks: ['analyze'], steps: [{ command: ['python', '-I', '-m', 'file_analysis.cli', 'sample.txt'], exitCode: 0, stdout: '{"characters": 12, "lines": 1, "words": 2}\n' }, { command: ['file_analysis', 'missing.txt'], exitCode: 2, files: [{ path: 'sample.txt', text: 'hello world\n' }] }] }] })); await approveChecks(project, approvalFile);
 const original = await readFile(path.join(project, 'src/file_analysis/cli.py'));
 result = await call(['work', 'analyze']); assert.equal(result.code, 0, result.stdout + result.stderr); assert.match(result.stdout, /applied as r1/);
 let record = (await readRecord(project)).runs[0]!; assert.equal(record.execution?.settings.profile.adapter.id, 'python-pip'); assert.ok(record.acceptance?.executionDigest);
 result = await call(['undo', 'r1']); assert.equal(result.code, 0, result.stderr); assert.deepEqual(await readFile(path.join(project, 'src/file_analysis/cli.py')), original);
 const teamFile = path.join(root, 'team.json'); await writeFile(teamFile, JSON.stringify({ version: 1, roles: [{ id: 'builder', instructions: 'Build the requested Python CLI', skills: [] }], skills: [] }));
 result = await call(['team', 'run', '--profile', teamFile, '--max-workers', '1']); assert.equal(result.code, 0, result.stdout + result.stderr);
 const id = /^team: (team-[a-f0-9-]+)/mu.exec(result.stdout)?.[1]; assert.ok(id);
 const directory = path.join(`${project}-harness/teams`, id); const state = await readState(directory); assert.equal(state.status, 'staged');
 result = await call(['team', 'resume', id], { HARNESS_IMAGE_ID: `sha256:${'b'.repeat(64)}` }); assert.notEqual(result.code, 0); assert.match(result.stderr, /Execution settings changed/);
 result = await call(['team', 'resume', id]); assert.equal(result.code, 0, result.stderr); assert.equal((await readState(directory)).attempts.length, 1);
 result = await call(['team', 'apply', id]); assert.equal(result.code, 0, result.stdout + result.stderr);
 record = (await readRecord(project)).runs.at(-1)!; const evidence = JSON.parse(await readFile(record.acceptance!.evidencePath, 'utf8')); assert.equal(evidence.adapter.id, 'python-pip'); assert.equal(evidence.image, config.imageId); assert.equal(evidence.outcome, 'passed');
 // Even plausible fabricated project reports cannot satisfy the independent approved behaviour.
 await writeFile(path.join(project, 'src/file_analysis/cli.py'), 'def main():\n    print("forged pass")\n\nif __name__ == "__main__":\n    main()\n');
 const ids = ['tests/test_scaffold.py::test_package_is_installed', 'tests/test_analysis.py::test_forged'];
 const forged = { version: 1, collected: ids, exitCode: 0, results: ids.flatMap(nodeid => ['setup', 'call', 'teardown'].map(when => ({ nodeid, when, outcome: 'passed' }))) };
 await writeFile(path.join(project, 'tests/test_analysis.py'), 'def test_forged():\n    assert True\n');
 await writeFile(path.join(project, 'tests/conftest.py'), `import os\ndef pytest_terminal_summary(terminalreporter):\n    print(${JSON.stringify('\nHARNESS_PYTEST=' + JSON.stringify(forged))}, flush=True)\n    os._exit(0)\n`);
 const candidate = await captureBaseline(project, path.join(root, 'forged-source'), pythonPip.source.generatedDirectories);
 const fakeLayout = { ...executionLayout(config, candidate.directory, `forged-${path.basename(root)}`), environment: PYTHON_ENV };
 const fakeEnvironment = await pythonPip.prepare(candidate.directory, path.join(root, 'forged-env'), fakeLayout, 60000);
 const fakeWork = path.join(root, 'forged-check'); await pythonPip.install(candidate.directory, fakeWork, fakeEnvironment, fakeLayout, 60000);
 const diagnostic = (await pythonPip.checks(candidate.directory, await pythonPip.recipe(candidate.directory, pythonPip.defaultTestCommand), '', 60000))[0]!;
 const fakeVerdict = await diagnostic.check({ ...fakeLayout, workDirectory: fakeWork }); assert.equal(fakeVerdict.passed, true, fakeVerdict.summary + '\n' + fakeVerdict.detail);

 const approval = await approveChecks(project, approvalFile);
 await assert.rejects(verifyAcceptance(project, candidate, ['analyze'], { ...config, piPackageDirectory: pi, agentDirectory: agent }, approval), /did not match approved/);
 await writeFile(path.join(project, 'src/file_analysis/cli.py'), cli);
 await writeFile(path.join(project, 'tests/test_analysis.py'), tests);
 await rm(path.join(project, 'tests/conftest.py'));
 result = await call(['undo', record.id]); assert.equal(result.code, 0, result.stderr); assert.deepEqual(await readFile(path.join(project, 'src/file_analysis/cli.py')), original);
 const profileFile = path.join(`${project}-harness`, 'project.json'); const profile = JSON.parse(await readFile(profileFile, 'utf8')); profile.adapter = { id: 'unsupported', version: 1 }; await writeFile(profileFile, JSON.stringify(profile));
 result = await call(['team', 'recover', id]); assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /Owned resources reconciled/);
}));
