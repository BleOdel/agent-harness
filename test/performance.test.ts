import test from 'node:test';import assert from 'node:assert/strict';
import {parseProfile,parseObservation,compare,workloadDigest} from '../src/performance/schema.ts';
import {profile,observation} from './performance-fixture.ts';
test('performance profile bounds workload and freezes expectations and thresholds',()=>{
 assert.deepEqual(parseProfile(profile),profile);
 for(const patch of [{path:'https://remote.test'},{samples:0},{repetitions:1},{requestTimeoutMs:0},{maxSeconds:9999},{expectedJson:{bad:Infinity}},{meanMs:0},{port:'3848'}])assert.throws(()=>parseProfile({...profile,...patch}));
 assert.notEqual(workloadDigest(profile),workloadDigest({...profile,expectedJson:{status:'changed'}}));assert.equal(workloadDigest(profile),workloadDigest({...profile,meanMs:1}));
});
test('performance comparison includes failed samples, rejects wrong responses and enforces baseline regression',()=>{
 const o=observation();assert.equal(compare(profile,o).passed,true);
 const slow=observation(100);assert.equal(compare(profile,slow).passed,false);
 const wrong=observation();wrong.rounds[0]!.samples[0]!.bodyHash='f'.repeat(64);assert.ok(compare(profile,wrong).failures.includes('response correctness'));
 const timeout=observation();Object.assign(timeout.rounds[0]!.samples[0]!,{status:null,bodyHash:null,error:'timeout'});const failed=compare(profile,timeout);assert.equal(failed.metrics.errors,1);assert.equal(failed.passed,false);assert.equal(failed.metrics.samples,15);
 assert.equal(compare(profile,o,{meanMs:1,throughputRps:1000}).passed,false);
 const partial=observation();partial.complete=false;assert.throws(()=>compare(profile,partial));
 const missing=observation();missing.rounds[0]!.samples.pop();assert.throws(()=>compare(profile,missing));
 const varying=observation();for(const sample of varying.rounds[0]!.samples)sample.ms=40;varying.rounds[0]!.elapsedMs=201;assert.ok(compare({...profile,maxSpreadPercent:20},varying).failures.includes('repeat stability'));
 const forged=observation();forged.rounds[0]!.elapsedMs=1;assert.throws(()=>compare(profile,forged));
 assert.throws(()=>parseObservation({...o,meanMs:0}));assert.throws(()=>parseObservation({...o,rounds:[]}));
});
