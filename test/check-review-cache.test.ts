import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {requestScopedReview} from '../src/acceptance/scoped-review.ts';import {parseProposal} from '../src/acceptance/draft.ts';import {withCheckBudget,checkRequestBudget,CheckBudgetExceeded} from '../src/acceptance/budget.ts';
const task={id:'app',title:'App',status:'todo' as const,priority:'must' as const,dependsOn:[],criteria:['Print a greeting.']};
const proposal=()=>parseProposal({version:1,contract:'node app.js prints Hello.',coverage:[{criterion:1,cases:['greet']}],manifest:{version:1,cases:[{id:'greet',tasks:['app'],description:'Print a greeting.',steps:[{command:['node','app.js'],exitCode:0,stdout:'Hello\n'}]}]}},task);
async function fixture(run:(project:string)=>Promise<void>){const root=await mkdtemp(path.join(os.tmpdir(),'review-cache-')),project=path.join(root,'app');await mkdir(project);await writeFile(path.join(project,'package.json'),'{"type":"module"}');try{await run(project);}finally{await rm(root,{recursive:true,force:true});}}
test('review response reuse is bound to source and exact prompt as well as check bytes',()=>fixture(async project=>{
 let calls=0;const request=async()=>{calls++;return {verdict:'pass',findings:[],limitations:[]};};
 const review=(prompt='review')=>requestScopedReview(project,task,proposal(),'greet',[],()=>{},prompt,request);
 await review();await review();assert.equal(calls,1);
 await writeFile(path.join(project,'contract.js'),'export const titleLimit=100;');await review();assert.equal(calls,2);
 await review('changed review context');assert.equal(calls,3);
}));
test('budget pause retains raw independent judgment and corrects only its references on resume',()=>fixture(async project=>{
 let calls=0;const request=async()=>{await checkRequestBudget(1000);calls++;return {verdict:'repair',findings:[{criterion:calls===1?'1':1,kind:'missing-observation',problem:'Missing check.',evidence:'Print a greeting.'}],limitations:[]};};
 const review=()=>withCheckBudget({maxRequests:1,maxSeconds:10,requestSeconds:1},{requests:0},async()=>{},()=>{},()=>requestScopedReview(project,task,proposal(),'greet',[],()=>{},'review',request));
 await assert.rejects(review(),CheckBudgetExceeded);assert.equal(calls,1);assert.equal((await review()).verdict,'repair');assert.equal(calls,2);await review();assert.equal(calls,2);
}));
