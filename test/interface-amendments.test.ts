import test from 'node:test';import assert from 'node:assert/strict';
import {resolveAmendment,delegationFor,parseAmendment,errorBlocker,blockerRoute,type AmendmentCheckpoint} from '../src/acceptance/interface-amendments.ts';
import {outlinePatchDigest} from '../src/acceptance/outline-patch.ts';
import {CheckRequestInterrupted} from '../src/acceptance/request-failure.ts';
import type {Feature} from '../src/features.ts';import type {Blueprint} from '../src/acceptance/preparation.ts';
const task:Feature={id:'form',title:'Compose',priority:'must',status:'todo',dependsOn:[],criteria:['Optional notes; Other requires explanatory text. Do not expose private prose.']};
const b:Blueprint={version:1,contract:'Do not expose private prose. Optional notes; Other requires explanatory text.',cases:[{id:'notes',description:'Select Content note and enter explanatory text; inspect compose and preview for forbidden controls.',kind:'browser'}],coverage:[{criterion:1,cases:['notes']}]};
const blocker={kind:'contract-choice' as const,caseId:'notes',details:'Missing accessible category and explanatory controls.'};
const raw=()=>({version:1,baseDigest:outlinePatchDigest(b),reason:'Map existing controls',choices:[{caseId:'notes',observation:'enter explanatory text',role:'textarea',name:'Content note explanation'},{caseId:'notes',observation:'Select Content note',role:'combobox',name:'Content note'}]});
test('content-note amendment checkpoints its proposal and review without granting approval',async()=>{
 let state:AmendmentCheckpoint|undefined;let calls=0;
 const services={request:async()=>{calls++;return calls===1?raw():{disposition:'routine',reason:'Only existing control names are proposed.'};},save:async(s:AmendmentCheckpoint)=>{state=structuredClone(s);}};
 const next=await resolveAmendment(task,b,blocker,delegationFor(task),false,services);
 assert.equal(calls,2);assert.ok(next.contract.startsWith(b.contract+'\n\n'));assert.deepEqual(next.coverage,b.coverage);assert.deepEqual(next.cases,b.cases);assert.equal(state!.status,'ready');
 await resolveAmendment(task,b,blocker,delegationFor(task),false,{...services,request:async()=>{throw Error('no repeat');}},state);assert.equal(calls,2);assert.equal('approved' in state!,false);
});
test('no delegation, changed task, approved design and real missing actions never trigger a model',async()=>{
 const services={request:async()=>{throw Error('provider must not run');},save:async()=>{}};
 for(const [delegation,approved] of [[undefined,false],[delegationFor({...task,id:'different'}),false],[delegationFor(task),true]] as const)await assert.rejects(resolveAmendment(task,b,blocker,delegation,approved,services),/delegation/);
 await assert.rejects(resolveAmendment(task,b,{kind:'missing-action',details:'Assistive technology unavailable'},delegationFor(task),false,services),/Assistive technology/);
});
test('private-scope changes require concrete human decision; structural edits cannot replace the contract',async()=>{
 let calls=0,state:AmendmentCheckpoint|undefined;
 await assert.rejects(resolveAmendment(task,b,blocker,delegationFor(task),false,{request:async()=>++calls===1?raw():{disposition:'decision',reason:'The proposed control exposes private prose; retain privacy or explicitly revise the requirement.'},save:async s=>{state=structuredClone(s);}}),/human decision/);
 assert.equal(state!.status,'decision');assert.equal(state!.before.contract,b.contract);
 assert.throws(()=>parseAmendment(task,b,{...raw(),contract:'Publish prose'}),/Unknown/);
 assert.throws(()=>parseAmendment(task,b,{...raw(),baseDigest:'old'}),/Stale/);
 assert.throws(()=>parseAmendment(task,b,{...raw(),choices:[{...raw().choices[0],observation:'invented requirement'}]}),/existing browser observation/);
});
test('forbidden-control inspection can split without removing coverage or changing evidence kind',()=>{
 const value={...raw(),choices:[],split:{caseId:'notes',cases:[{id:'compose-fields',description:'Inspect compose and select optional notes.',kind:'browser'},{id:'preview-fields',description:'Inspect preview for forbidden controls.',kind:'browser'}]}};
 const next=parseAmendment(task,b,value).proposal;assert.equal(next.contract,b.contract);assert.deepEqual(next.coverage[0]!.cases,['compose-fields','preview-fields']);
 assert.throws(()=>parseAmendment(task,b,{...value,split:{...value.split,cases:value.split.cases.map(c=>({...c,kind:'command'}))}}),/evidence kind/);
});
test('interrupted independent amendment review reuses the proposal and keeps the original unchanged',async()=>{
 let saved:AmendmentCheckpoint|undefined,calls=0;
 const services={save:async(s:AmendmentCheckpoint)=>{saved=structuredClone(s);},request:async()=>{if(++calls===1)return raw();throw new CheckRequestInterrupted('timeout','interrupted');}};
 await assert.rejects(resolveAmendment(task,b,blocker,delegationFor(task),false,services),/interrupted/);
 assert.equal(saved!.status,'reviewing');const next=await resolveAmendment(task,b,blocker,delegationFor(task),false,{...services,request:async()=>{calls++;return {disposition:'routine',reason:'Preserved requirements.'};}},saved);assert.equal(calls,3);assert.ok(next.contract.includes('Content note explanation'));assert.equal(saved!.before.contract,b.contract);
});
test('failure classes have distinct bounded recovery routes',()=>{
 assert.equal(errorBlocker(new CheckRequestInterrupted('timeout','interrupted')).kind,'provider-failure');
 assert.equal(errorBlocker({issues:[{kind:'missing-interface',stage:'notes',detail:'No label'}]}).kind,'contract-choice');
 assert.equal(errorBlocker(new Error('Invalid schema')).kind,'invalid-format');
 assert.equal(new Set(['contract-choice','journey-limit','missing-action','invalid-format','provider-failure','requirement-conflict'].map(k=>blockerRoute(k as any))).size,6);
});
import {draftInParts,type Preparation} from '../src/acceptance/preparation.ts';
import {EvidenceFeasibilityGap} from '../src/acceptance/feasibility.ts';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {configureInterfaceChoices} from '../src/acceptance/interface-choices.ts';import {harnessDirectory} from '../src/record/record.ts';import {taskDigest} from '../src/acceptance/draft.ts';
test('feasibility amends before generation, rechecks the proposal and retains the history',async()=>{
 let state:Preparation|undefined,feasible=0,amended=0,generated=0;
 const next=parseAmendment(task,b,raw()).proposal;
 const result=await draftInParts(task,{plan:async()=>b,feasibility:async input=>{feasible++;if(input.contract===b.contract)throw new EvidenceFeasibilityGap([{kind:'missing-interface',stage:'notes',detail:'Name category and explanation controls.'}]);return {};},amendOutline:async()=>{amended++;return next;},reviewOutline:async()=>({verdict:'pass',issues:[],limitations:[]}),generate:async()=>{generated++;return {id:'notes',tasks:['form'],description:b.cases[0]!.description,kind:'browser',steps:[],browser:{version:1,title:'Controls',entry:'server.js',port:4173,timeoutSeconds:30,steps:[{action:'count',selector:'textarea',expected:1}]}};},save:async s=>{state=structuredClone(s);}});
 assert.equal(feasible,2);assert.equal(amended,1);assert.equal(generated,1);assert.equal(result.contract,next.contract);assert.equal(state!.amendments!.length,1);assert.equal(state!.amendments![0]!.before.contract,b.contract);
});
test('repeated unresolved interface changes stop within two durable amendments',async()=>{
 let calls=0,state:Preparation|undefined;
 await assert.rejects(draftInParts(task,{plan:async()=>b,feasibility:async()=>{throw new EvidenceFeasibilityGap([{kind:'missing-interface',stage:'notes',detail:'Missing controls'}]);},amendOutline:async input=>{calls++;return {...input,contract:input.contract+'\nMore names.'};},generate:async()=>{throw Error('no generation');},save:async s=>{state=structuredClone(s);}}),/Two interface amendments/);
 assert.equal(calls,2);assert.equal(state!.amendments!.length,2);
});
test('operator delegation is explicit, task bound, revocable and stored outside application source',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'choice-delegation-')),project=root+'/app';await mkdir(project);await writeFile(project+'/features.json',JSON.stringify([task]));
 try{let asked=0;const io={write:()=>{},ask:async()=>{asked++;return 'y';}};await configureInterfaceChoices(project,task.id,io);const file=path.join(harnessDirectory(project),'acceptance','interface-choices',taskDigest(task)+'.json');assert.deepEqual(JSON.parse(await readFile(file,'utf8')),delegationFor(task));assert.equal(asked,1);await configureInterfaceChoices(project,task.id,io,true);assert.equal(JSON.parse(await readFile(file,'utf8')).revoked,true);}finally{await rm(root,{recursive:true,force:true});}
});
test('one malformed amendment reply is corrected and retained before independent review',async()=>{
 let saved:AmendmentCheckpoint|undefined,calls=0;
 const result=await resolveAmendment(task,b,blocker,delegationFor(task),false,{request:async()=>{calls++;return calls===1?{...raw(),unknown:true}:calls===2?raw():{disposition:'routine',reason:'Only accessible names changed.'};},save:async s=>{saved=structuredClone(s);}});
 assert.equal(calls,3);assert.equal(saved!.previousReplies!.length,1);assert.ok(result.contract.includes('Content note explanation'));
});
test('a retained independent verdict cannot authorize a substituted amendment',async()=>{
 let saved:AmendmentCheckpoint|undefined,calls=0;
 const services={request:async()=>++calls===1?raw():{disposition:'routine',reason:'Names only.'},save:async(s:AmendmentCheckpoint)=>{saved=structuredClone(s);}};
 await resolveAmendment(task,b,blocker,delegationFor(task),false,services);
 const corrupt=structuredClone(saved!);(corrupt.raw as ReturnType<typeof raw>).choices[0]!.name='Different label';
 await assert.rejects(resolveAmendment(task,b,blocker,delegationFor(task),false,{...services,request:async()=>{throw Error('do not spend');}},corrupt),/does not match/);
 assert.equal(calls,2);
});
