import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {approveChecks,requireChecks,requireStagingChecks,assertAutomatedAcceptanceProof} from '../src/acceptance/checks.ts';
import {captureBaseline,captureCandidate} from '../src/workspace/candidate.ts';
import {saveStage,readStage,assertStageCurrent,recordStageReview,assertStageReview} from '../src/staging/store.ts';
import {harnessDirectory} from '../src/record/record.ts';
async function fixture(fn:(root:string,p:string)=>Promise<void>){const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'stage-test-')));const p=path.join(root,'app');await mkdir(p);try{await writeFile(path.join(p,'features.json'),JSON.stringify([{id:'story',title:'Story',priority:'must',status:'todo',criteria:['Announced errors'],dependsOn:[]}]));await writeFile(path.join(p,'app.js'),'before');await writeFile(path.join(p,'package.json'),JSON.stringify({type:'module',scripts:{test:'node --test test/*.test.js'}}));await fn(root,p);}finally{await rm(root,{recursive:true,force:true});}}
const checks={version:1,cases:[{id:'speech',tasks:['story'],kind:'manual',steps:[],manual:{instructions:'Use a real screen reader and observe the spoken error.'}}]};
async function approval(root:string,p:string){const file=path.join(root,'checks.json');await writeFile(file,JSON.stringify(checks));return approveChecks(p,file);}
async function staged(root:string,p:string){
 const approved=await approval(root,p),baseline=await captureBaseline(p,path.join(root,'baseline'));
 const worker=path.join(root,'worker');await mkdir(worker);await writeFile(path.join(worker,'app.js'),'after');await writeFile(path.join(worker,'package.json'),await readFile(path.join(p,'package.json')));
 const candidate=await captureCandidate(baseline,worker,path.join(root,'candidate'));
 const evidencePath=path.join(harnessDirectory(p),'acceptance/results/abc.json');await mkdir(path.dirname(evidencePath),{recursive:true});
 const acceptance={approvalDigest:approved.digest,candidateDigest:candidate.digest,evidencePath};
 await writeFile(evidencePath,JSON.stringify({version:1,at:new Date().toISOString(),project:p,...acceptance,tasks:['story'],outcome:'automated-passed',manualPending:['speech'],observations:[],browserObservations:[]}));
 const stage=await saveStage(p,{id:'r1',task:'story',workDigest:'a'.repeat(64),baseline,candidate,acceptance,tasks:['story'],gates:['tests passed'],review:{verdict:'pass',findings:[]}});
 return {stage,approved,candidate};
}
test('manual requirements permit staging but never automatic application',()=>fixture(async(root,p)=>{await approval(root,p);await assert.rejects(requireChecks(p,['story']),/manual evidence/);assert.equal((await requireStagingChecks(p,['story'])).manifest.cases.length,1);}));
test('staging retains frozen source, exact manual obligations and automated-only evidence',()=>fixture(async(root,p)=>{
 const {stage}=await staged(root,p);await rm(path.join(root,'candidate'),{recursive:true});const saved=await readStage(p,'r1');assert.equal(saved.candidate.digest,stage.candidate.digest);await assertStageCurrent(p,saved);assert.equal(await readFile(path.join(p,'app.js'),'utf8'),'before');await assert.rejects(assertStageReview(saved),/review/);
 await writeFile(saved.acceptance.evidencePath,JSON.stringify({version:1,project:p,...saved.acceptance,tasks:['story'],outcome:'passed',observations:[]}));await assert.rejects(assertAutomatedAcceptanceProof(p,saved.candidate,saved.tasks,saved.acceptance),/evidence/);
}));
test('manual review requires each result, environment, observations and explicit final approval',()=>fixture(async(root,p)=>{
 const {stage}=await staged(root,p);
 await assert.rejects(recordStageReview(p,stage,{environment:'VoiceOver Safari',observations:[],approved:true}),/manual/);
 await assert.rejects(recordStageReview(p,stage,{environment:'',observations:[{id:'speech',passed:true,notes:'Error was announced'}],approved:true}),/environment/);
 await recordStageReview(p,stage,{environment:'VoiceOver Safari',observations:[{id:'speech',passed:false,notes:'No error announced'}],approved:true});await assert.rejects(assertStageReview(await readStage(p,'r1')),/review/);
 await recordStageReview(p,stage,{environment:'VoiceOver Safari',observations:[{id:'speech',passed:true,notes:'Error announced when submitting blank input'}],approved:false});await assert.rejects(assertStageReview(await readStage(p,'r1')),/review/);
 await recordStageReview(p,stage,{environment:'VoiceOver Safari',observations:[{id:'speech',passed:true,notes:'Error announced when submitting blank input'}],approved:true});await assertStageReview(await readStage(p,'r1'));
}));
test('changed source, live baseline, approval and requirements invalidate staged review',()=>fixture(async(root,p)=>{
 const {stage}=await staged(root,p);await recordStageReview(p,stage,{environment:'VoiceOver Safari',observations:[{id:'speech',passed:true,notes:'Announced'}],approved:true});
 await writeFile(path.join(stage.candidate.directory,'app.js'),'tampered');await assert.rejects(assertStageCurrent(p,stage),/Frozen source/);await writeFile(path.join(stage.candidate.directory,'app.js'),'after');
 await writeFile(path.join(p,'app.js'),'external');await assert.rejects(assertStageCurrent(p,stage),/live project/);await writeFile(path.join(p,'app.js'),'before');
 await writeFile(path.join(p,'features.json'),'[]');await assert.rejects(assertStageCurrent(p,stage),/requirements|live project/);
}));

import {saveContinuation,readContinuation} from '../src/workflow/store.ts';
import {applyStage} from '../src/staging/apply.ts';
import {nextRunId,readRecord} from '../src/record/record.ts';
import {withWriter} from '../src/workspace/writer-lock.ts';
import {driveContinuation,type ContinueState} from '../src/workflow/controller.ts';
import {previewArguments} from '../src/staging/preview.ts';
async function approveStage(p:string,s:Awaited<ReturnType<typeof readStage>>){await recordStageReview(p,s,{environment:'VoiceOver Safari',observations:[{id:'speech',passed:true,notes:'Spoken error was observed after submitting invalid input'}],approved:true});}
test('application requires final review, preserves undo data, marks the task done and is idempotent',()=>fixture(async(root,p)=>{
 const {stage}=await staged(root,p);await assert.rejects(applyStage(p,'r1'),/review/);assert.equal(await readFile(path.join(p,'app.js'),'utf8'),'before');
 await saveContinuation(p,{version:1,task:'story',status:'approval',message:'Review candidate',updated:new Date().toISOString(),attempts:1,maxBuilds:2,recoveries:0,events:[]});
 await approveStage(p,stage);const applied=await applyStage(p,'r1');assert.equal(applied.status,'applied');assert.equal((await readContinuation(p))?.status,'complete');assert.equal(await readFile(path.join(p,'app.js'),'utf8'),'after');assert.equal(JSON.parse(await readFile(path.join(p,'features.json'),'utf8'))[0].status,'done');
 assert.equal(await readFile(path.join(harnessDirectory(p),'recovery',applied.application!.record.id,'before/app.js'),'utf8'),'before');
 await applyStage(p,'r1');assert.equal((await readRecord(p)).runs.length,1);
}));
test('interrupted application reserves its run, blocks other writers and resumes exact bytes once',()=>fixture(async(root,p)=>{
 const {stage}=await staged(root,p);await approveStage(p,stage);
 await assert.rejects(applyStage(p,'r1',async point=>{if(point==='file:app.js')throw Error('simulated crash');}),/simulated crash/);
 await assert.rejects(withWriter(p,'work',async()=>assert.fail()),/staged application requires recovery/);
 assert.equal(await nextRunId(p),'r3');
 await applyStage(p,'r1');assert.equal((await readRecord(p)).runs.length,1);assert.equal((await readStage(p,'r1')).status,'applied');
 await withWriter(p,'work',async()=>{});
}));
test('interrupted application refuses external edits and changed approved expectations',()=>fixture(async(root,p)=>{
 const {stage}=await staged(root,p);await approveStage(p,stage);
 await assert.rejects(applyStage(p,'r1',async point=>{if(point==='intent')throw Error('crash');}),/crash/);
 await writeFile(path.join(p,'app.js'),'my edit');await assert.rejects(applyStage(p,'r1'),/External change/);assert.equal(await readFile(path.join(p,'app.js'),'utf8'),'my edit');
 await writeFile(path.join(p,'app.js'),'before');const file=path.join(root,'new.json');await writeFile(file,JSON.stringify({...checks,cases:[{...checks.cases[0],manual:{instructions:'Different requirement'}}]}));await approveChecks(p,file);await assert.rejects(applyStage(p,'r1'),/evidence/);
}));
test('preview isolates source and temporary data without exposing credentials or network',()=>{
 const args=previewArguments('harness-stage-id','token','/candidate','sha256:abc',4000,{entry:'src/server.js',databaseEnv:'BLOG_DB'});
 assert.equal(args[args.indexOf('--network')+1],'none');assert.ok(args.includes('type=bind,src=/candidate,dst=/app,readonly'));assert.ok(args.includes('BLOG_DB=/data/preview.sqlite'));assert.ok(args.includes('PORT=4000'));
 assert.equal(args.some(a=>a.includes('auth.json')||a.includes('/.pi')||a==='--publish'||a==='--privileged'),false);
});

test('edits made while a file or requirements replacement is prepared are preserved',()=>fixture(async(root,p)=>{
 const {stage}=await staged(root,p);await approveStage(p,stage);
 await assert.rejects(applyStage(p,'r1',async point=>{if(point==='prepared-file:app.js')await writeFile(path.join(p,'app.js'),'concurrent edit');}),/External change/);
 assert.equal(await readFile(path.join(p,'app.js'),'utf8'),'concurrent edit');await writeFile(path.join(p,'app.js'),'before');
 await assert.rejects(applyStage(p,'r1',async point=>{if(point==='prepared-features')await writeFile(path.join(p,'features.json'),'[]');}),/Requirements changed/);
 assert.equal(await readFile(path.join(p,'features.json'),'utf8'),'[]');
}));

import {approveProduct,draftProduct} from '../src/product/spec.ts';import {productReport} from '../src/product/report.ts';
import {stageCommand} from '../src/verbs/stage.ts';
test('product reporting distinguishes current operator-observed staging from unreviewed and stale evidence',()=>fixture(async(root,p)=>{
 await approval(root,p);await approveProduct(p,await draftProduct(p,'api','prototype',[]));
 const {stage}=await staged(root,p);assert.notEqual((await productReport(p)).checks.find(c=>c.id==='acceptance:story')?.status,'passed');
 await approveStage(p,stage);await applyStage(p,'r1');let report=await productReport(p);const row=report.checks.find(c=>c.id==='acceptance:story');assert.equal(row?.status,'passed',JSON.stringify(report));assert.match(row!.detail,/operator review/);
 await writeFile(path.join(p,'app.js'),'new source');report=await productReport(p);assert.notEqual(report.checks.find(c=>c.id==='acceptance:story')?.status,'passed');
}));
test('stale pending candidates can be explicitly discarded without applying or destroying retained source',()=>fixture(async(root,p)=>{
 await staged(root,p);await writeFile(path.join(p,'app.js'),'external');await stageCommand(p,['discard','r1'],{write:()=>{},ask:async()=>'y'});
 assert.equal((await readStage(p,'r1')).status,'discarded');assert.equal(await readFile(path.join(p,'app.js'),'utf8'),'external');await assert.rejects(applyStage(p,'r1'),/Rejected/);
}));

test('a live edit during recovery preparation stops before publishing an apply intent',()=>fixture(async(root,p)=>{
 const {stage}=await staged(root,p);await approveStage(p,stage);await assert.rejects(applyStage(p,'r1',async point=>{if(point==='prepared-recovery')await writeFile(path.join(p,'app.js'),'external edit');}),/live project/);
 assert.equal((await readStage(p,'r1')).status,'pending');assert.equal(await readFile(path.join(p,'app.js'),'utf8'),'external edit');await assert.rejects(readFile(path.join(harnessDirectory(p),'staged-application.json')),/ENOENT/);
}));

import {readiness} from '../src/guide/readiness.ts';
test('readiness distinguishes approved manual designs from unresolved preparation without provider calls',()=>fixture(async(root,p)=>{
 await approval(root,p);const result=await readiness(p,{},async()=>assert.fail('No configured container or provider should run'));
 const acceptance=result.checks.find(c=>c.id==='acceptance');assert.equal(acceptance?.status,'ready');assert.match(acceptance!.message,/staged final review/);
}));
