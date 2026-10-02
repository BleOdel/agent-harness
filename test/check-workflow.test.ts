import test from 'node:test';import assert from 'node:assert/strict';
import {driveCheckWorkflow,type WorkflowState} from '../src/acceptance/workflow.ts';
import {ScopeRepairBlocked} from '../src/acceptance/scoped-review.ts';
import {CheckBudgetExceeded} from '../src/acceptance/budget.ts';
const state=():WorkflowState=>({version:1,retried:[],runs:[]});
test('one command repairs an exhausted scope once, resumes and saves ready without approval',async()=>{
 let ready=false,resumes=0,repairs=0,saves=0;const s=state();
 const result=await driveCheckWorkflow(s,{snapshot:async()=>({key:'task:source',ready}),resume:async()=>{resumes++;if(!repairs)throw new ScopeRepairBlocked('one','bad check');ready=true;},repair:async scope=>{assert.equal(scope,'one');repairs++;},save:async()=>{saves++;},write:()=>{}});
 assert.equal(result,'ready');assert.equal(resumes,2);assert.equal(repairs,1);assert.ok(saves>0);assert.deepEqual(s.retried,['task:source:one']);
});
test('exhausted repairs are not renewed indefinitely across resumes',async()=>{
 const s=state();let repairs=0;
 const services={snapshot:async()=>({key:'task:source',ready:false}),resume:async()=>{throw new ScopeRepairBlocked('one','still broken');},repair:async()=>{repairs++;throw new ScopeRepairBlocked('one','still broken');},save:async()=>{},write:()=>{}};
 assert.equal(await driveCheckWorkflow(s,services),'blocked');assert.equal(await driveCheckWorkflow(s,services),'blocked');assert.equal(repairs,1);
});
test('budget pause and provider failure preserve completed work and do not start repair retries',async()=>{
 for(const error of [new CheckBudgetExceeded(),new Error('provider unavailable')]){
  let repairs=0;const s=state();const result=await driveCheckWorkflow(s,{snapshot:async()=>({key:'task:source',ready:false}),resume:async()=>{throw error;},repair:async()=>{repairs++;},save:async()=>{},write:()=>{}});
  assert.equal(result,error instanceof CheckBudgetExceeded?'paused':'blocked');assert.equal(repairs,0);
 }
});
test('ready drafts make no preparation or model requests',async()=>{
 assert.equal(await driveCheckWorkflow(state(),{snapshot:async()=>({key:'task:source',ready:true}),resume:async()=>assert.fail('ready'),repair:async()=>assert.fail('ready'),save:async()=>{},write:()=>{}}),'ready');
});
import {withCheckBudget,checkRequestBudget} from '../src/acceptance/budget.ts';
test('a pause between retry reservation and renewal resumes the same grant exactly once',async()=>{
 const s=state();let now=0,ready=false,repairs=0,reserved=false;
 const services={snapshot:async()=>({key:'task:source',ready}),resume:async()=>{if(!repairs)throw new ScopeRepairBlocked('one','needs retry');ready=true;},repair:async()=>{repairs++;},save:async()=>{if(s.pendingRetry&&!reserved){reserved=true;now=2000;}},write:()=>{}};
 assert.equal(await withCheckBudget({maxRequests:2,maxSeconds:1,requestSeconds:1},{requests:0},async()=>{},()=>{},()=>driveCheckWorkflow(s,services),()=>now),'paused');
 assert.equal(repairs,0);assert.equal(s.retried.length,0);assert.ok(s.pendingRetry);
 assert.equal(await driveCheckWorkflow(s,services),'ready');assert.equal(repairs,1);
});
test('a pause after durable scope renewal resumes review without granting another renewal',async()=>{
 const s=state();let epoch=0,ready=false,repairs=0;
 const services={snapshot:async()=>({key:'task:source',ready,retryCounts:{one:epoch}}),resume:async()=>{if(!epoch)throw new ScopeRepairBlocked('one','needs retry');ready=true;},repair:async()=>{repairs++;epoch++;throw new CheckBudgetExceeded();},save:async()=>{},write:()=>{}};
 assert.equal(await driveCheckWorkflow(s,services),'paused');assert.ok(s.pendingRetry);
 assert.equal(await driveCheckWorkflow(s,services),'ready');assert.equal(repairs,1);assert.deepEqual(s.retried,['task:source:one']);
});

import {CheckRequestInterrupted} from '../src/acceptance/request-failure.ts';
test('a recognized transient preparation failure retries once inside the same allowance and survives resume',async()=>{
 const s=state();let resumes=0,ready=false,waits=0;
 const services={snapshot:async()=>({key:'task:source:stage',ready}),resume:async()=>{if(++resumes===1)throw new CheckRequestInterrupted('timeout','Timed out');ready=true;},repair:async()=>assert.fail(),save:async()=>{},write:()=>{},wait:async()=>{waits++;}};
 assert.equal(await driveCheckWorkflow(s,services),'ready');assert.equal(resumes,2);assert.equal(waits,1);
 ready=false;services.resume=async()=>{resumes++;throw new CheckRequestInterrupted('timeout','Timed out');};
 assert.equal(await driveCheckWorkflow(s,services),'paused');assert.equal(resumes,3);assert.equal(waits,1);
});
test('authentication, quota, output limits and unknown provider errors never automatically retry',async()=>{
 for(const e of [new CheckRequestInterrupted('provider','401 token expired'),new CheckRequestInterrupted('provider','429 insufficient_quota'),new CheckRequestInterrupted('output-limit','limit'),new CheckRequestInterrupted('provider','unknown')]){
  let calls=0;await driveCheckWorkflow(state(),{snapshot:async()=>({key:'task:source',ready:false}),resume:async()=>{calls++;throw e;},repair:async()=>assert.fail(),save:async()=>{},write:()=>{},wait:async()=>assert.fail()});assert.equal(calls,1);
 }
});

test('transient recovery cannot exceed the shared model-request budget',async()=>{
 const s=state(),spend={requests:0};let calls=0,waits=0;
 const result=await withCheckBudget({maxRequests:1,maxSeconds:30,requestSeconds:10},spend,async()=>{},()=>{},()=>driveCheckWorkflow(s,{
  snapshot:async()=>({key:'task:source',ready:false}),resume:async()=>{await checkRequestBudget(10000);calls++;throw new CheckRequestInterrupted('provider','HTTP 503');},repair:async()=>assert.fail(),save:async()=>{},write:()=>{},wait:async()=>{waits++;}
 }));assert.equal(result,'paused');assert.equal(calls,1);assert.equal(waits,0);assert.equal(spend.requests,1);
});
