/** Run project diagnostics without a builder, provider call or source application. */
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getAdapter } from '../adapters/registry.ts';
import { loadConfig, setting } from '../config.ts';
import { counterPath } from '../gates/tests.ts';
import { executionLayout, inspectCapabilities } from '../project/execution.ts';
import { projectTestCommand, readProfile } from '../project/profile.ts';
import { assertSnapshot, captureBaseline } from '../workspace/candidate.ts';
import { withWriter } from '../workspace/writer-lock.ts';
import { OperatorError, say } from './io.ts';
export async function verify(project: string, args: readonly string[] = []): Promise<void> {
 if (args.length) throw new OperatorError('Use: harness verify');
 return withWriter(project, 'verify', async () => {
  const config = loadConfig({ ...process.env, HARNESS_PROJECT: project }), profile = await readProfile(project), adapter = getAdapter(profile.adapter);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'harness-local-verification-')));
  try {
   await inspectCapabilities(profile, config);
   const source = await captureBaseline(project, path.join(root, 'source'), adapter.source.generatedDirectories);
   const layout = { ...executionLayout(config, source.directory, `harness-verify-${process.pid}`), ...(adapter.executionEnvironment ? { environment: adapter.executionEnvironment } : {}) };
   say(`Preparing ${adapter.reference.id}@${adapter.reference.version}; tests and packaging run in fresh offline containers.`);
   const environment = await adapter.prepare(source.directory, path.join(root, 'environment'), layout, config.gateTimeoutMs, config.installPolicy);
   const recipe = await adapter.recipe(source.directory, await projectTestCommand(project, setting(process.env, 'HARNESS_TEST_COMMAND')));
   const checks = await adapter.checks(source.directory, recipe, await readFile(counterPath(), 'utf8'), config.gateTimeoutMs);
   for (const [index, check] of checks.entries()) {
    if (!check.applies) { say(`${check.name}: not applicable`); continue; }
    const work = path.join(root, `check-${index}`);
    await adapter.install(source.directory, work, environment, layout, config.gateTimeoutMs); await adapter.pin(work, recipe);
    const verdict = await check.check({ ...layout, workDirectory: work }); say(verdict.summary);
    if (!verdict.passed) throw new OperatorError(verdict.summary, verdict.detail);
    await assertSnapshot(source);
   }
   say('Project diagnostics passed. No changes applied; builds still require approved acceptance checks.');
  } finally { await rm(root, { recursive: true, force: true }); }
 });
}
