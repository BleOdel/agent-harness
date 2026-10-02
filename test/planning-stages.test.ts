import test from 'node:test';import assert from 'node:assert/strict';
import {planInStages,type OutlinePlanning,planningPrompt} from '../src/acceptance/planning-stages.ts';
import {CheckRequestInterrupted} from '../src/acceptance/request-failure.ts';
const task={id:'author',title:'Author',priority:'must' as const,status:'todo' as const,dependsOn:[],criteria:['Compose and preview.','Save a draft.'],planContext:'Use the approved local API. No public deployment.'};
const context={approvedContracts:['POST /stories returns 201.'],sourceFacts:'src/contracts.js defines title limits.',prerequisites:'Existing service checks are rerun.',runtime:'Offline Node; no browser in command checks.'};
const proposal=(n:number)=>({version:1,criterion:n,cases:[{id:'observe',description:'Observe criterion '+n}],limitation:'Rendered interaction needs separate browser evidence.'});
test('initial planning checkpoints each criterion and resumes a timeout without rebuilding previous stages',async()=>{
 let saved:OutlinePlanning|undefined;const seen:string[]=[];let interrupt=true;
 const services={request:async(stage:string)=>{seen.push(stage);if(stage==='interface')return {version:1,additions:'UI hash route #share.'};if(stage==='criterion-2'&&interrupt){interrupt=false;throw new CheckRequestInterrupted('timeout','partial stage');}return proposal(stage==='criterion-1'?1:2);},save:async(s:OutlinePlanning)=>{saved=structuredClone(s);},progress:()=>{}};
 await assert.rejects(planInStages(task,context,'input',services),/partial stage/);assert.equal(saved!.criteria.length,1);
 const b=await planInStages(task,context,'input',services,saved);assert.deepEqual(seen,['interface','criterion-1','criterion-2','criterion-2']);assert.ok(b.contract.startsWith(context.approvedContracts[0]!));assert.deepEqual(b.coverage.map(c=>c.criterion),[1,2]);assert.equal(b.cases.length,2);
 await planInStages(task,context,'input',{...services,request:async()=>{throw Error('No regeneration');}},saved);
});
test('bounded schema repair preserves raw replies and cannot accept invented criterion identity or empty overall coverage',async()=>{
 let saved:OutlinePlanning|undefined,calls=0;
 await assert.rejects(planInStages(task,context,'input',{request:async stage=>{calls++;return stage==='interface'?{version:1,additions:''}:{...proposal(999)};},save:async s=>{saved=structuredClone(s);},progress:()=>{}}),/still invalid/);assert.equal(calls,3);assert.equal(saved!.pending!.replies.length,2);
 await assert.rejects(planInStages(task,context,'input',{request:async()=>{throw Error('No unlimited repair');},save:async()=>{},progress:()=>{}},saved),/still invalid/);
 await assert.rejects(planInStages(task,context,'other',{request:async stage=>stage==='interface'?{version:1,additions:''}:{version:1,criterion:stage==='criterion-1'?1:2,cases:[],limitation:'Needs a browser.'},save:async()=>{},progress:()=>{}}),/No executable behaviours/);
});
test('planning prompt has one bounded output task, explicit input limits and no execution/helper instructions',()=>{
 const p=planningPrompt(task,context,'criterion-2','frozen interface');assert.ok(p.includes('Save a draft.'));assert.ok(p.includes('criterion 2'));assert.ok(!p.includes('serverRuntime'));assert.ok(!p.includes('Return schema:'));assert.throws(()=>planningPrompt({...task,planContext:'x'.repeat(100000)},context,'interface',''),/context.*limit/i);
});
