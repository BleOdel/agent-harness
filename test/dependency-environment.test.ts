import assert from "node:assert/strict";
import test from "node:test";
import { dependencyInputs, environmentKey } from "../src/workspace/dependencies.ts";
const pkg = JSON.stringify({ name: 'fixture', dependencies: { x: '1.0.0' } });
const lock = JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { x: '1.0.0' } }, 'node_modules/x': { version: '1.0.0', resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz', integrity: 'sha512-test' } } });
test('dependencies need a lock and unsupported workspaces or scripts fail closed', () => {
  assert.throws(() => dependencyInputs(pkg, undefined, { scripts: 'deny', flags: [] }), /lock/u);
  assert.throws(() => dependencyInputs(JSON.stringify({ workspaces: ['packages/*'] }), lock, { scripts: 'deny', flags: [] }), /workspaces/u);
  const scriptLock = lock.replace('"version":"1.0.0"', '"hasInstallScript":true,"version":"1.0.0"');
  assert.throws(() => dependencyInputs(pkg, scriptLock, { scripts: 'deny', flags: [] }), /scripts/u);
  assert.equal(dependencyInputs(pkg, scriptLock, { scripts: 'allow', flags: [] }).install, true);
  assert.throws(() => dependencyInputs(pkg, lock, { scripts: 'deny', flags: ['--prefix=/outside'] }), /flag/u);
});
test('environment identity includes manifests, image, runtime, installation flags and scripts policy', () => {
  const base = { manifest: pkg, lock, image: 'sha256:a', runtime: { node: '26', npm: '11', platform: 'linux', arch: 'arm64' }, policy: { scripts: 'deny' as const, flags: [] } };
  const key = environmentKey(base);
  for (const change of [{ manifest: pkg + ' ' }, { lock: lock + ' ' }, { image: 'sha256:b' }, { runtime: { ...base.runtime, npm: '12' } }, { runtime: { ...base.runtime, arch: 'x64' } }, { policy: { scripts: 'allow' as const, flags: [] } }, { policy: { scripts: 'deny' as const, flags: ['--legacy-peer-deps'] } }]) assert.notEqual(environmentKey({ ...base, ...change }), key);
});

test('unpacked dependency scripts cannot hide behind missing lockfile metadata', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const os = await import('node:os'); const path = await import('node:path');
  const { assertScriptPolicy } = await import('../src/workspace/dependencies.ts');
  const root = await mkdtemp(path.join(os.tmpdir(), 'harness-install-policy-'));
  try {
    await mkdir(path.join(root, 'node_modules/unflagged'), { recursive: true });
    await writeFile(path.join(root, 'node_modules/unflagged/package.json'), JSON.stringify({ name: 'unflagged', scripts: { postinstall: 'node setup.js' } }));
    await assert.rejects(assertScriptPolicy(root, { scripts: 'deny', flags: [] }), /scripts/u);
    await assertScriptPolicy(root, { scripts: 'allow', flags: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});
