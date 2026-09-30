import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {randomUUID} from 'node:crypto';
import {draftProduct,approveProduct} from '../src/product/spec.ts';import {productReport,recordAssessment} from '../src/product/report.ts';
import {approvePerformance,saveRun,runIdentity,type Approval,type PerformanceRun} from '../src/performance/store.ts';
import {performanceReport,recordPerformanceAssessment} from '../src/performance/report.ts';import {performanceSetup} from '../src/verbs/performance.ts';
import {putArtifact,saveJson} from '../src/artifacts/store.ts';import {profile,observation,environment} from './performance-fixture.ts';
const source='b'.repeat(64);
async function fixture(fn:(f:any)=>Promise<void>){const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'performance-test-'))),project=root+'/app';await mkdir(project);await writeFile(project+'/package.json','{"name":"fixture","type":"module"}');await writeFile(project+'/features.json',JSON.stringify([{id:'api',title:'Local API',priority:'must',status:'done',criteria:['Serve correct responses'],dependsOn:[]} ]));try{
 const product=await draftProduct(project,'api','sensitive',[]);await approveProduct(project,product);const a=await approvePerformance(project,profile,environment),context={source,product:product.digest};let counter=0;
 const save=async(observed=observation(),approval:Approval=a)=>{counter++;const id='performance-run-'+randomUUID(),identity=runIdentity(source,approval),artifact=await putArtifact(project,'performance-samples.json',Buffer.from(JSON.stringify(observed)),{producer:id,input:source,environment:identity,verification:'unverified'}),r:PerformanceRun={version:1,id,at:new Date(Date.UTC(2026,8,30,0,0,counter)).toISOString(),approval:approval.digest,approvalId:approval.id,product:product.digest,protocol:approval.protocol,image:environment.image,docker:'/fixture/docker',token:randomUUID(),status:'passed',verified:true,containers:[],source,identity,report:artifact.id,message:'fixture'};await saveRun(project,r);return {r,artifact};};await fn({root,project,product,a,context,save});
 }finally{await rm(root,{recursive:true,force:true});}}
test('performance evidence recomputes raw samples and requires separate current assessment',async()=>fixture(async f=>{
 const {r}=await f.save();let report=await performanceReport(f.project,f.context);assert.equal(report.status,'missing');assert.equal(report.metrics?.samples,15);assert.equal(report.run,r.id);await recordPerformanceAssessment(f.project,report,true,'Reviewed repeat stability, synthetic workload and laptop environment limitations.');report=await performanceReport(f.project,f.context);assert.equal(report.status,'passed');assert.equal(report.complete,true);
 assert.equal((await performanceReport(f.project,{...f.context,source:'c'.repeat(64)})).status,'stale');
 await f.save(observation(100));const failed=await performanceReport(f.project,f.context);assert.equal(failed.status,'failed');assert.equal(failed.complete,false);assert.ok(failed.failures.includes('mean latency'));
}));
for(const mode of ['partial','cleanup','unverified','artifact','approval','provenance'])test('performance evidence rejects '+mode,async()=>fixture(async f=>{
 const {r,artifact}=await f.save();
 if(mode==='partial'){delete r.verified;r.status='interrupted';await saveRun(f.project,r);}
 if(mode==='cleanup'){r.containers=['harness-performance-'+randomUUID()];await saveRun(f.project,r);}
 if(mode==='unverified'){delete r.verified;await saveRun(f.project,r);}
 if(mode==='artifact')await writeFile(f.project+'-harness/artifacts/blobs/'+artifact.sha256,'{"version":1,"passed":true}');
 if(mode==='approval')await writeFile(f.project+'-harness/performance/approved.json','{"secret":"never-display"}');
 if(mode==='provenance'){artifact.producer='other';await saveJson(f.project+'-harness/artifacts/manifests',artifact.id+'.json',artifact);}
 const report=await performanceReport(f.project,f.context);assert.equal(report.status,'failed');assert.equal(report.complete,false);assert.ok(!JSON.stringify(report).includes('never-display'));
 if(mode==='approval')assert.equal((await productReport(f.project)).checks.find(c=>c.id==='performance')?.status,'failed');
}));
test('approved baseline remains fixed across new trials and changed workload cannot borrow it',async()=>fixture(async f=>{
 const {r,artifact}=await f.save(),a=await approvePerformance(f.project,profile,environment,r.id);
 assert.equal(a.baseline?.meanMs,5);const slower=await f.save(observation(8),a);await assert.rejects(approvePerformance(f.project,profile,environment,slower.r.id),/passing/);const report=await performanceReport(f.project,f.context);assert.equal(report.status,'failed');assert.ok(report.failures.includes('approved baseline regression'));assert.equal(report.baseline?.meanMs,5);
 await assert.rejects(approvePerformance(f.project,{...profile,samples:6},environment,r.id),/differ/);
 await assert.rejects(approvePerformance(f.project,profile,{...environment,kernel:'changed'},r.id),/differ/);
 await writeFile(f.project+'-harness/artifacts/blobs/'+artifact.sha256,'changed');assert.equal((await performanceReport(f.project,f.context)).status,'failed');
}));
test('new interrupted current attempt blocks fallback; generic approval cannot waive performance',async()=>fixture(async f=>{
 await f.save();const {r}=await f.save();r.status='running';delete r.source;delete r.report;delete r.verified;await saveRun(f.project,r);assert.equal((await performanceReport(f.project,f.context)).status,'failed');
 const product=await productReport(f.project);await recordAssessment(f.project,product.source!,product.spec!,true,'General product usability review, not a performance acceptance override.');assert.equal((await productReport(f.project)).ready,false);
}));
test('guided performance setup previews repetitions, thresholds and environment before approval',async()=>fixture(async f=>{
 const answers=['','','','','','','','n','none','','y'],lines:string[]=[];
 await performanceSetup(f.project,{ask:async()=>{assert.ok(answers.length);return answers.shift()!;},write:s=>lines.push(s)},async()=>environment);
 assert.equal(answers.length,0);assert.ok(lines.some(l=>l.includes('512 MiB')));assert.ok(lines.some(l=>l.includes('Performance profile saved')));
}));

test('changed threshold approval invalidates old evidence instead of accepting its own slower baseline',async()=>fixture(async f=>{
 await f.save();const report=await performanceReport(f.project,f.context);await recordPerformanceAssessment(f.project,report,true,'Reviewed original approved workload, threshold and runtime limitations.');
 await approvePerformance(f.project,{...profile,meanMs:100},environment);const changed=await performanceReport(f.project,f.context);assert.equal(changed.status,'missing');assert.equal(changed.complete,false);assert.equal(changed.metrics,undefined);
}));
