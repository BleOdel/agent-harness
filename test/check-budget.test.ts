import test from 'node:test';import assert from 'node:assert/strict';
import {withCheckBudget,checkRequestBudget,CheckBudgetExceeded} from '../src/acceptance/budget.ts';
test('budget reserves before dispatch, bounds in-flight timeout and keeps failures counted',async()=>{
 const state={requests:0};let now=1000,updates=0;
 await withCheckBudget({maxRequests:2,maxSeconds:10,requestSeconds:3},state,async()=>{updates++;},()=>{},async()=>{
  const a=await checkRequestBudget(900000);assert.equal(a.timeoutMs,3000);assert.equal(state.requests,1);
  now=9500;const b=await checkRequestBudget(900000);assert.equal(b.timeoutMs,1500);assert.equal(state.requests,2);
  await assert.rejects(checkRequestBudget(900000),CheckBudgetExceeded);
 },()=>now);
 assert.equal(updates,2);
});
test('elapsed limit prevents a provider call and absent budget preserves caller timeout',async()=>{
 let now=0;await withCheckBudget({maxRequests:2,maxSeconds:1,requestSeconds:1},{requests:0},async()=>{},()=>{},async()=>{
  now=1001;await assert.rejects(checkRequestBudget(3000),CheckBudgetExceeded);
 },()=>now);
 assert.equal((await checkRequestBudget(3000)).timeoutMs,3000);
});
import {describeCheckSpend,parseCheckLimits,type CheckSpend} from '../src/acceptance/budget.ts';import {emptyUsage} from '../src/agent/events.ts';
test('usage is incomplete after an interrupted dispatch and never reports missing usage as zero',async()=>{
 const spend:CheckSpend={requests:0};await withCheckBudget({maxRequests:3,maxSeconds:10,requestSeconds:1},spend,async()=>{},()=>{},async()=>{
  const first=await checkRequestBudget(1000);await first.record(emptyUsage(),false);assert.match(describeCheckSpend(spend),/tokens unavailable; cost unavailable; incomplete/);
  const second=await checkRequestBudget(1000);await second.record({...emptyUsage(),totalTokens:123,costUsd:0.01},true);await second.record({...emptyUsage(),totalTokens:123,costUsd:0.01},true);
  await checkRequestBudget(1000);
 });assert.equal(spend.reportedTokens,123);assert.equal(spend.reportedCostUsd,0.01);assert.equal(spend.recorded,2);assert.match(describeCheckSpend(spend),/incomplete/);
});
test('limits reject unknown, duplicate, missing and out-of-range values before any dispatch',()=>{
 assert.deepEqual(parseCheckLimits(['--max-requests','3','--max-seconds','60']),{maxRequests:3,maxSeconds:60,requestSeconds:180});
 for(const args of [['--max-requests'],['--max-requests','0'],['--max-seconds','9000'],['--max-requests','2','--max-requests','2'],['--unsafe','1']])assert.throws(()=>parseCheckLimits(args));
});
