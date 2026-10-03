import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { readRegistry, parseRegistry } from '../src/reliability/registry.ts';
import { parseFeatures } from '../src/features.ts';
import { capabilityCatalog } from '../src/reliability/catalog.ts';

test('all audit findings have task owners and cannot be closed without both kinds of evidence', async () => {
  const registry = await readRegistry();
  assert.equal(registry.findings.length, 25);
  const parsed = parseFeatures(await readFile(new URL('../docs/reliability/items.json', import.meta.url), 'utf8'));
  if (!parsed.ok) assert.fail(parsed.reason);
  const ids = new Set(parsed.features.map(t => t.id));
  for (const finding of registry.findings) {
    assert.ok(finding.tasks.every(id => ids.has(id)), finding.id);
    const broken = structuredClone(registry);
    broken.findings.find(f => f.id === finding.id)!.status = 'verified';
    broken.findings.find(f => f.id === finding.id)!.resolutionEvidence = [];
    assert.throws(() => parseRegistry(broken), /evidence/);
  }
  const arrayPriority = JSON.parse(JSON.stringify(registry)); arrayPriority.findings[0].priority = ['P1'];
  assert.throws(() => parseRegistry(arrayPriority), /priority/);
  const duplicate = structuredClone(registry); duplicate.findings.push(duplicate.findings[0]!);
  assert.throws(() => parseRegistry(duplicate), /duplicate/);
  const invalid = structuredClone(registry); invalid.baseline.skipped = -1;
  assert.throws(() => parseRegistry(invalid), /counts/);
});

test('catalog provider paths refer to actual modules', async () => {
  for (const entry of capabilityCatalog().entries) for (const stage of Object.values(entry.stages)) {
    for (const provider of stage.providers) await access(new URL(`../${provider}`, import.meta.url));
  }
});
