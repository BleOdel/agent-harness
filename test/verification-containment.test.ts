import assert from "node:assert/strict";
import test from "node:test";
import { buildVerificationArguments, buildRunArguments, type SandboxLayout } from "../src/containment/sandbox.ts";
const layout: SandboxLayout = { dockerExecutable: '/docker', imageId: `sha256:${'a'.repeat(64)}`, containerName: 'gate', workDirectory: '/tmp/work', agentDirectory: '/private/agent', piPackageDirectory: '/private/pi', skillsDirectory: '/private/skills', user: '1000:1000' };
test('verification and preparation mount only their disposable input directory', () => {
  for (const network of ['none', 'bridge'] as const) {
    const args = buildVerificationArguments(layout, network, ['npm', 'ci']);
    assert.equal(args.filter(a => a === '--mount').length, 1);
    assert.ok(args.includes(`--network=${network}`));
    assert.ok(args.includes('--read-only'));
    assert.equal(args.some(a => a.includes('/private/') || a.includes('PI_CODING_AGENT_DIR')), false);
  }
});

test('review mounts candidate source read-only', () => {
  const args = buildRunArguments({ ...layout, purpose: 'review' }, 'bridge', ['node']);
  assert.ok(args.includes('type=bind,src=/tmp/work,dst=/work,readonly'));
  assert.ok(args.includes('type=bind,src=/private/agent,dst=/pi-agent'));
  assert.equal(args.some(a => a.includes('/private/skills')), false);
});
