import {receiptRuntimeFixture} from './evidence-fixture.ts';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {approveChecks} from '../src/acceptance/checks.ts';import {captureBaseline} from '../src/workspace/candidate.ts';
import {deliveryAdmission,assertDeliveryAdmission} from '../src/evidence/delivery.ts';
import {evidenceHash,type DeliveryMode} from '../src/evidence/admission.ts';
async function fixture(fn:(x:any)=>Promise<void>){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'delivery-policy-'))),project=root+'/app';await mkdir(project);
 try{
  await writeFile(project+'/app.js','hello');const source=root+'/checks.json';
  await writeFile(source,JSON.stringify({version:1,cases:[{id:'greet',tasks:['story'],steps:[{command:['node','app.js'],exitCode:0,stdout:'Hello\n'}]},{id:'speech',tasks:['story'],kind:'manual',steps:[],manual:{instructions:'Observe the spoken announcement with a real screen reader.'}}]}));
  const approval=await approveChecks(project,source),candidate=await captureBaseline(project,root+'/source');
  const evidencePath=project+'-harness/acceptance/results/abc.json';await mkdir(path.dirname(evidencePath),{recursive:true});
  const proof={approvalDigest:approval.digest,candidateDigest:candidate.digest,evidencePath};
  const evidence={...receiptRuntimeFixture,version:1,project,...proof,outcome:'automated-passed',tasks:['story'],manualPending:['speech'],observations:[{case:'greet',step:1,exitCode:0,timedOut:false,stdoutHash:evidenceHash('Hello\n'),stdoutPreview:'Hello\n',files:{}}],browserObservations:[]};
  await writeFile(evidencePath,JSON.stringify(evidence));
  const reviewPath=project+'-harness/candidates/r1/review-attempt-1.json';await mkdir(path.dirname(reviewPath),{recursive:true});
  const packet={version:1,sourceDigest:candidate.digest,acceptanceApprovalDigest:approval.digest,runtime:{image:receiptRuntimeFixture.image},gates:[{passed:true}],acceptance:'not-run'};
  await writeFile(reviewPath,JSON.stringify(packet));
  const review={evidencePath:reviewPath,verdict:'pass',findings:[]};
  const human={expectedBinding:'candidate-bound-review',recorded:{binding:'candidate-bound-review',at:new Date().toISOString(),environment:'VoiceOver on Safari',observations:[{id:'speech',passed:true,notes:'Error announced after submitting empty title'}],approved:true}};
  await fn({project,candidate,proof,review,human,packet});
 }finally{await rm(root,{recursive:true,force:true});}
}
for(const route of ['ordinary','staged','team','worktree'] as DeliveryMode[])test(`${route} adapter combines references without rewriting old receipts`,()=>fixture(async({project,candidate,proof,review,human})=>{
 const original=await readFile(proof.evidencePath),packet=await readFile(review.evidencePath);
 const result=await assertDeliveryAdmission(project,candidate,['story'],proof,{route,review,human});
 assert.equal(result.status,'authorized');assert.ok(result.references.some(r=>r.sha256===evidenceHash(original)));assert.ok(result.references.some(r=>r.sha256===evidenceHash(packet)));assert.ok(result.limitations.some(l=>l.includes('attestations')));
 assert.deepEqual(await readFile(proof.evidencePath),original);assert.deepEqual(await readFile(review.evidencePath),packet);
}));
test('a staged automated receipt stays incomplete until human observations and authorization both pass',()=>fixture(async({project,candidate,proof,review,human})=>{
 assert.equal((await deliveryAdmission(project,candidate,['story'],proof,{route:'staged',review})).status,'automated-passed');
 const bad=structuredClone(human);bad.recorded.approved=false;
 await assert.rejects(assertDeliveryAdmission(project,candidate,['story'],proof,{route:'staged',review,human:bad}),/incomplete/);
 bad.recorded.approved=true;bad.recorded.observations[0].passed=false;
 await assert.rejects(assertDeliveryAdmission(project,candidate,['story'],proof,{route:'staged',review,human:bad}),/incomplete/);
 bad.recorded.binding='stale';await assert.rejects(assertDeliveryAdmission(project,candidate,['story'],proof,{route:'staged',review,human:bad}),/changed|review/);
}));
test('forged source review flags and stale contract packets cannot admit a candidate',()=>fixture(async({project,candidate,proof,review,human,packet})=>{
 await assert.rejects(assertDeliveryAdmission(project,candidate,['story'],proof,{route:'staged',review:{verdict:'pass',findings:[]},human}),/review evidence/);
 delete packet.acceptanceApprovalDigest;await writeFile(review.evidencePath,JSON.stringify(packet));
 await assert.rejects(assertDeliveryAdmission(project,candidate,['story'],proof,{route:'staged',review,human}),/approved-contract/);
}));
test('source review artifact pins survive final review and detect later edits',()=>fixture(async({project,candidate,proof,review,human,packet})=>{
 review.evidenceDigest=evidenceHash(await readFile(review.evidencePath));
 await assertDeliveryAdmission(project,candidate,['story'],proof,{route:'staged',review,human});
 packet.notes='changed';await writeFile(review.evidencePath,JSON.stringify(packet));
 await assert.rejects(assertDeliveryAdmission(project,candidate,['story'],proof,{route:'staged',review,human}),/artifact changed/);
}));


test('legacy evidence limits remain visible in the shared policy result',()=>fixture(async({project,candidate,proof,review,human})=>{
 const e=JSON.parse(await readFile(proof.evidencePath,'utf8'));e.limitations=['Does not establish screen-reader compatibility on other platforms.'];await writeFile(proof.evidencePath,JSON.stringify(e));
 const result=await assertDeliveryAdmission(project,candidate,['story'],proof,{route:'ordinary',review,human});assert.ok(result.limitations.includes(e.limitations[0]));
}));
