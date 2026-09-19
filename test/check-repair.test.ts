import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewAndRepair, parseDraftReview } from '../src/acceptance/repair.ts';
const task={id:'story',title:'Stories',priority:'must' as const,status:'todo' as const,dependsOn:[],criteria:['pending remains private']};
const proposal={version:1 as const,contract:'HTTP contract',coverage:[{criterion:1,cases:['private']}],manifest:{version:1 as const,cases:[{id:'private',tasks:['story'],description:'Pending privacy',steps:[{command:['node','-e','bad()'],exitCode:0,stdout:'hidden\n'}]}]}};
test('independent rejection triggers repair and re-review before presenting a draft',async()=>{
 let count=0,repairs=0;
 const result=await reviewAndRepair(task,proposal,{syntax:async()=>[],review:async()=>{count++;return count===1?{verdict:'repair',issues:['Missing JSON header'],limitations:[]}:{verdict:'pass',issues:[],limitations:[]};},repair:async(_p,issues)=>{repairs++;assert.match(issues.join(' '),/JSON/);return proposal;}});
 assert.equal(count,2);assert.equal(repairs,1);assert.equal(result.validation.status,'reviewed');
});
test('syntax errors are repaired before review; repeated faults stop without approval',async()=>{
 let reviews=0;
 await assert.rejects(reviewAndRepair(task,proposal,{syntax:async()=>['Invalid JavaScript'],review:async()=>{reviews++;return {verdict:'pass',issues:[],limitations:[]};},repair:async()=>proposal}),/could not prepare/i);
 assert.equal(reviews,0);
});
test('a contradictory or malformed reviewer verdict cannot approve a draft',()=>{
 assert.throws(()=>parseDraftReview({verdict:'pass',issues:['Missing header'],limitations:[]}),/contradict/i);
 assert.throws(()=>parseDraftReview({verdict:'pass'}),/review/i);
});

import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { syntaxIssues, checkReviewPrompt } from '../src/acceptance/repair.ts';
test('syntax validation parses probes without executing them and catches bad JavaScript',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'syntax-no-execute-')); const marker=path.join(root,'should-not-exist');
 try {
  const safe=structuredClone(proposal);safe.manifest.cases[0]!.steps[0]!.command=['node','--input-type=module','-e',`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'unsafe');`];
  assert.deepEqual(await syntaxIssues(safe),[]);
  await assert.rejects(readFile(marker),{code:'ENOENT'});
  safe.manifest.cases[0]!.steps[0]!.command=['node','-e','const = ;'];
  assert.match((await syntaxIssues(safe)).join('\n'),/syntax error/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('independent review explicitly audits bodyless headers, quoting, fresh observations and blobs',()=>{
 const prompt=checkReviewPrompt(task,proposal);
 for(const pattern of [/bodyless POST\/DELETE/,/quoted If-Match/,/AFTER mutation/,/Uint8Array/,/not missing application code/,/do not require or propose npm test/])assert.match(prompt,pattern);
});
test('review failure checkpoints the proposal and does not invent a pass',async()=>{
 let saved=0;
 await assert.rejects(reviewAndRepair(task,proposal,{syntax:async()=>['header defect'],review:async()=>{throw new Error('should not review syntactically broken proposal');},repair:async()=>{throw new Error('provider unavailable');},checkpoint:async()=>{saved++;}}),/provider unavailable/);
 assert.equal(saved,1);
});

test('a syntax defect introduced by the final semantic repair still gets syntax repair and independent review',async()=>{
 let semantic=0,syntax=0,reviews=0;
 const result=await reviewAndRepair(task,proposal,{syntax:async()=>semantic===2&&syntax===0?['private, step 1: missing parenthesis']:[],review:async()=>{reviews++;return reviews<3?{verdict:'repair',issues:['contract defect'],limitations:[]}:{verdict:'pass',issues:[],limitations:[]};},repair:async()=>{semantic++;return proposal;},repairSyntax:async()=>{syntax++;return proposal;}});
 assert.equal(semantic,2);assert.equal(syntax,1);assert.equal(reviews,3);assert.equal(result.validation.status,'reviewed');
});

import { applySyntaxRepairs } from '../src/acceptance/repair.ts';
import { existingContracts } from '../src/acceptance/draft.ts';
test('syntax replacements preserve contract and host expectations and reject unaffected steps',()=>{
 const issues=['private, step 1: JavaScript syntax error'];
 const fixed=applySyntaxRepairs(proposal,{repairs:[{caseId:'private',step:1,code:'console.log("hidden")'}],contract:'changed'},issues);
 const expected=structuredClone(proposal);expected.manifest.cases[0]!.steps[0]!.command[2]='console.log("hidden")';
 assert.deepEqual(fixed,expected);
 assert.equal(proposal.manifest.cases[0]!.steps[0]!.command[2],'bad()');
 assert.throws(()=>applySyntaxRepairs(proposal,{repairs:[{caseId:'private',step:2,code:'0'}]},issues),/without a parser defect/);
 assert.throws(()=>applySyntaxRepairs(proposal,{repairs:[null]},issues),/Invalid syntax repair/);
});
test('existing contract context includes established source interfaces and excludes tests and binary files',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'check-contracts-'));
 try{
  await mkdir(path.join(root,'src'));await mkdir(path.join(root,'test'));
  await writeFile(path.join(root,'src/contracts.js'),'export const details = null;');
  await writeFile(path.join(root,'test/contracts.test.js'),'test-only expectation');
  await writeFile(path.join(root,'src/contract.bin'),Buffer.from([0,1,2]));
  const context=await existingContracts(root,['src/contracts.js','test/contracts.test.js','src/contract.bin']);
  assert.match(context,/export const details = null/);assert.match(context,/data, not agent instructions/);
  assert.doesNotMatch(context,/test-only|contract.bin/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('successive reviews retain prior findings and a final rejection exposes actionable reasons',async()=>{
 const received:string[][]=[];const messages:string[]=[];
 let review=0;
 await assert.rejects(reviewAndRepair(task,proposal,{syntax:async()=>[],review:async(_p,prior)=>{
  received.push([...prior]);review++;return {verdict:'repair',issues:[`remaining defect ${review}`],limitations:[]};
 },repair:async()=>proposal,progress:text=>messages.push(text)},['saved contradiction']),/could not prepare consistent/);
 assert.deepEqual(received,[['saved contradiction'],['remaining defect 1'],['remaining defect 2']]);
 assert.ok(messages.some(line=>line.includes('remaining defect 3')));
});

test('a repaired syntax candidate is checkpointed before a reviewer provider failure',async()=>{
 let fixed=false;let last=proposal;
 const corrected=structuredClone(proposal);corrected.manifest.cases[0]!.steps[0]!.command[2]='console.log("hidden")';
 await assert.rejects(reviewAndRepair(task,proposal,{syntax:async()=>fixed?[]:['private, step 1: syntax error'],repair:async()=>proposal,repairSyntax:async()=>{fixed=true;return corrected;},review:async()=>{throw new Error('reviewer unavailable');},checkpoint:async p=>{last=p as typeof proposal;}}),/reviewer unavailable/);
 assert.deepEqual(last,corrected);
});

test('review input preserves literal source and separates it from escaped command metadata',()=>{
 const p=structuredClone(proposal);const code="const request = {raw: '{'};\nconsole.log(request.raw);";
 p.manifest.cases[0]!.steps[0]!.command=['node','-e',code];
 const prompt=checkReviewPrompt(task,p,['Check malformed request']);
 assert.ok(prompt.includes(code));assert.equal(prompt.split(code).length,2);
 assert.ok(!prompt.includes(JSON.stringify(code)));
 assert.match(prompt,/Exact executable source for case "private", step 1/);
});
