import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { run } from '../run.ts';
import { sourceFiles } from '../workspace/candidate.ts';

export const smokeTests = ['test/asset-helper-docker.test.ts', 'test/browser-acceptance.test.ts', 'test/browser-capabilities.test.ts', 'test/staged-preview-docker.test.ts'];
const immutable = (v: unknown): v is string => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/u.test(v);
export function assessSmokeTap(output: string, code: number | null, incomplete: boolean) {
  const number = (name: string) => {
    const matches = [...output.matchAll(new RegExp(`^# ${name} (\\d+)\\r?$`, 'gm'))];
    return matches.length === 1 ? Number(matches[0]![1]) : undefined;
  };
  const tests = number('tests'), passed = number('pass'), failed = number('fail'), skipped = number('skipped'), cancelled = number('cancelled'), todo = number('todo');
  const complete = [tests, passed, failed, skipped, cancelled, todo].every(v => v !== undefined);
  return { passed: !incomplete && code === 0 && complete && tests! > 0 && passed === tests && failed === 0 && skipped === 0 && cancelled === 0 && todo === 0,
    counts: { tests, passed, failed, skipped, cancelled, todo } };
}
/** No inherited provider/configuration environment reaches the fixture suite. */
export function smokeEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) if (input[key] !== undefined) result[key] = input[key];
  return result;
}
export async function operationalSmoke(outputDirectory: string, input: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const root = path.resolve(import.meta.dirname, '../..');
  const relative = path.relative(root, path.resolve(outputDirectory));
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) throw Error('Keep qualification output outside the source tree.');
  await mkdir(outputDirectory, { recursive: true });
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'harness-smoke-'));
  const report: Record<string, unknown> = { version: 1, suite: 'operational-smoke-v1', startedAt: new Date().toISOString(), status: 'unavailable', tests: smokeTests, node: process.version };
  try {
    const sourceIdentity = async () => createHash('sha256').update(JSON.stringify(Object.entries(await sourceFiles(root)).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
    report.source = await sourceIdentity();
    const docker = input.HARNESS_DOCKER;
    if (!docker || !immutable(input.HARNESS_IMAGE_ID) || !immutable(input.HARNESS_BROWSER_IMAGE_ID)) throw Error('Set HARNESS_DOCKER and immutable HARNESS_IMAGE_ID / HARNESS_BROWSER_IMAGE_ID. Missing runtime never counts as a passing smoke lane.');
    for (const [key, id] of [['nodeImage', input.HARNESS_IMAGE_ID], ['browserImage', input.HARNESS_BROWSER_IMAGE_ID]] as const) {
      const inspection = await run(docker, ['image', 'inspect', id], { env: smokeEnvironment(input), timeoutMs: 10000, maxOutputBytes: 1024 * 1024 });
      if (inspection.code !== 0 || inspection.timedOut || inspection.outputLimited) throw Error(`Cannot inspect ${key}.`);
      const value = JSON.parse(inspection.stdout)[0];
      if (value?.Id !== id || value?.Os !== 'linux' || !['amd64', 'arm64'].includes(value.Architecture)) throw Error(`Invalid ${key} runtime identity.`);
      report[key] = { id, os: value.Os, arch: value.Architecture };
    }
    for (const dir of ['pi', 'agent', 'project']) await mkdir(path.join(temporary, dir));
    await writeFile(path.join(temporary, 'config'), '# Isolated provider-free smoke configuration\n');
    const env: NodeJS.ProcessEnv = { ...smokeEnvironment(input),
      HARNESS_DOCKER: docker, HARNESS_IMAGE_ID: input.HARNESS_IMAGE_ID, HARNESS_BROWSER_IMAGE_ID: input.HARNESS_BROWSER_IMAGE_ID,
      HARNESS_PROJECT: path.join(temporary, 'project'), HARNESS_CONFIG: path.join(temporary, 'config'), HARNESS_PI_PACKAGE: path.join(temporary, 'pi'), HARNESS_AGENT_DIR: path.join(temporary, 'agent'),
      HARNESS_VERIFY_BROWSER: '1', HARNESS_PROVIDER: 'fixture', HARNESS_MODEL: 'fixture', HARNESS_REASONING_EFFORT: 'medium',
    };
    const execution = await run(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', ...smokeTests.map(file => path.join(root, file))], {
      env, timeoutMs: 10 * 60 * 1000, maxOutputBytes: 4 * 1024 * 1024,
    });
    await writeFile(path.join(outputDirectory, 'tests.tap'), execution.stdout);
    await writeFile(path.join(outputDirectory, 'stderr.txt'), execution.stderr);
    const assessment = assessSmokeTap(execution.stdout, execution.code, execution.timedOut || execution.outputLimited === true);
    const after = await sourceIdentity();
    if (after !== report.source) throw Error('Harness source changed during operational qualification; run it again on a stable candidate.');
    Object.assign(report, { status: assessment.passed ? 'passed' : 'failed', ...assessment, exitCode: execution.code, timedOut: execution.timedOut, outputLimited: execution.outputLimited ?? false });
    return assessment.passed;
  } catch (error) {
    report.problem = (error as Error).message;
    return false;
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(outputDirectory, 'qualification.json'), JSON.stringify(report, null, 2) + '\n');
    await rm(temporary, { recursive: true, force: true });
  }
}
