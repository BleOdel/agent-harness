import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {draftProduct, approveProduct, assertProductCurrent, readProduct} from '../src/product/spec.ts';
import {productReport, recordDiagnostics} from '../src/product/report.ts';
import {captureBaseline, captureCandidate, assertLiveBaseline} from '../src/workspace/candidate.ts';
import {requireChecks} from '../src/acceptance/checks.ts';
import {approveChecks} from '../src/acceptance/checks.ts';
import {productSetup} from '../src/verbs/product.ts';

async function fixture(t: any) {
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'product-test-'))), project=path.join(root,'app');
 await mkdir(project);t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(project,'package.json'),JSON.stringify({type:'module',scripts:{test:'node --test test/*.test.js'}}));
 const task={id:'core',title:'Core',priority:'must',status:'todo',criteria:['Returns saved data'],dependsOn:[],planContext:'Build a small reader.'};
 const features=async(value=task)=>writeFile(path.join(project,'features.json'),JSON.stringify([value]));
 await features();return {root,project,task,features};
}
test('product approval freezes requirements, not task completion status',async t=>{
 const f=await fixture(t);const d=await draftProduct(f.project,'web','prototype',[]);await approveProduct(f.project,d);
 assert.equal((await readProduct(f.project))?.digest,d.digest);
 await f.features({...f.task,status:'done'});assert.equal((await assertProductCurrent(f.project))?.digest,d.digest);
 await f.features({...f.task,criteria:['Different requirement']});await assert.rejects(()=>assertProductCurrent(f.project),/requirements.*changed/i);
});
test('preview approval refuses requirements changed during the question',async t=>{
 const f=await fixture(t),d=await draftProduct(f.project,'api','prototype',[]);
 await f.features({...f.task,title:'Changed'});await assert.rejects(()=>approveProduct(f.project,d),/changed/i);
 assert.equal(await readProduct(f.project),undefined);
});
test('protected documents reject candidate edits and deletion',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.project,'PLAN.md'),'approved plan');
 await approveProduct(f.project,await draftProduct(f.project,'cli','prototype',['PLAN.md']));
 const baseline=await captureBaseline(f.project,path.join(f.root,'base'));
 await writeFile(path.join(baseline.directory,'PLAN.md'),'builder rewrite');
 // Use a separate worker; the immutable baseline itself stays intact.
 const worker=path.join(f.root,'worker');await mkdir(worker);
 await writeFile(path.join(baseline.directory,'PLAN.md'),'approved plan');
 await writeFile(path.join(worker,'package.json'),await readFile(path.join(f.project,'package.json')));
 await assert.rejects(()=>captureCandidate(baseline,worker,path.join(f.root,'candidate')),/protected product document/i);
 await writeFile(path.join(worker,'PLAN.md'),'builder rewrite');
 await assert.rejects(()=>captureCandidate(baseline,worker,path.join(f.root,'candidate')),/protected product document/i);
});
test('changing the approved product during a run prevents application',async t=>{
 const f=await fixture(t);await approveProduct(f.project,await draftProduct(f.project,'cli','prototype',[]));
 const base=await captureBaseline(f.project,path.join(f.root,'base'));
 await approveProduct(f.project,await draftProduct(f.project,'web','sensitive',[]));
 await assert.rejects(()=>assertLiveBaseline(f.project,base),/product.*changed/i);
});
test('stale product requirements also block acceptance dispatch',async t=>{
 const f=await fixture(t);await approveProduct(f.project,await draftProduct(f.project,'api','prototype',[]));
 await f.features({...f.task,criteria:['Changed']});await assert.rejects(()=>requireChecks(f.project,['core']),/requirements.*changed/i);
});
test('contract changes invalidate product approval; helper-only revisions do not',async t=>{
 const f=await fixture(t),file=path.join(f.root,'checks.json');
 const checks=async(contract:string,stdout:string)=>{await writeFile(file,JSON.stringify({version:1,cases:[{id:'core-check',tasks:['core'],contract,steps:[{command:['node','-e','console.log(1)'],exitCode:0,stdout}]}]}));await approveChecks(f.project,file);};
 await checks('GET /stories','1\n');await approveProduct(f.project,await draftProduct(f.project,'api','prototype',[]));
 await checks('GET /stories','2\n');assert.ok(await assertProductCurrent(f.project));
 await checks('GET /posts','2\n');await assert.rejects(()=>assertProductCurrent(f.project),/requirements.*changed/i);
});
test('report never confuses missing evidence or done flags with passed verification',async t=>{
 const f=await fixture(t);await f.features({...f.task,status:'done'});
 await approveProduct(f.project,await draftProduct(f.project,'web','sensitive',[]));
 const r=await productReport(f.project);assert.equal(r.ready,false);
 assert.equal(r.checks.find(c=>c.id==='diagnostics')?.status,'missing');
 assert.equal(r.checks.find(c=>c.id==='browser')?.status,'missing');
 assert.equal(r.checks.find(c=>c.id==='security')?.status,'human');
});
test('diagnostics report includes skipped checks and never reuses stale source',async t=>{
 const f=await fixture(t);const d=await draftProduct(f.project,'cli','prototype',[]);await approveProduct(f.project,d);
 const source=await captureBaseline(f.project,path.join(f.root,'source'));
 await recordDiagnostics(f.project,source.digest,[{name:'tests',status:'passed',summary:'3 assertions'},{name:'build',status:'skipped',summary:'No build command'}]);
 let r=await productReport(f.project);assert.equal(r.checks.find(c=>c.id==='diagnostics')?.status,'passed');
 assert.ok(r.checks.find(c=>c.id==='diagnostics')?.detail.includes('skipped'));
 await writeFile(path.join(f.project,'app.js'),'changed');r=await productReport(f.project);
 assert.equal(r.checks.find(c=>c.id==='diagnostics')?.status,'stale');assert.equal(r.ready,false);
});
test('a later failed diagnostic replaces a previous pass',async t=>{
 const f=await fixture(t);await approveProduct(f.project,await draftProduct(f.project,'cli','prototype',[]));
 const source=await captureBaseline(f.project,path.join(f.root,'source'));
 await recordDiagnostics(f.project,source.digest,[{name:'tests',status:'passed',summary:'passes'}]);
 await recordDiagnostics(f.project,source.digest,[{name:'tests',status:'failed',summary:'fails'}]);
 assert.equal((await productReport(f.project)).checks.find(c=>c.id==='diagnostics')?.status,'failed');
});
test('invalid kinds, empty requirements and document escape paths are refused',async t=>{
 const f=await fixture(t);
 await assert.rejects(()=>draftProduct(f.project,'mobile' as any,'prototype',[]),/kind/i);
 await assert.rejects(()=>draftProduct(f.project,'cli','prototype',['../outside']),/path/i);
 await writeFile(path.join(f.project,'features.json'),JSON.stringify([]));
 await assert.rejects(()=>draftProduct(f.project,'cli','prototype',[]),/Accept work items/i);
});
test('guided setup shows requirements and verification plan before approval; cancel saves nothing',async t=>{
 const f=await fixture(t),answers=['3','1','','n'],lines:string[]=[];
 await productSetup(f.project,{ask:async()=>answers.shift()!,write:s=>lines.push(s)});
 assert.equal(await readProduct(f.project),undefined);assert.ok(lines.some(s=>s.includes('Returns saved data')));
 assert.ok(lines.some(s=>s.includes('browser')));
});

import {recordAssessment} from '../src/product/report.ts';
import {integrateCandidate} from '../src/team/integrate.ts';
import {nextBaseline} from '../src/workspace/baseline.ts';
import {copySource} from '../src/workspace/candidate.ts';
import {randomUUID} from 'node:crypto';
import {saveApproval as saveBrowserApproval,newRun,saveBrowserRun} from '../src/browser/store.ts';
import {putArtifact,sha256} from '../src/artifacts/store.ts';

test('protection survives candidate, merge and next staging snapshots',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.project,'PLAN.md'),'protected');
 await approveProduct(f.project,await draftProduct(f.project,'cli','prototype',['PLAN.md']));
 const base=await captureBaseline(f.project,path.join(f.root,'base')),worker=path.join(f.root,'worker');
 await copySource(base.directory,worker);await writeFile(path.join(worker,'app.js'),'implementation');
 const candidate=await captureCandidate(base,worker,path.join(f.root,'candidate'));
 const integrated=await integrateCandidate(base,candidate,base,path.join(f.root,'integrated'),[]);assert.ok(integrated.ok);
 const next=await nextBaseline(path.join(f.root,'run'),integrated.proposal);
 assert.equal(next.productDigest,base.productDigest);assert.deepEqual(next.protectedDocuments,base.protectedDocuments);
 await writeFile(path.join(worker,'PLAN.md'),'rewrite');
 await assert.rejects(()=>captureCandidate(next,worker,path.join(f.root,'bad')),/Protected product document/);
});
test('current CLI evidence can pass; subsequent failed acceptance cannot be hidden by the previous pass',async t=>{
 const f=await fixture(t);await f.features({...f.task,status:'done'});
 const checksFile=path.join(f.root,'checks.json');await writeFile(checksFile,JSON.stringify({version:1,cases:[{id:'probe',tasks:['core'],steps:[{command:['node','-e','console.log(1)'],exitCode:0,stdout:'1\n'}]}]}));
 const approval=await approveChecks(f.project,checksFile);
 await approveProduct(f.project,await draftProduct(f.project,'cli','prototype',[]));
 const source=await captureBaseline(f.project,path.join(f.root,'source'));
 await recordDiagnostics(f.project,source.digest,[{name:'tests',status:'passed',summary:'Observed assertions'}]);
 const root=f.project+'-harness/acceptance/results';await mkdir(root,{recursive:true});
 const saved={version:1,at:'2026-01-01T00:00:00Z',project:f.project,tasks:['core'],approvalDigest:approval.digest,candidateDigest:source.digest,outcome:'passed',observations:[{case:'probe',step:1,exitCode:0,timedOut:false}]};
 await writeFile(path.join(root,randomUUID()+'.json'),JSON.stringify(saved));
 const report=await productReport(f.project);assert.equal(report.checks.find(c=>c.id==='acceptance:core')?.status,'passed');
 await recordAssessment(f.project,report.source!,report.spec!,true,'Inspected the full CLI workflow and coverage limits.');
 assert.equal((await productReport(f.project)).ready,true);
 await writeFile(path.join(root,randomUUID()+'.json'),JSON.stringify({...saved,at:'2026-01-02T00:00:00Z',outcome:'failed'}));
 assert.equal((await productReport(f.project)).checks.find(c=>c.id==='acceptance:core')?.status,'failed');
 assert.equal((await productReport(f.project)).ready,false);
});
test('browser pass requires actual observations with matching artifact provenance',async t=>{
 const f=await fixture(t);await approveProduct(f.project,await draftProduct(f.project,'web','prototype',[]));
 const source=await captureBaseline(f.project,path.join(f.root,'source'));
 const runtime={image:'sha256:'+'a'.repeat(64),arch:'arm64',node:'v26.5.0',playwright:'1.63.0',chromium:'153',axe:'4.13.0',protocol:'b'.repeat(64)};
 const a=await saveBrowserApproval(f.project,{version:1,title:'Reader',entry:'server.js',port:4173,timeoutSeconds:30,steps:[{action:'goto',path:'/'},{action:'text',selector:'h1',expected:'Stories'}]},runtime);
 const j=await newRun(f.project,a,'/usr/local/bin/docker');j.source=source.digest;j.identity=sha256(JSON.stringify({source:j.source,approval:a.digest,runtime}));j.status='passed';
 await saveBrowserRun(f.project,j);assert.equal((await productReport(f.project)).checks.find(c=>c.id==='browser')?.status,'failed');
 const bytes=Buffer.from(JSON.stringify({version:1,steps:[{action:'goto',status:200},{action:'text',values:['Stories']}],errors:[]}));
 const artifact=await putArtifact(f.project,'browser-observations.json',bytes,{producer:j.id,input:j.source,environment:j.identity,verification:'unverified'});j.report=artifact.id;j.artifacts=[artifact.id];await saveBrowserRun(f.project,j);
 assert.equal((await productReport(f.project)).checks.find(c=>c.id==='browser')?.status,'passed');
 const unrelated=await putArtifact(f.project,'browser-observations.json',bytes,{producer:'another-run',input:j.source,environment:j.identity,verification:'unverified'});j.report=unrelated.id;await saveBrowserRun(f.project,j);
 assert.equal((await productReport(f.project)).checks.find(c=>c.id==='browser')?.status,'failed');
});
test('interrupted verification explicitly invalidates an earlier pass',async t=>{
 const f=await fixture(t);await approveProduct(f.project,await draftProduct(f.project,'cli','prototype',[]));
 const source=await captureBaseline(f.project,path.join(f.root,'source'));
 await recordDiagnostics(f.project,source.digest,[{name:'tests',status:'passed',summary:'Passed'}]);
 await recordDiagnostics(f.project,source.digest,[{name:'execution',status:'failed',summary:'Verification did not complete'}]);
 assert.equal((await productReport(f.project)).checks.find(c=>c.id==='diagnostics')?.status,'failed');
});
