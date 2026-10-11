import test from 'node:test';
import assert from 'node:assert/strict';
import {parseProposal} from '../src/acceptance/draft.ts';
import {scopeDigest,reviewScopes} from '../src/acceptance/scoped-review.ts';
import type {Feature} from '../src/features.ts';
const task:Feature={id:'app',title:'App',priority:'must',status:'todo',dependsOn:[],criteria:['Keep prose private','Inspect layout']};
const proposal=()=>parseProposal({version:1,contract:'Never expose private prose.\n\nServe on loopback.',coverage:[{criterion:1,cases:['first','second']},{criterion:2,cases:['layout']}],manifest:{version:1,cases:[...['first','second'].map(id=>({id,tasks:['app'],description:id,steps:[{command:['node','-e','console.log(1)'],exitCode:0,stdout:'1\n'}]})),{id:'layout',tasks:['app'],description:'Inspect layout',kind:'manual',steps:[],manual:{instructions:'Inspect layout'}}]}},task);
test('peer review survives manual wording and peer code changes, global consistency does not',async()=>{
 const p=proposal(),calls:string[]=[];const services={syntax:async()=>[],review:async(id:string)=>{calls.push(id);return {verdict:'pass' as const,issues:[],limitations:[]};},repair:async()=>{throw Error('unexpected');},save:async()=>{}};
 const saved=(await reviewScopes(task,p,services)).ledger;
 const changed=structuredClone(p);changed.manifest.cases[2]!.description='Inspect layout at small widths';changed.manifest.cases[2]!.manual!.instructions='Inspect layout at small widths';calls.length=0;
 await reviewScopes(task,changed,services,saved);assert.deepEqual(calls,['$contract','layout']);
 const peer=structuredClone(p);peer.manifest.cases[1]!.steps[0]!.command[2]='console.log(2)';assert.equal(scopeDigest(task,p,'first'),scopeDigest(task,peer,'first'));
});
test('privacy, task identity, own limitations and runner semantics remain dependencies',()=>{
 const p=proposal(),original=scopeDigest(task,p,'first');
 const changed=structuredClone(p);changed.contract='Private prose may appear.';assert.notEqual(scopeDigest(task,changed,'first'),original);
 changed.contract=p.contract;changed.coverage[0]!.limitation='Only sampled privacy';assert.notEqual(scopeDigest(task,changed,'first'),original);
 assert.notEqual(scopeDigest({...task,id:'another'},p,'first'),original);
});
import {draftInParts,initializePreparation,blueprintProposal,type Blueprint,type Preparation} from '../src/acceptance/preparation.ts';
test('amending an early behaviour retains a completed later case across interruption and resume',async()=>{
 const p=proposal(),b:Blueprint={version:1,contract:p.contract,coverage:p.coverage,cases:p.manifest.cases.map(c=>({id:c.id,description:c.description!,...(c.kind?{kind:c.kind}:{})}))};
 const ledger=(await reviewScopes(task,p,{syntax:async()=>[],review:async()=>({verdict:'pass',issues:[],limitations:[]}),repair:async()=>{throw Error('unexpected');},save:async()=>{}})).ledger;
 const updated=structuredClone(b);updated.cases[0]!.description='Observe the first private value';
 const state=initializePreparation(task,updated,{version:1,blueprint:b,cases:p.manifest.cases,reviewLedger:ledger});
 assert.deepEqual(state.cases.map(c=>c.id),['second','layout']);assert.deepEqual(state.reviewLedger!.entries.map(e=>e.scope),['second','layout']);
 let checkpoint:Preparation=state;await assert.rejects(draftInParts(task,{plan:async()=>{throw Error('no replanning');},generate:async id=>{assert.equal(id,'first');throw Error('interrupted');},save:async s=>{checkpoint=structuredClone(s);}},state),/interrupted/);
 const generated:string[]=[];const result=await draftInParts(task,{plan:async()=>{throw Error('no replanning');},generate:async id=>{generated.push(id);return {...p.manifest.cases[0],description:updated.cases[0]!.description};},save:async()=>{}},checkpoint);
 assert.deepEqual(generated,['first']);assert.deepEqual(result.manifest.cases.map(c=>c.id),['first','second','layout']);
});
test('old receipt fingerprints are not silently rewritten during migration',async()=>{
 const p=proposal(),seen:string[]=[];
 const result=await reviewScopes(task,p,{syntax:async()=>[],review:async id=>{seen.push(id);return {verdict:'pass',issues:[],limitations:[]};},repair:async()=>{throw Error('unexpected');},save:async()=>{}},{version:1,entries:[{scope:'first',digest:'old-global-fingerprint',repairs:0,syntaxRepairs:0,review:{verdict:'pass',issues:[],limitations:[]}}]});
 assert.ok(seen.includes('first'));assert.equal(result.ledger.entries.find(e=>e.scope==='first')!.dependencies!.version,2);
});
import {choiceSuffix} from '../src/acceptance/interface-contract.ts';
test('typed local label amendments retain two unrelated peer receipts but shared privacy edits invalidate all',async()=>{
 const base=proposal();const cases=base.manifest.cases.slice(0,2).map(c=>({...c,kind:'browser',steps:[],browser:{version:1,title:'Observe field',entry:'server.js',port:4173,timeoutSeconds:30,steps:[{action:'count',selector:'#field',expected:1}]}}));
 const choices=[{caseId:'first',observation:'first',role:'textbox',name:'Title'}];
 const p=parseProposal({...base,localChoices:choices,contract:base.contract+choiceSuffix(choices),manifest:{version:1,cases:[...cases,base.manifest.cases[2]]}},task);
 const calls:string[]=[],services={syntax:async()=>[],review:async(id:string)=>{calls.push(id);return {verdict:'pass' as const,issues:[],limitations:[]};},repair:async()=>{throw Error('unexpected');},save:async()=>{}};
 const before=(await reviewScopes(task,p,services)).ledger;const changed=structuredClone(p);changed.localChoices![0]!.name='Journal title';changed.contract=base.contract+choiceSuffix(changed.localChoices!);calls.length=0;
 await reviewScopes(task,changed,services,before);assert.deepEqual(calls,['$contract','first']);
 changed.contract='Never expose private prose in headers either.\n\nServe on loopback.'+choiceSuffix(changed.localChoices!);calls.length=0;await reviewScopes(task,changed,services,before);assert.deepEqual(calls,['$contract','first','second','layout']);
 assert.throws(()=>parseProposal({...changed,contract:'Hide arbitrary privacy prose via forged metadata'},task),/differ/);
});
