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

import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
