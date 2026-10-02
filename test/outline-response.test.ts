import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,rm,writeFile,mkdir,utimes} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {retainedOutline} from '../src/acceptance/outline-response.ts';import {parseBlueprint} from '../src/acceptance/preparation.ts';import {readActivePreparation} from '../src/acceptance/active-preparation.ts';import {CheckRequestInterrupted} from '../src/acceptance/request-failure.ts';
const task={id:'author',title:'Write stories',status:'todo' as const,priority:'must' as const,dependsOn:[],criteria:['Submit a draft and preserve prose.']};
const good={version:1,contract:'POST /stories accepts title and body.',coverage:[{criterion:1,cases:['submit']}],cases:[{id:'submit',description:'Submit and read the pending story as its author.'}]};
const empty={...good,cases:[],coverage:[{criterion:1,cases:[],limitation:'Browser evidence is separate.'}]};
async function fixture(fn:(project:string)=>Promise<void>){const root=await mkdtemp(path.join(os.tmpdir(),'outline-response-')),p=root+'/app';await mkdir(p);try{await fn(p);}finally{await rm(root,{recursive:true,force:true});}}
test('empty outlines fail with an outline diagnostic rather than executable-manifest error',()=>{assert.throws(()=>parseBlueprint(empty,task),/one.*28.*behaviours/);});
test('invalid first outline is saved before correction; an interruption resumes it without regenerating',()=>fixture(async p=>{
 let calls=0;const request=async(prompt:string)=>{calls++;if(calls===1)return empty;assert.match(prompt,/Correct.*outline/);if(calls===2)throw new CheckRequestInterrupted('timeout','interrupted correction');return good;};
 await assert.rejects(retainedOutline(p,task,'original prompt','source',request,()=>{}),/interrupted correction/);
 const saved=JSON.parse(await readFile(p+'-harness/acceptance/outline-response.json','utf8'));assert.deepEqual(saved.raw,empty);
 assert.deepEqual(await retainedOutline(p,task,'original prompt','source',request,()=>{}),good);assert.equal(calls,3);
 await retainedOutline(p,task,'original prompt','source',async()=>{throw Error('No repeated model request');},()=>{});
}));
test('invalid correction stops after one usable attempt, preserving both replies and requiring explicit revision',()=>fixture(async p=>{
 let calls=0;const request=async()=>{calls++;return empty;};
 await assert.rejects(retainedOutline(p,task,'prompt','source',request,()=>{}),/outline.*invalid/i);assert.equal(calls,2);
 await assert.rejects(retainedOutline(p,task,'prompt','source',request,()=>{}),/outline.*invalid/i);assert.equal(calls,2);
 const saved=JSON.parse(await readFile(p+'-harness/acceptance/outline-response.json','utf8'));assert.equal(saved.replies.length,2);
 assert.deepEqual(await retainedOutline(p,task,'prompt with revision','source',async()=>good,()=>{}),good);
}));
test('changed source cannot reuse a previously valid outline',()=>fixture(async p=>{
 await retainedOutline(p,task,'prompt','old',async()=>good,()=>{});let called=false;
 await retainedOutline(p,task,'prompt','new',async()=>{called=true;return good;},()=>{});assert.equal(called,true);
}));
test('new author preparation supersedes old reader progress; later author reviews supersede preparation',()=>fixture(async p=>{
 const dir=p+'-harness/acceptance';await mkdir(dir,{recursive:true});await writeFile(dir+'/review-progress.json',JSON.stringify({taskId:'reader'}));await utimes(dir+'/review-progress.json',1,1);await writeFile(dir+'/preparation.json',JSON.stringify({taskId:'author'}));await utimes(dir+'/preparation.json',2,2);
 assert.equal(JSON.parse((await readActivePreparation(dir))!.raw).taskId,'author');await writeFile(dir+'/review-progress.json',JSON.stringify({taskId:'author',proposal:{}}));await utimes(dir+'/review-progress.json',3,3);assert.equal((await readActivePreparation(dir))!.name,'review-progress.json');
}));

import {withCheckBudget,CheckBudgetExceeded} from '../src/acceptance/budget.ts';
test('outline correction obeys the shared request allowance and resumes the retained initial reply',()=>fixture(async p=>{
 let calls=0;const request=async()=>{const {checkRequestBudget}=await import('../src/acceptance/budget.ts');await checkRequestBudget(30000);calls++;return calls===1?empty:good;};
 const run=()=>retainedOutline(p,task,'prompt','source',request,()=>{});
 await assert.rejects(withCheckBudget({maxRequests:1,maxSeconds:60,requestSeconds:30},{requests:0},async()=>{},()=>{},run),CheckBudgetExceeded);assert.equal(calls,1);
 assert.deepEqual(await withCheckBudget({maxRequests:1,maxSeconds:60,requestSeconds:30},{requests:0},async()=>{},()=>{},run),good);assert.equal(calls,2);
}));
