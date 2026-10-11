import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,readFile,rm,utimes} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {taskDigest} from '../src/acceptance/draft.ts';import {sourceFiles} from '../src/workspace/candidate.ts';import {scopeDigest} from '../src/acceptance/scoped-review.ts';import {repairSavedCheck} from '../src/acceptance/guided.ts';import {blueprintProposal} from '../src/acceptance/preparation.ts';import {readActivePreparation} from '../src/acceptance/active-preparation.ts';
const task={id:'author',title:'Author',status:'todo' as const,priority:'must' as const,dependsOn:[],criteria:['All four behaviours.']};
async function fixture(fn:(f:any)=>Promise<void>){const root=await mkdtemp(path.join(os.tmpdir(),'active-repair-')),project=root+'/app',dir=project+'-harness/acceptance';try{
 await mkdir(project);await mkdir(dir,{recursive:true});await writeFile(project+'/features.json',JSON.stringify([task]));
 const blueprint={version:1 as const,contract:'Fixed contract.',coverage:[{criterion:1,cases:['one','two','three','four']}],cases:['one','two','three','four'].map(id=>({id,description:id}))};
 const cases=blueprint.cases.slice(0,3).map(c=>({...c,tasks:[task.id],steps:[{command:['node','-e','console.log(1)'],exitCode:0,stdout:'1\n'}]}));const p=blueprintProposal(task,blueprint);p.manifest.cases=p.manifest.cases.map(c=>cases.find(v=>v.id===c.id)??c);
 const ledger={version:1,entries:cases.map(c=>({scope:c.id,digest:scopeDigest(task,p,c.id),repairs:c.id==='three'?2:0,syntaxRepairs:0,review:{verdict:c.id==='three'?'repair':'pass',issues:c.id==='three'?['broken check']:[],limitations:[]}}))};
 const sourceDigest=createHash('sha256').update(JSON.stringify(Object.entries(await sourceFiles(project,'',['node_modules'])).sort(([a],[b])=>a.localeCompare(b)))).digest('hex');const record={version:1,taskId:task.id,taskDigest:taskDigest(task),sourceDigest,operation:{id:'preparation-author',sequence:2},state:{version:1,blueprint,cases,reviewLedger:ledger}};
 await writeFile(dir+'/preparation.json',JSON.stringify(record));const old=JSON.stringify({...record,taskId:'reader',operation:{id:'old-reader',sequence:1},proposal:p,ledger});await writeFile(dir+'/review-progress.json',old);await utimes(dir+'/review-progress.json',4000000000,4000000000);
 await fn({project,dir,record,p,old});
 }finally{await rm(root,{recursive:true,force:true});}}
test('active task/operation defeats stale file timestamps and repairs generated third case in place',()=>fixture(async({project,dir,record,p,old}:any)=>{
 assert.equal((await readActivePreparation(dir))!.name,'preparation.json');let calls=0;
 await repairSavedCheck(project,{write:()=>{},ask:async()=>assert.fail()},'three',async(_project,_task,input,scope,ledger,save)=>{
 calls++;assert.equal(scope,'three');const reserved=JSON.parse(await readFile(dir+'/preparation.json','utf8'));assert.equal(reserved.state.reviewLedger.entries[2].retryCount,1);
 const next=structuredClone(input);next.manifest.cases[2]!.steps[0]!.command=['node','-e','console.log(2)'];next.manifest.cases[2]!.steps[0]!.stdout='2\n';ledger.entries[2]!.digest=scopeDigest(task,next,'three');ledger.entries[2]!.review={verdict:'pass',issues:[],limitations:[]};await save(next,ledger);return {proposal:next,ledger};
 });assert.equal(calls,1);const after=JSON.parse(await readFile(dir+'/preparation.json','utf8'));assert.equal(after.state.cases.length,3);assert.deepEqual(after.state.blueprint,record.state.blueprint);assert.deepEqual(after.state.cases.slice(0,2),record.state.cases.slice(0,2));assert.equal(after.state.reviewLedger.entries[2].review.verdict,'pass');assert.equal(await readFile(dir+'/review-progress.json','utf8'),old);
}));
test('interruption after retry reservation preserves the preparation owner and spent epoch',()=>fixture(async({project,dir}:any)=>{
 await assert.rejects(repairSavedCheck(project,{write:()=>{},ask:async()=>assert.fail()},'three',async()=>{throw Error('interrupted before dispatch');}),/interrupted/);
 const saved=JSON.parse(await readFile(dir+'/preparation.json','utf8'));assert.equal(saved.state.reviewLedger.entries[2].retryCount,1);assert.equal(saved.state.cases.length,3);assert.equal((await readActivePreparation(dir))!.name,'preparation.json');
}));

import {preparationProgress,driveCheckWorkflow,type WorkflowState} from '../src/acceptance/workflow.ts';
import {CheckRequestInterrupted} from '../src/acceptance/request-failure.ts';
import {ScopeRepairBlocked} from '../src/acceptance/scoped-review.ts';
test('workflow reconciles a preparation-owned durable retry after provider interruption without another grant',()=>fixture(async({project,dir}:any)=>{
 const state:WorkflowState={version:1,retried:[],runs:[]};let repairs=0,resumes=0;
 const snapshot=async()=>({...await preparationProgress(project),ready:false});
 const services={snapshot,save:async()=>{},write:()=>{},resume:async()=>{resumes++;throw new ScopeRepairBlocked('three','blocked');},repair:async()=>{repairs++;await repairSavedCheck(project,{write:()=>{},ask:async()=>assert.fail()},'three',async()=>{throw new CheckRequestInterrupted('provider','401 authentication required');});}};
 assert.equal(await driveCheckWorkflow(state,services),'paused');assert.equal(repairs,1);assert.ok(state.pendingRetry);
 const progress=await preparationProgress(project);assert.equal(progress.retryCounts.three,1);assert.deepEqual(progress.nextAction,{taskId:'author',operation:'preparation-author',phase:'review',source:'preparation.json',check:'three',command:'harness checks prepare'});
 assert.equal(await driveCheckWorkflow(state,services),'blocked');assert.equal(repairs,1);assert.equal(resumes,2);assert.equal(state.pendingRetry,undefined);assert.equal(state.retried.length,1);
 const saved=JSON.parse(await readFile(dir+'/preparation.json','utf8'));assert.equal(saved.state.reviewLedger.entries[2].repairs,0);assert.equal(saved.state.reviewLedger.entries[2].retryCount,1);
}));
import {preparationOperation} from '../src/acceptance/active-preparation.ts';
test('phase advancement shares operation identity while a fresh operation supersedes legacy and old phases',()=>fixture(async({dir,record}:any)=>{
 assert.deepEqual(await preparationOperation(dir,task.id,record.taskDigest,record.sourceDigest),record.operation);
 const next=await preparationOperation(dir,task.id,record.taskDigest,record.sourceDigest,true);assert.equal(next.sequence,3);assert.notEqual(next.id,record.operation.id);
 await writeFile(dir+'/review-progress.json',JSON.stringify({...record,operation:record.operation}));assert.equal((await readActivePreparation(dir))!.name,'review-progress.json');
 await writeFile(dir+'/preparation.json',JSON.stringify({...record,operation:next}));assert.equal((await readActivePreparation(dir))!.name,'preparation.json');
 await writeFile(dir+'/review-progress.json',JSON.stringify({...record,operation:{...next,id:'conflicting'}}));await assert.rejects(readActivePreparation(dir),/Conflicting/);
}));

import {executeWorkflowCommand} from '../src/workflow/commands.ts';
test('noninteractive repair API resumes the exact retained case without prompts or approval',()=>fixture(async({project,dir}:any)=>{
 const outcome=await executeWorkflowCommand(project,{command:'repair',args:['three','--task','author','--max-requests','1']},{json:true,emit:()=>{},services:{repair:async(p,io,id)=>repairSavedCheck(p,io,id,async(_p,_task,proposal,scope,ledger,save)=>{
  assert.equal(scope,'three');ledger.entries[2]!.review={verdict:'pass',issues:[],limitations:[]};await save(proposal,ledger);return {proposal,ledger};
 })}});
 assert.equal(outcome.outcome,'success');const after=JSON.parse(await readFile(dir+'/preparation.json','utf8'));
 assert.equal(after.state.reviewLedger.entries[2].review.verdict,'pass');assert.equal(after.state.cases.length,3);
 await assert.rejects(readFile(dir+'/approved.json'),{code:'ENOENT'});
}));
