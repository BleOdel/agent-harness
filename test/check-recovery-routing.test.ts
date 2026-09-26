import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,readFile,writeFile,readdir,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import {parseProposal,taskDigest} from '../src/acceptance/draft.ts';import {scopeDigest} from '../src/acceptance/scoped-review.ts';import {sourceFiles} from '../src/workspace/candidate.ts';import {readGuidedDraft,simplifySavedCheck} from '../src/acceptance/guided.ts';import {checkRequestBudget,withCheckBudget,CheckBudgetExceeded} from '../src/acceptance/budget.ts';import {checkWorkflowStatus} from '../src/acceptance/workflow.ts';
const task={id:'reader',title:'Reader',status:'todo' as const,priority:'must' as const,dependsOn:[],criteria:['Keep private fields private.']};
const pass={verdict:'pass' as const,issues:[],limitations:[]};
async function fixture(action:(project:string,dir:string,raw:string)=>Promise<void>){
 const root=await mkdtemp(path.join(os.tmpdir(),'recovery-routing-')),project=path.join(root,'project'),dir=project+'-harness/acceptance';await mkdir(project);await mkdir(dir,{recursive:true});
 try{await writeFile(path.join(project,'package.json'),'{"type":"module"}');await writeFile(path.join(project,'features.json'),JSON.stringify([task]));
 const proposal=parseProposal({version:1,contract:'Saved private API.',coverage:[{criterion:1,cases:['privacy']}],manifest:{version:1,cases:[{id:'privacy',tasks:[task.id],description:'Observe privacy.',steps:[{command:['node','-e','console.log(1)'],exitCode:0,stdout:'1\n'}]}]}},task);
 const sourceDigest=createHash('sha256').update(JSON.stringify(Object.entries(await sourceFiles(project,'',['node_modules'])).sort(([a],[b])=>a.localeCompare(b)))).digest('hex');
 const raw=JSON.stringify({version:1,taskId:task.id,taskDigest:taskDigest(task),sourceDigest,proposal,ledger:{version:1,entries:[{scope:'privacy',digest:scopeDigest(task,proposal,'privacy'),repairs:0,syntaxRepairs:0,review:{verdict:'repair',issues:['Oversized behaviour'],limitations:[]}}]}});await writeFile(path.join(dir,'review-progress.json'),raw);await action(project,dir,raw);
 }finally{await rm(root,{recursive:true,force:true});}
}
test('an older task draft cannot mask fresh preparation for the current task',()=>fixture(async(project,dir,raw)=>{
 await writeFile(path.join(dir,'guided-draft.json'),JSON.stringify({version:1,taskId:'older-service',inputDigest:'old',sourceDigest:'old'}));
 assert.equal(await readGuidedDraft(project,true),undefined);
 assert.equal(await readFile(path.join(dir,'review-progress.json'),'utf8'),raw);
 const record=JSON.parse(raw);await writeFile(path.join(dir,'guided-draft.json'),JSON.stringify({version:1,taskId:task.id,inputDigest:record.taskDigest,sourceDigest:record.sourceDigest,proposal:record.proposal,manifest:record.proposal.manifest}));
 assert.equal((await readGuidedDraft(project,true))!.taskId,task.id);
}));
test('direct simplification has an auditable command allowance and keeps the original draft on pause',()=>fixture(async(project,dir,raw)=>{
 const lines:string[]=[],io={write:(s:string)=>lines.push(s),ask:async()=>{throw Error('explicit id');}};
 const factory:Parameters<typeof simplifySavedCheck>[3]=(_p,_t,_proposal,_scope,_findings,save)=>({plan:async()=>{const request=await checkRequestBudget(900000);assert.ok(request.timeoutMs<=1000);return {cases:[{description:'Read public fields.'},{description:'Inspect private fields.'}],limitations:[]};},reviewOutline:async()=>{throw Error('must pause before review');},generate:async()=>{throw Error('must not generate');},syntax:async()=>[],review:async()=>pass,repair:async()=>{throw Error('must not repair');},save});
 await assert.rejects(simplifySavedCheck(project,io,'privacy',factory,{maxRequests:1,maxSeconds:10,requestSeconds:1}),(error:any)=>/request or time limit/.test(error.message)&&/checks simplify privacy/.test(error.remedy));
 assert.equal(await readFile(path.join(dir,'review-progress.json'),'utf8'),raw);
 const runs=await readdir(path.join(dir,'simplification-runs'));assert.equal(runs.length,1);
 const audit=JSON.parse(await readFile(path.join(dir,'simplification-runs',runs[0]!),'utf8'));assert.equal(audit.spend.requests,1);assert.equal(audit.status,'paused');
 const pending=JSON.parse(await readFile(path.join(dir,'simplification.json'),'utf8'));assert.equal(pending.state.outlineReviewAttempts??0,0);
 await checkWorkflowStatus(project,s=>lines.push(s));assert.match(lines.join('\n'),/Simplification.*privacy/);assert.match(lines.join('\n'),/1\/1 requests/);
}));
test('simplification reuses a parent allowance instead of resetting the request limit',()=>fixture(async(project,dir)=>{
 const spend={requests:0},io={write:(_s:string)=>{},ask:async()=>{throw Error('explicit id');}};
 const factory:Parameters<typeof simplifySavedCheck>[3]=(_p,_t,_proposal,_scope,_findings,save)=>({plan:async()=>{await checkRequestBudget(1000);return {cases:[{description:'A'},{description:'B'}],limitations:[]};},reviewOutline:async()=>{throw Error('must pause');},generate:async()=>{throw Error('must pause');},syntax:async()=>[],review:async()=>pass,repair:async()=>{throw Error('must pause');},save});
 await assert.rejects(withCheckBudget({maxRequests:1,maxSeconds:10,requestSeconds:1},spend,async()=>{},()=>{},()=>simplifySavedCheck(project,io,'privacy',factory)),CheckBudgetExceeded);
 assert.equal(spend.requests,1);await assert.rejects(readdir(path.join(dir,'simplification-runs')),{code:'ENOENT'});
}));
