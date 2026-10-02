import test from 'node:test';import assert from 'node:assert/strict';
import {driveContinuation,ImplementationInterrupted,type ContinueState,type ContinueServices} from '../src/workflow/controller.ts';
import {OperatorError} from '../src/verbs/io.ts';import {parseContinuation} from '../src/workflow/store.ts';
const state=():ContinueState=>({version:1,task:'author',status:'running',message:'Starting',updated:new Date().toISOString(),attempts:0,maxBuilds:2,recoveries:0,events:[]});
test('one continuation prepares, asks for approval, builds and presents the verified result',async()=>{
 const calls:string[]=[];let approved=false,done=false;
 const s=state();await driveContinuation(s,{snapshot:async()=>({done,checks:approved?'approved':'missing'}),prepare:async()=>{calls.push('prepare');return 'ready';},review:async()=>{calls.push('review');approved=true;},build:async()=>{assert.equal(approved,true);calls.push('build');done=true;},save:async s=>{assert.equal(parseContinuation(s),s);},write:()=>{}});
 assert.deepEqual(calls,['prepare','review','build']);assert.equal(s.status,'complete');assert.equal(s.attempts,1);
});
test('timeout resumes once from retained work and reserves dispatch before starting',async()=>{
 let calls=0,done=false;const saved:ContinueState[]=[];const s=state();
 await driveContinuation(s,{snapshot:async()=>({done,checks:'approved'}),prepare:async()=>assert.fail(),review:async()=>assert.fail(),build:async()=>{assert.equal(saved.at(-1)!.attempts,calls+1);if(++calls===1)throw new ImplementationInterrupted(new OperatorError('timeout'),'r7');done=true;},save:async s=>{saved.push(structuredClone(s));},write:()=>{}});
 assert.equal(calls,2);assert.equal(s.status,'complete');assert.equal(s.recoveries,1);assert.ok(s.events.some(e=>e.message.includes('r7')));
});
test('approval refusal, manual requirements, unavailable provider and application failures never start a retry loop',async()=>{
 for(const mode of ['refuse','manual','prepare-paused','prepare-blocked','failure']){
  let calls=0;const s=state();const services:ContinueServices={snapshot:async()=>({done:false,checks:mode==='manual'?'blocked':mode==='failure'?'approved':'missing',reason:'Decision needed'}),prepare:async()=>mode==='prepare-paused'?'paused':mode==='prepare-blocked'?'blocked':'ready',review:async()=>{},build:async()=>{calls++;throw new OperatorError('failed gate');},save:async()=>{},write:()=>{}};
  await driveContinuation(s,services);assert.equal(calls,mode==='failure'?1:0);assert.notEqual(s.status,'complete');
 }
});
test('a repeated timeout stops; resuming saved allowance cannot grant another build',async()=>{
 const s=state();let calls=0;const services:ContinueServices={snapshot:async()=>({done:false,checks:'approved'}),prepare:async()=>assert.fail(),review:async()=>assert.fail(),build:async()=>{calls++;throw new ImplementationInterrupted(new OperatorError('timeout'),'r'+calls);},save:async()=>{},write:()=>{}};
 await driveContinuation(s,services);assert.equal(s.status,'paused');assert.equal(calls,2);
 await driveContinuation(s,services);assert.equal(calls,2);
});
test('completion is reconciled after interruption without rebuilding; a return without completion needs attention',async()=>{
 for(const done of [true,false]){const s=state();let calls=0;await driveContinuation(s,{snapshot:async()=>({done,checks:'approved'}),prepare:async()=>assert.fail(),review:async()=>assert.fail(),build:async()=>{calls++;},save:async()=>{},write:()=>{}});assert.equal(calls,done?0:1);assert.equal(s.status,done?'complete':'attention');}
});

import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {taskDigest} from '../src/acceptance/draft.ts';
import {continueCommand,continuationSnapshot} from '../src/verbs/continue.ts';
import {saveContinuation,readContinuation} from '../src/workflow/store.ts';
import {emptyWorkspace} from '../src/view/workspace.ts';import {nextAction} from '../src/view/guidance.ts';
test('the real command reconciles completed work and keeps manual designs pending approval',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'continue-command-')),project=root+'/app';await mkdir(project);
 const feature={id:'author',title:'Author UI',priority:'must' as const,status:'done' as const,dependsOn:[],criteria:['Read with a screen reader']};
 const output:string[]=[],io={write:(s:string)=>output.push(s),ask:async()=>assert.fail('No question or model dispatch')};
 const priorExit=process.exitCode;
 try{
  await writeFile(project+'/features.json',JSON.stringify([feature]));
  await continueCommand(project,['author'],io);
  assert.equal((await readContinuation(project))!.status,'complete');
  await writeFile(project+'/features.json',JSON.stringify([{...feature,status:'todo'}]));
  await mkdir(project+'-harness/acceptance',{recursive:true});
  await writeFile(project+'-harness/acceptance/preparation.json',JSON.stringify({taskId:'author',taskDigest:taskDigest(feature),state:{blueprint:{cases:[{id:'screen-reader',kind:'manual',description:feature.criteria[0]}]}}}));
  assert.equal((await continuationSnapshot(project,'author')).checks,'missing');
  assert.equal(await readFile(project+'/features.json','utf8'),JSON.stringify([{...feature,status:'todo'}]));
 }finally{process.exitCode=priorExit;await rm(root,{recursive:true,force:true});}
});
test('malformed persistence fails closed and an explicit allowance renewal is required to change saved limits',async()=>{
 assert.throws(()=>parseContinuation({...state(),attempts:3}),/Invalid/);
 assert.throws(()=>parseContinuation({...state(),checkRequestBase:-1}),/Invalid/);
 const root=await mkdtemp(path.join(os.tmpdir(),'continue-limits-')),project=root+'/app';await mkdir(project);
 try{
  await writeFile(project+'/features.json',JSON.stringify([{id:'author',title:'Author',priority:'must',status:'todo',dependsOn:[],criteria:['one']} ]));
  await saveContinuation(project,{...state(),checkLimits:{maxRequests:3,maxSeconds:600,requestSeconds:180}});
  await assert.rejects(continueCommand(project,['author','--max-builds','3'],{write:()=>{},ask:async()=>assert.fail()}),/--renew/);
  assert.equal((await readContinuation(project))!.maxBuilds,2);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('expired saved preparation allowance pauses without a model, and repeated continuation cannot renew it',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'continue-deadline-')),project=root+'/app';await mkdir(project);
 try{
  await writeFile(project+'/features.json',JSON.stringify([{id:'author',title:'Author',priority:'must',status:'todo',dependsOn:[],criteria:['one']} ]));
  const saved={...state(),checkLimits:{maxRequests:3,maxSeconds:600,requestSeconds:180},checkRequestBase:0,checkDeadline:Date.now()-1000};
  await saveContinuation(project,saved);
  const io={write:()=>{},ask:async()=>assert.fail('no approval prompt')};
  await continueCommand(project,['author'],io);await continueCommand(project,['author'],io);
  const actual=(await readContinuation(project))!;assert.equal(actual.status,'paused');assert.equal(actual.checkDeadline,saved.checkDeadline);assert.equal(actual.attempts,0);
  await assert.rejects(readFile(project+'-harness/acceptance/workflow.json'),/ENOENT/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('valid existing task IDs and oversized diagnoses remain readable through bounded persistence',async()=>{
 const s={...state(),task:'Story_Core.v1'};
 await driveContinuation(s,{snapshot:async()=>({done:false,checks:'blocked',reason:'x'.repeat(40000)}),prepare:async()=>assert.fail(),review:async()=>assert.fail(),build:async()=>assert.fail(),save:async s=>{parseContinuation(s);},write:()=>{}});
 assert.equal(s.message.length,10000);assert.equal(s.events[0]!.message.length,4000);assert.equal(s.status,'attention');
});

test('staged delivery pauses for final review and repeated continuation never rebuilds it',async()=>{
 let candidate=false,builds=0;const s=state(),services:ContinueServices={snapshot:async()=>({done:false,checks:'approved',...(candidate?{stage:'r12'}:{})}),prepare:async()=>assert.fail(),review:async()=>assert.fail(),build:async()=>{builds++;candidate=true;},save:async()=>{},write:()=>{}};
 await driveContinuation(s,services);assert.equal(s.status,'approval');assert.match(s.message,/stage review r12/);await driveContinuation(s,services);assert.equal(builds,1);assert.equal(s.attempts,1);
});
