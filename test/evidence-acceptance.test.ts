import {receiptRuntimeFixture} from './evidence-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {approveChecks,assertAcceptanceProof,assertAutomatedAcceptanceProof} from '../src/acceptance/checks.ts';
import {captureBaseline} from '../src/workspace/candidate.ts';
import {evidenceHash} from '../src/evidence/admission.ts';
async function fixture(fn:(x:any)=>Promise<void>){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'admission-'))),project=root+'/app';await mkdir(project);
 try{
  await writeFile(project+'/app.js','hello');const source=root+'/checks.json';
  await writeFile(source,JSON.stringify({version:1,cases:[{id:'greet',tasks:['story'],steps:[{command:['node','app.js'],exitCode:0,stdout:'Hello\n',files:[{path:'saved.txt',text:'retained'}]}]}]}));
  const approval=await approveChecks(project,source),candidate=await captureBaseline(project,root+'/source');
  const evidencePath=project+'-harness/acceptance/results/abc.json';await mkdir(path.dirname(evidencePath),{recursive:true});
  const proof={approvalDigest:approval.digest,candidateDigest:candidate.digest,evidencePath};
  const evidence={...receiptRuntimeFixture,version:1,project,...proof,outcome:'passed',tasks:['story'],observations:[{case:'greet',step:1,exitCode:0,timedOut:false,stdoutHash:evidenceHash('Hello\n'),stdoutPreview:'Hello\n',files:{'saved.txt':evidenceHash('retained')}}],browserObservations:[]};
  const save=()=>writeFile(evidencePath,JSON.stringify(evidence));await save();await fn({root,project,source,candidate,proof,evidence,save});
 }finally{await rm(root,{recursive:true,force:true});}
}
test('ordinary evidence needs actual command observations, not just a passed status',()=>fixture(async({project,candidate,proof,evidence,save})=>{
 await assertAcceptanceProof(project,candidate,['story'],proof);evidence.observations=[];await save();
 await assert.rejects(assertAcceptanceProof(project,candidate,['story'],proof),/observations|evidence/);
}));
test('both delivery routes reject mismatching stdout and file hashes and duplicate observations',()=>fixture(async({project,candidate,proof,evidence,save})=>{
 const original=structuredClone(evidence.observations);
 for(const staged of [false,true])for(const defect of ['stdout','file','duplicate','timeout']){
  evidence.outcome=staged?'automated-passed':'passed';if(staged)evidence.manualPending=[];
  evidence.observations=structuredClone(original);
  if(defect==='stdout')evidence.observations[0].stdoutHash=evidenceHash('wrong');
  if(defect==='file')evidence.observations[0].files['saved.txt']=evidenceHash('wrong');
  if(defect==='duplicate')evidence.observations.push(evidence.observations[0]);
  if(defect==='timeout')evidence.observations[0].timedOut=true;
  await save();await assert.rejects((staged?assertAutomatedAcceptanceProof:assertAcceptanceProof)(project,candidate,['story'],proof),/observations|evidence/,defect);
 }
}));
test('a bound new receipt detects replacement without changing its original reference',()=>fixture(async({project,candidate,proof,evidence,save})=>{
 const bytes=await readFile(proof.evidencePath);const pinned={...proof,evidenceDigest:evidenceHash(bytes)};
 await assertAcceptanceProof(project,candidate,['story'],pinned);evidence.extra='changed';await save();
 await assert.rejects(assertAcceptanceProof(project,candidate,['story'],pinned),/changed|evidence/);
}));


test('large command outputs are admitted only through matching retained artifact bytes',()=>fixture(async({project,candidate,proof,evidence,save,source})=>{
 const output='x'.repeat(5000)+' end',artifact='abc-output-0-0.txt';
 const raw=JSON.parse(await readFile(source,'utf8'));raw.cases[0].steps[0].stdout=output;
 await writeFile(source,JSON.stringify(raw));const approval=await approveChecks(project,source);
 proof.approvalDigest=approval.digest;evidence.approvalDigest=approval.digest;
 Object.assign(evidence.observations[0],{stdoutPreview:output.slice(0,4000),stdoutHash:evidenceHash(output),stdoutArtifact:artifact});await save();
 await writeFile(path.join(path.dirname(proof.evidencePath),artifact),output);
 await assertAcceptanceProof(project,candidate,['story'],proof);
 await writeFile(path.join(path.dirname(proof.evidencePath),artifact),'changed');await assert.rejects(assertAcceptanceProof(project,candidate,['story'],proof),/artifact.*changed/);
 evidence.observations[0].stdoutArtifact='../escaped';await save();await assert.rejects(assertAcceptanceProof(project,candidate,['story'],proof),/Invalid.*artifact/);
}));
test('legacy truncated previews remain incomplete rather than inventing missing output',()=>fixture(async({project,candidate,proof,evidence,save})=>{
 evidence.observations[0].stdoutHash=evidenceHash('Hello\n'+'x'.repeat(5000));await save();
 await assert.rejects(assertAcceptanceProof(project,candidate,['story'],proof),/complete retained command output/);
}));


test('missing legacy runtime identity and a changed pinned runtime stay incomplete',()=>fixture(async({project,candidate,proof,evidence,save})=>{
 const {acceptanceRuntime}=await import('../src/evidence/acceptance.ts');
 const runtimeDigest=acceptanceRuntime(evidence,null);const pinned={...proof,runtimeDigest};
 await assertAcceptanceProof(project,candidate,['story'],pinned);
 evidence.image='sha256:'+'b'.repeat(64);await save();await assert.rejects(assertAcceptanceProof(project,candidate,['story'],pinned),/runtime evidence changed/);
 delete evidence.image;await save();await assert.rejects(assertAcceptanceProof(project,candidate,['story'],proof),/runtime evidence is incomplete/);
}));
