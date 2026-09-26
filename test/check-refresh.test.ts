import test from 'node:test';import assert from 'node:assert/strict';
import {assertOnlyCheckStepsChanged,checkRefresh} from '../src/workspace/check-refresh.ts';
import {approveChecks,type CheckManifest} from '../src/acceptance/checks.ts';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
const before:CheckManifest={version:1,cases:[{id:'check-a',tasks:['a'],contract:'same contract',steps:[{command:['node','-e','console.log(1)'],exitCode:0,stdout:'1\n'}]},{id:'check-b',tasks:['b'],steps:[{command:['node','-e','console.log(2)'],exitCode:0,stdout:'2\n'}]}]};
test('check refresh permits only this task’s executable steps',()=>{
 const next=structuredClone(before);next.cases[0]!.steps[0]!.command=['node','-e','console.log(3)'];next.cases[0]!.steps[0]!.stdout='3\n';assert.doesNotThrow(()=>assertOnlyCheckStepsChanged(before,next,'a'));
 for(const mutate of [(m:CheckManifest)=>{m.cases.pop();},(m:CheckManifest)=>{m.cases[0]!.contract='new';},(m:CheckManifest)=>{m.cases[0]!.tasks=['a','b'];},(m:CheckManifest)=>{m.cases[1]!.steps[0]!.stdout='changed';},(m:CheckManifest)=>{m.cases[0]!.id='changed';}]){const changed=structuredClone(before);mutate(changed);assert.throws(()=>assertOnlyCheckStepsChanged(before,changed,'a'),/Cannot refresh/);}
});
test('check refresh requires the intact archived approval',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'refresh-checks-')),project=path.join(root,'project'),draft=path.join(root,'draft.json');await mkdir(project);
 try {
  await writeFile(draft,JSON.stringify(before));const previous=await approveChecks(project,draft);
  const next=structuredClone(before);next.cases[0]!.steps[0]!.stdout='3\n';await writeFile(draft,JSON.stringify(next));const current=await approveChecks(project,draft);
  assert.equal((await checkRefresh(project,previous.digest,current,'a'))?.currentApprovalDigest,current.digest);
  const archive=path.join(root,'project-harness/acceptance/approvals',previous.digest+'.json');await writeFile(archive,JSON.stringify(next));await assert.rejects(checkRefresh(project,previous.digest,current,'a'),/archive changed/);
  await rm(archive);await assert.rejects(checkRefresh(project,previous.digest,current,'a'),/archive is missing/);
 }finally{await rm(root,{recursive:true,force:true});}
});
