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

test('qualification distinguishes inspection, unexecuted, reproduced and fixed without promoting historical evidence',async()=>{
 const original=await readRegistry();
 const old=JSON.parse(JSON.stringify(original));old.version=1;delete old.qualificationReport;for(const f of old.findings)delete f.qualification;
 assert.equal(parseRegistry(old).version,1);assert.equal(parseRegistry(old).findings[0]!.qualification,undefined);
 const current=JSON.parse(JSON.stringify(original));current.version=2;current.qualificationReport='docs/reliability/evidence/foundation-validation.json';
 for(const f of current.findings){f.status='open';f.qualification={state:'inspection-only',trigger:'Inspect the documented boundary.',regression:null,execution:null,limitation:'No runtime reproduction.'};}
 assert.equal(parseRegistry(current).findings[0]!.qualification!.state,'inspection-only');
 const f=current.findings[0];f.qualification.state='unexecuted';f.qualification.regression='test/reliability-defects.test.ts';assert.doesNotThrow(()=>parseRegistry(current));
 f.qualification.state='reproduced';assert.throws(()=>parseRegistry(current),/execution/);
 f.qualification.execution='docs/reliability/evidence/foundation-validation.json';assert.doesNotThrow(()=>parseRegistry(current));
 f.qualification.state='fixed';assert.throws(()=>parseRegistry(current),/fixed|verified/);
 f.status='verified';f.regressions=['test/reliability-defects.test.ts'];f.resolutionEvidence=[{kind:'regression',path:f.regressions[0]},{kind:'negative-control',path:'docs/reliability/evidence/mutation-controls.json'}];assert.doesNotThrow(()=>parseRegistry(current));
 f.qualification.state='reproduced';assert.throws(()=>parseRegistry(current),/fixed|verified/);
 f.status='open';f.qualification.state='passed-with-skips';assert.throws(()=>parseRegistry(current),/qualification/);
 f.qualification.state='unexecuted';f.qualification.execution='old.json';assert.throws(()=>parseRegistry(current),/unexecuted/);
});

test('retained qualification links distinguish failed audit cases from passing operational lanes',async()=>{
 const registry=await readRegistry();assert.equal(registry.version,2);
 const report=JSON.parse(await readFile(new URL('../'+registry.qualificationReport,import.meta.url),'utf8'));
 assert.equal(report.kind,'local-foundation-validation');assert.match(report.source.baseCommit,/^[a-f0-9]{40}$/);
 assert.equal(report.knownDefects.qualifies,false);assert.equal(report.knownDefects.exitCode,1);
 assert.equal(report.knownDefects.failed,report.knownDefects.reproduced.length);
 assert.equal(report.knownDefects.skipped,0);assert.equal(report.smoke.counts.skipped,0);
 for(const f of registry.findings){
  const q=f.qualification!;
  if(q.regression)await access(new URL('../'+q.regression,import.meta.url));
  if(q.execution)await access(new URL('../'+q.execution,import.meta.url));
  if(q.state==='reproduced')assert.ok(report.knownDefects.reproduced.includes(f.id),f.id);
  if(q.state==='fixed'){
   const execution=JSON.parse(await readFile(new URL('../'+q.execution,import.meta.url),'utf8'));
   assert.ok(execution.requiredRegressions.includes(q.regression),f.id);
   for(const e of f.resolutionEvidence)await access(new URL('../'+e.path,import.meta.url));
  }
 }
});
