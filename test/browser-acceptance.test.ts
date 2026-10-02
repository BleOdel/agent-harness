import {listApprovals} from '../src/browser/store.ts';
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {approveChecks,readApproval,requireChecks,verifyAcceptance,assertAcceptanceProof} from '../src/acceptance/checks.ts';
import {captureBaseline} from '../src/workspace/candidate.ts';import {loadConfig} from '../src/config.ts';
const baseCase={id:'ui',tasks:['ui'],kind:'browser',description:'Live count changes on typing.',steps:[],browser:{version:1,title:'Live count',entry:'server.js',port:4173,timeoutSeconds:20,steps:[{action:'goto',path:'/'},{action:'fill',selector:'#title',value:'hello'},{action:'text',selector:'#count',expected:'5'}]}};
test('manual expectations can be recorded but cannot authorize automatic implementation/application',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'manual-evidence-')),project=root+'/app';await mkdir(project);
 try{const file=root+'/checks.json';await writeFile(file,JSON.stringify({version:1,cases:[{id:'manual',tasks:['ui'],kind:'manual',description:'Review visual hierarchy.',steps:[],manual:{instructions:'Assess hierarchy at narrow and wide widths.'}}]}));await approveChecks(project,file);await assert.rejects(requireChecks(project,['ui']),/manual evidence is unresolved/);}finally{await rm(root,{recursive:true,force:true});}
});
test('Docker Chromium acceptance observes the candidate UI, rejects a wrong DOM result, and binds approval/runtime/source',{skip:process.env.HARNESS_VERIFY_BROWSER!=='1'},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'browser-acceptance-')),project=root+'/app';await mkdir(project);
 const server=(broken:boolean)=>`import http from 'node:http';const html=\`<html><body><label>Title<input id="title"></label><output id="count">0</output><script>document.querySelector('#title').oninput=e=>document.querySelector('#count').textContent=${broken?'0':'e.target.value.length'};</script></body></html>\`;http.createServer((q,r)=>r.end(html)).listen(Number(process.env.PORT),'127.0.0.1');`;
 try{
  await writeFile(project+'/package.json','{"type":"module"}');await writeFile(project+'/server.js',server(true));
  const file=root+'/checks.json';await writeFile(file,JSON.stringify({version:1,cases:[baseCase]}));const approval=await approveChecks(project,file);assert.ok(approval.browserRuntime);assert.equal((await readApproval(project))!.digest,approval.digest);
  await mkdir(root+'/pi');await mkdir(root+'/agent');const config=loadConfig({...process.env,HARNESS_PROJECT:project,HARNESS_PI_PACKAGE:root+'/pi',HARNESS_AGENT_DIR:root+'/agent'});const bad=await captureBaseline(project,root+'/bad');
  await assert.rejects(verifyAcceptance(project,bad,['ui'],config,approval),/exact text differs/);
  await writeFile(project+'/server.js',server(false));const good=await captureBaseline(project,root+'/good');
  // Live source can differ: the acceptance gate must observe the frozen candidate.
  await writeFile(project+'/server.js',server(true));
  const proof=await verifyAcceptance(project,good,['ui'],config,approval);assert.match(proof.summaries.join('\n'),/passed in Chromium/);
  await assertAcceptanceProof(project,good,['ui'],proof);await assert.rejects(assertAcceptanceProof(project,bad,['ui'],proof),/current candidate/);
  const evidence=JSON.parse(await readFile(proof.evidencePath,'utf8'));assert.equal(evidence.browserObservations[0].source,good.digest);assert.equal(evidence.browserObservations[0].status,'passed');assert.equal(evidence.observations.length,0);assert.equal((await listApprovals(project)).length,1);const savedEvidence=await readFile(proof.evidencePath,'utf8');await writeFile(proof.evidencePath,JSON.stringify({...evidence,browserObservations:[]}));await assert.rejects(assertAcceptanceProof(project,good,['ui'],proof),/Browser acceptance evidence/);await writeFile(proof.evidencePath,savedEvidence);assert.equal(await readFile(project+'/server.js','utf8'),server(true));
  const approvalFile=project+'-harness/acceptance/approved.json';const tampered=JSON.parse(await readFile(approvalFile,'utf8'));tampered.browserRuntime.protocol='0'.repeat(64);await writeFile(approvalFile,JSON.stringify(tampered));await assert.rejects(readApproval(project),/changed/);
 }finally{await rm(root,{recursive:true,force:true});}
});
