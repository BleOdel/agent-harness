import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {parseProposal} from '../src/acceptance/draft.ts';
import {scopeDigest,reviewScopes,validateInScopes,type ReviewLedger} from '../src/acceptance/scoped-review.ts';
import {applyCodeRepair,recoverCodeRepair,type CodeRepairState} from '../src/acceptance/repair-response.ts';
const task={id:'app',title:'App',status:'todo' as const,priority:'must' as const,dependsOn:[],criteria:['Retain the pending revision while the approved content remains public.']};
const pass={verdict:'pass' as const,issues:[],limitations:[]};
const issues=['Observe the queued pending content, not just its revision ID.'];
const proposal=()=>parseProposal({version:1,contract:'Pending content is private.',coverage:[{criterion:1,cases:['edit','peer']}],manifest:{version:1,cases:['edit','peer'].map(id=>({id,tasks:['app'],description:id,steps:[{command:['node','-e','console.log(1)'],exitCode:0,stdout:'1\n'}]}))}},task);
function ledger(p=proposal()):ReviewLedger{return {version:1,entries:['$contract','peer','edit'].map(scope=>({scope,digest:scopeDigest(task,p,scope),repairs:scope==='edit'?1:0,syntaxRepairs:0,review:scope==='edit'?{verdict:'repair',issues,limitations:[]}:pass}))};}
const codes={codes:[{step:1,code:'console.log(2-1)'}]};
test('ordinary review repairs through saved code responses, freezes expectations and re-reviews the repaired scope',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'scoped-repair-')),project=root+'/app';await mkdir(project);t.after(()=>rm(root,{recursive:true,force:true}));
 const p=proposal(),before=ledger(p);let calls=0;const reviewed:string[]=[];
 const result=await validateInScopes(project,task,p,()=>{},async()=>{},before,{
  requestRepair:async(_project,prompt)=>{calls++;assert.match(prompt,/codes/);assert.doesNotMatch(prompt,/exact before\/after/);return codes;},
  review:async(scope)=>{reviewed.push(scope);return pass;},
 });
 assert.equal(calls,1);assert.deepEqual(reviewed,['edit']);assert.equal(result.proposal.manifest.cases[0]!.steps[0]!.command.at(-1),'console.log(2-1)');
 assert.deepEqual(result.proposal.manifest.cases[1],p.manifest.cases[1]);assert.equal(result.proposal.manifest.cases[0]!.steps[0]!.stdout,'1\n');assert.equal(result.proposal.contract,p.contract);
 const folder=project+'-harness/acceptance/repair-responses',files=await readdir(folder);assert.equal(files.length,1);assert.deepEqual(JSON.parse(await readFile(folder+'/'+files[0],'utf8')).generated,codes);
});
test('a final repair response survives a crash without spending another attempt or provider request',async()=>{
 const p=proposal();let saved=ledger(p),response:CodeRepairState|undefined,requests=0,crash=true;
 const repair=async(scope:string,input:typeof p,findings:string[])=>recoverCodeRepair(task,input,scope,findings,{request:async()=>{requests++;return codes;},save:async state=>{response=structuredClone(state);if(crash&&state.generated){crash=false;throw Error('crash after response');}}},response,0,'request');
 const services={durableRepairs:true,syntax:async()=>[],review:async()=>pass,repair,save:async(_p:typeof p,l:ReviewLedger)=>{saved=structuredClone(l);}};
 await assert.rejects(reviewScopes(task,p,services,saved,'edit'),/crash after response/);
 assert.equal(saved.entries.find(e=>e.scope==='edit')!.repairs,2);
 const result=await reviewScopes(task,p,services,saved,'edit');
 assert.equal(requests,1);assert.equal(result.ledger.entries.find(e=>e.scope==='edit')!.repairs,2);assert.equal(result.ledger.entries.find(e=>e.scope==='edit')!.pendingRepair,undefined);assert.equal(result.ledger.entries.find(e=>e.scope==='edit')!.review?.verdict,'pass');
});
test('an interrupted provider cannot silently renew a durable request budget',async()=>{
 const p=proposal();let saved=ledger(p),response:CodeRepairState|undefined,requests=0;
 const services={durableRepairs:true,syntax:async()=>[],review:async()=>pass,repair:async(scope:string,input:typeof p,findings:string[])=>recoverCodeRepair(task,input,scope,findings,{request:async()=>{requests++;throw Error('provider unavailable');},save:async s=>{response=structuredClone(s);}},response,0,'request'),save:async(_p:typeof p,l:ReviewLedger)=>{saved=structuredClone(l);}};
 await assert.rejects(reviewScopes(task,p,services,saved,'edit'),/provider unavailable/);
 await assert.rejects(reviewScopes(task,p,services,saved,'edit'),/ended without a response/);assert.equal(requests,1);assert.equal(saved.entries.find(e=>e.scope==='edit')!.repairs,2);
});
test('a malformed pending repair checkpoint is rejected before any service runs',async()=>{
 const p=proposal(),saved=ledger(p);(saved.entries[2] as any).pendingRepair={syntax:false,attempt:2,issues};let calls=0;
 await assert.rejects(reviewScopes(task,p,{durableRepairs:true,syntax:async()=>{calls++;return [];},review:async()=>pass,repair:async()=>p,save:async()=>{}},saved,'edit'),/pending repair/);assert.equal(calls,0);
});

test('explicit renewal archives the charged budget and clears only the chosen pending request',async()=>{
 const {renewScope,blockedScopes}=await import('../src/acceptance/targeted.ts');const p=proposal(),before=ledger(p);const selected=before.entries.find(e=>e.scope==='edit')!;selected.pendingRepair={syntax:false,attempt:1,issues};
 assert.deepEqual(blockedScopes(task,p,before),['edit']);const renewed=renewScope(task,p,before,'edit');const e=renewed.entries.find(e=>e.scope==='edit')!;
 assert.equal(e.pendingRepair,undefined);assert.equal(e.repairs,0);assert.equal(e.retryCount,1);assert.deepEqual(e.review,selected.review);assert.equal(selected.repairs,1);assert.deepEqual(renewed.entries.filter(e=>e.scope!=='edit'),before.entries.filter(e=>e.scope!=='edit'));
});
