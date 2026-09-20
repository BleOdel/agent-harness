import test from 'node:test';
import assert from 'node:assert/strict';
import {applyCodeRepair, renewScope} from '../src/acceptance/targeted.ts';
import {reviewScopes, scopeDigest, type ReviewLedger} from '../src/acceptance/scoped-review.ts';
import {parseProposal} from '../src/acceptance/draft.ts';
import {SERVER_DIGEST, SERVER_MODULE, assertServerRuntimes} from '../src/acceptance/server-runtime.ts';
const task={id:'app',title:'App',status:'todo' as const,priority:'must' as const,dependsOn:[],criteria:['Server works.']};
const proposal=()=>parseProposal({version:1,contract:'node server.js starts a loopback server.',coverage:[{criterion:1,cases:['first','second','third']}],manifest:{version:1,cases:['first','second','third'].map(id=>({id,tasks:['app'],description:id,steps:[{command:['node','--input-type=module','-e','console.log(1)'],exitCode:0,stdout:'1\n'}]}))}},task);
const pass={verdict:'pass' as const,issues:[],limitations:[]};
function ledger():ReviewLedger {const p=proposal();return {version:1,entries:[{scope:'$contract',digest:scopeDigest(task,p,'$contract'),repairs:0,syntaxRepairs:0,review:pass},{scope:'first',digest:scopeDigest(task,p,'first'),repairs:2,syntaxRepairs:0,review:{verdict:'repair',issues:['cleanup is broken'],limitations:[]}},{scope:'second',digest:scopeDigest(task,p,'second'),repairs:0,syntaxRepairs:0,review:pass}]};}
test('targeted repair freezes commands, expectations, other cases and contract; pins helper imports',()=>{
 const p=proposal();const code=`import {withServer} from '${SERVER_MODULE}';console.log(1)`;
 const result=applyCodeRepair(task,p,'first',{codes:[{step:1,code}]});
 assert.equal(result.manifest.cases[0]!.steps[0]!.serverRuntime,SERVER_DIGEST);
 assert.deepEqual(result.manifest.cases.slice(1),p.manifest.cases.slice(1));assert.equal(result.contract,p.contract);assert.deepEqual(result.coverage,p.coverage);
 assert.equal(result.manifest.cases[0]!.steps[0]!.stdout,'1\n');assertServerRuntimes(result.manifest);
 assert.throws(()=>applyCodeRepair(task,p,'first',{codes:[{step:2,code}]}),/step/);
 assert.throws(()=>applyCodeRepair(task,p,'first',{codes:[{step:1,code,stdout:'fake'}]}),/code/);
 assert.throws(()=>applyCodeRepair(task,p,'first',{codes:[{step:1,code},{step:1,code}]}),/step/);
 assert.throws(()=>applyCodeRepair(task,p,'first',{codes:[{step:1,code:'console.log(1)'}]}),/no change/);
});
test('explicit renewal retains findings and other reviews; a partial review cannot declare the suite reviewed',async()=>{
 const p=proposal(), before=ledger(), renewed=renewScope(task,p,before,'first');
 assert.equal(before.entries[1]!.repairs,2);assert.equal(renewed.entries[1]!.repairs,0);assert.equal(renewed.entries[1]!.retryCount,1);
 assert.deepEqual(renewed.entries[2],before.entries[2]);assert.deepEqual(renewed.entries[1]!.review,before.entries[1]!.review);
 const reviewed:string[]=[];let repaired=0;
 const result=await reviewScopes(task,p,{syntax:async()=>[],review:async s=>{reviewed.push(s);return pass;},repair:async s=>{repaired++;return applyCodeRepair(task,p,s,{codes:[{step:1,code:'console.log(2-1)'}]});},save:async()=>{}},renewed,'first');
 assert.deepEqual(reviewed,['first']);assert.equal(repaired,1);assert.equal('validation' in result,false);
 assert.deepEqual(result.ledger.entries.find(e=>e.scope==='second'),before.entries[2]);
 assert.throws(()=>renewScope(task,p,before,'second'),/blocked/);
 assert.throws(()=>renewScope(task,p,before,'$contract'),/blocked/);
});
test('failure checkpoints the spent targeted budget and resuming never renews it automatically',async()=>{
 const p=proposal();let saved=renewScope(task,p,ledger(),'first');let calls=0;
 await assert.rejects(reviewScopes(task,p,{syntax:async()=>[],review:async()=>pass,repair:async()=>{calls++;throw Error('provider unavailable');},save:async(_p,l)=>{saved=structuredClone(l);}},saved,'first'),/provider unavailable/);
 assert.equal(calls,1);assert.equal(saved.entries[1]!.repairs,1);
 await assert.rejects(reviewScopes(task,p,{syntax:async()=>[],review:async()=>pass,repair:async()=>{calls++;throw Error('provider unavailable');},save:async(_p,l)=>{saved=structuredClone(l);}},saved,'first'),/provider unavailable/);
 await assert.rejects(reviewScopes(task,p,{syntax:async()=>[],review:async()=>pass,repair:async()=>{calls++;return p;},save:async()=>{}},saved,'first'),/two repair attempts/);
 assert.equal(calls,2);
});
test('helper use without a pin or with stale helper bytes fails closed',()=>{
 const p=proposal();const s=p.manifest.cases[0]!.steps[0]!;s.command[3]=`import '${SERVER_MODULE}'`;
 assert.throws(()=>assertServerRuntimes(p.manifest),/missing or changed/);
 s.serverRuntime='0'.repeat(64);assert.throws(()=>assertServerRuntimes(p.manifest),/missing or changed/);
});
test('a previously reviewed check with a changed runtime can be repaired explicitly without redoing its peers',()=>{
 const p=proposal();p.manifest.cases[0]!.steps[0]!.serverRuntime='0'.repeat(64);
 const l=ledger();l.entries[1]={...l.entries[1]!,digest:scopeDigest(task,p,'first'),review:pass};
 const renewed=renewScope(task,p,l,'first');
 assert.equal(renewed.entries[1]!.review!.verdict,'repair');assert.match(renewed.entries[1]!.review!.issues[0]!,/helper has changed/);
 assert.deepEqual(renewed.entries[2],l.entries[2]);
});

test('ordinary text repair also pins helper migration before independent review',async()=>{
 const {applyCheckEdits}=await import('../src/acceptance/edits.ts');const p=proposal();
 const fixed=applyCheckEdits(p,{edits:[{target:'code',caseId:'first',step:1,before:'console.log(1)',after:`import {withServer} from '${SERVER_MODULE}';console.log(1)`,reason:'replace lifecycle code',issues:[1]}]},['lifecycle defect'],task);
 assert.equal(fixed.manifest.cases[0]!.steps[0]!.serverRuntime,SERVER_DIGEST);
 assertServerRuntimes(fixed.manifest);assert.deepEqual(fixed.manifest.cases.slice(1),p.manifest.cases.slice(1));
});
test('a helper-version-only retry refreshes the pin without a generation request or changing probe code',async()=>{
 const {repairCaseCode}=await import('../src/acceptance/targeted.ts');
 const p=proposal();const step=p.manifest.cases[0]!.steps[0]!;step.command[3]=`import '${SERVER_MODULE}';console.log(1)`;step.serverRuntime='0'.repeat(64);
 const l=ledger();l.entries[1]={...l.entries[1]!,digest:scopeDigest(task,p,'first'),review:pass};
 const renewed=renewScope(task,p,l,'first');
 const updated=await repairCaseCode('/not-a-project',task,p,'first',renewed.entries[1]!.review!.issues);
 assert.equal(updated.manifest.cases[0]!.steps[0]!.serverRuntime,SERVER_DIGEST);assert.deepEqual(updated.manifest.cases[0]!.steps[0]!.command,step.command);
 assert.equal(updated.manifest.cases[0]!.steps[0]!.stdout,step.stdout);
});
