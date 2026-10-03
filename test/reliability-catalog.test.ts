import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilityCatalog, capabilitySummary, getCapability } from '../src/reliability/catalog.ts';

test('capability catalog separates complete-route gaps, recipes and unsupported platforms', () => {
  const catalog = capabilityCatalog();
  assert.equal(catalog.version, 1);
  assert.equal(new Set(catalog.entries.map(e => e.id)).size, catalog.entries.length);
  for (const id of ['node-basic', 'node-dependencies', 'python-single', 'linux-electron', 'macos-electron', 'macos-native', 'torch-cpu', 'metal-regression']) {
    const entry = getCapability(id);
    assert.ok(entry.prerequisites.length > 0);
    assert.ok(entry.limits.length > 0);
    assert.deepEqual(Object.keys(entry.stages).sort(), ['apply', 'build', 'manualReview', 'package', 'preview', 'recovery', 'release', 'securityPerformance', 'test', 'ui']);
    for (const stage of Object.values(entry.stages)) {
      assert.ok(stage.reason);
      if (stage.support === 'implemented') assert.ok(stage.providers.length);
    }
    assert.equal(entry.qualification, 'requires-current-evidence');
  }
  assert.equal(getCapability('node-dependencies').stages.ui.support, 'gap');
  assert.equal(getCapability('node-dependencies').stages.preview.support, 'gap');
  assert.equal(getCapability('macos-native').level, 'recipe');
  assert.equal(getCapability('small-llm-trial').level, 'diagnostic');
  assert.equal(getCapability('torch-mac-gpu').qualification, 'diagnostic-failed');
  for (const id of ['android', 'ios', 'windows', 'cuda', 'general-llm-training']) {
    assert.equal(getCapability(id).level, 'unsupported');
    assert.equal(getCapability(id).stages.build.support, 'unsupported');
  }
  assert.throws(() => getCapability('imaginary'), /Unknown capability/);
  assert.match(capabilitySummary('node-npm'), /dependency-free/);
  assert.match(capabilitySummary('python-pip'), /single-package/);
  assert.throws(() => capabilitySummary('rust'), /Unsupported adapter/);
  catalog.entries.length = 0;
  assert.ok(capabilityCatalog().entries.length > 10, 'callers cannot mutate catalog authority');
});
