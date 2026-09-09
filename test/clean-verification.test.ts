import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { type SandboxLayout, buildVerificationArguments } from "../src/containment/sandbox.ts";
import { run } from "../src/run.ts";
import { runContained } from "../src/containment/process.ts";
import { captureBaseline, captureCandidate, copySource } from "../src/workspace/candidate.ts";
import { EnvironmentBlocked, installEnvironment, prepareEnvironment } from "../src/workspace/dependencies.ts";
import { runPipeline } from "../src/pipeline.ts";
import { counterPath } from "../src/gates/tests.ts";

const configured = process.env.HARNESS_IMAGE_ID !== undefined && process.env.HARNESS_PI_PACKAGE !== undefined && process.env.HARNESS_AGENT_DIR !== undefined;
const lock = await readFile(new URL('./fixtures/m2-package-lock.json', import.meta.url), 'utf8');
const manifest = { name: 'clean-fixture', version: '1.0.0', type: 'module', dependencies: { 'is-number': '7.0.0' }, scripts: { test: 'node --test test/*.test.js' } };
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'harness-clean-')));
  const project = path.join(root, 'project'); await mkdir(path.join(project, 'test'), { recursive: true });
  await writeFile(path.join(project, 'package.json'), JSON.stringify(manifest));
  await writeFile(path.join(project, 'package-lock.json'), lock);
  await writeFile(path.join(project, 'app.js'), 'export const value = 3;\n');
  await writeFile(path.join(project, 'test/app.test.js'), `import assert from 'node:assert/strict'; import {existsSync} from 'node:fs'; import isNumber from 'is-number'; import {value} from '../app.js'; assert.equal(isNumber(value),true); assert.equal(existsSync('/pi-agent'),false); assert.equal(existsSync('/opt/pi-package'),false);`);
  const config = loadConfig();
  const layout: SandboxLayout = { dockerExecutable: config.dockerExecutable, imageId: config.imageId, containerName: `harness-clean-${process.pid}`, workDirectory: project, agentDirectory: path.join(root, 'credentials-never-mounted'), piPackageDirectory: path.join(root, 'pi-never-mounted'), user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}` };
  return { root, project, config, layout, async close() { await rm(root, { recursive: true, force: true }); } };
}
test('M2 clean verification resists worker dependencies and isolates every verifier', { skip: configured ? false : 'configure Docker to run M2 clean verification' }, async t => {
  await t.test('a timed-out container is removed before its output can be captured', async () => {
    const f = await fixture(); try {
      const result = await runContained(f.layout, buildVerificationArguments(f.layout, 'none', ['node', '-e', "setInterval(()=>require('node:fs').writeFileSync('/work/ticks',String(Date.now())),30)"]), { timeoutMs: 700 });
      assert.equal(result.timedOut, true);
      const inspection = await run(f.layout.dockerExecutable, ['inspect', f.layout.containerName], { timeoutMs: 10000 });
      assert.notEqual(inspection.code, 0, 'timed-out writer remained alive');
      assert.match(inspection.stderr, /no such object/iu);
    } finally {
      await run(f.layout.dockerExecutable, ['rm', '--force', f.layout.containerName], { timeoutMs: 10000 });
      await f.close();
    }
  });
  await t.test('corrupting worker node_modules cannot make a broken candidate pass', async () => {
    const f = await fixture(); try {
      const baseline = await captureBaseline(f.project, path.join(f.root, 'baseline'));
      const worker = path.join(f.root, 'worker'); await copySource(baseline.directory, worker);
      await writeFile(path.join(worker, 'app.js'), "export const value = 'broken';\n");
      await mkdir(path.join(worker, 'node_modules/is-number'), { recursive: true });
      await writeFile(path.join(worker, 'node_modules/is-number/index.js'), 'module.exports=()=>true;');
      const local = { ...f.layout, workDirectory: worker };
      const corrupted = await runContained(local, buildVerificationArguments(local, 'none', ['node', '--test', 'test/app.test.js']), { timeoutMs: 30000 });
      assert.equal(corrupted.code, 0, corrupted.stderr + corrupted.stdout);
      const candidate = await captureCandidate(baseline, worker, path.join(f.root, 'candidate'));
      const proof = await runPipeline({ config: f.config, layout: { ...f.layout, workDirectory: candidate.directory }, project: baseline.directory, testCommand: ['npm', 'test'], counterSource: await readFile(counterPath(), 'utf8'), limits: { maxFiles: 40, maxLines: 4000 }, claim: { ok: true, claim: { files: ['app.js'], deletions: [], criteria: [{ criterion: 'returns a number', verifiedBy: 'test/app.test.js' }] } } });
      assert.equal(proof.run.passed, false); assert.equal(proof.run.firstFailure?.kind, 'tests-failed', proof.run.firstFailure?.detail);
    } finally { await f.close(); }
  });
  await t.test('test-generated source does not affect build or candidate source', async () => {
    const f = await fixture(); try {
      await writeFile(path.join(f.project, 'package.json'), JSON.stringify({ ...manifest, scripts: { ...manifest.scripts, build: 'node check-build.js' } }));
      await writeFile(path.join(f.project, 'check-build.js'), `import {readFileSync,existsSync} from 'node:fs'; if(readFileSync('app.js','utf8')!=='export const value = 3;\\n'||existsSync('leak.js'))process.exit(1);`);
      await writeFile(path.join(f.project, 'test/app.test.js'), `import assert from 'node:assert/strict';import {writeFileSync} from 'node:fs';assert.equal(1,1);writeFileSync('app.js','test mutation');writeFileSync('leak.js','generated');`);
      const baseline = await captureBaseline(f.project, path.join(f.root, 'baseline'));
      const proof = await runPipeline({ config: f.config, layout: f.layout, project: baseline.directory, testCommand: ['npm', 'test'], counterSource: await readFile(counterPath(), 'utf8'), limits: { maxFiles: 40, maxLines: 4000 }, claim: { ok: true, claim: { files: [], deletions: [], criteria: [{ criterion: 'works', verifiedBy: 'test/app.test.js' }] } } });
      assert.equal(proof.run.passed, true, proof.run.firstFailure?.detail);
      assert.deepEqual(proof.changes, []);
      assert.equal(await readFile(path.join(f.project, 'app.js'), 'utf8'), 'export const value = 3;\n');
      await assert.rejects(readFile(path.join(f.project, 'leak.js')), { code: 'ENOENT' });
    } finally { await f.close(); }
  });
  await t.test('manifest-lock mismatch is environment-blocked', async () => {
    const f = await fixture(); try {
      await writeFile(path.join(f.project, 'package.json'), JSON.stringify({ ...manifest, dependencies: { 'is-number': '6.0.0' } }));
      await assert.rejects(prepareEnvironment(f.project, path.join(f.root, 'env'), f.layout, 30000), (e: unknown) => e instanceof EnvironmentBlocked && /in sync|Invalid:|Missing:/u.test(e.message));
    } finally { await f.close(); }
  });
  await t.test('an absent prepared cache cannot fall back to worker dependencies', async () => {
    const f = await fixture(); try {
      const prepared = await prepareEnvironment(f.project, path.join(f.root, 'env'), f.layout, 30000);
      await rm(path.join(prepared.directory, 'cache'), { recursive: true, force: true });
      await mkdir(path.join(prepared.directory, 'cache'));
      const proof = await runPipeline({ config: f.config, layout: f.layout, project: f.project, environment: prepared, testCommand: ['npm', 'test'], counterSource: await readFile(counterPath(), 'utf8'), limits: { maxFiles: 40, maxLines: 4000 } });
      assert.equal(proof.run.firstFailure?.kind, 'environment-blocked');
    } finally { await f.close(); }
  });
  await t.test('allowed installation scripts run offline and source-changing scripts are refused', async () => {
    const f = await fixture(); try {
      await writeFile(path.join(f.project, 'package.json'), JSON.stringify({ ...manifest, scripts: { ...manifest.scripts, postinstall: "node -e \"require('node:fs').writeFileSync('node_modules/installed-marker','yes')\"" } }));
      await assert.rejects(prepareEnvironment(f.project, path.join(f.root, 'deny'), f.layout, 30000), /scripts/u);
      const policy = { scripts: 'allow' as const, flags: [] };
      const prepared = await prepareEnvironment(f.project, path.join(f.root, 'allow'), f.layout, 30000, policy);
      await installEnvironment(f.project, path.join(f.root, 'verify'), prepared, f.layout, 30000);
      assert.equal(await readFile(path.join(f.root, 'verify/node_modules/installed-marker'), 'utf8'), 'yes');
      await writeFile(path.join(f.project, 'package.json'), JSON.stringify({ ...manifest, scripts: { postinstall: "node -e \"require('node:fs').writeFileSync('app.js','tampered')\"" } }));
      await assert.rejects(prepareEnvironment(f.project, path.join(f.root, 'source-mutation'), f.layout, 30000, policy), /changed candidate source/u);
    } finally { await f.close(); }
  });
});
