import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {regressionTasks} from '../src/acceptance/regression.ts';import {approveChecks,requireChecks} from '../src/acceptance/checks.ts';import {taskDigest} from '../src/acceptance/draft.ts';
const feature=(id:string,dependsOn:string[]=[],status:'done'|'todo'='done')=>({id,title:id,status,priority:'must' as const,dependsOn,criteria:['Observe '+id]});
const features=[feature('runtime'),feature('service',['runtime']),feature('reader',['service'],'todo'),feature('unrelated')];
const check=(id:string)=>({id,tasks:[id],steps:[{command:['node','-e','console.log(1)'],exitCode:0,stdout:'1\n'}]});
const manifest={version:1 as const,cases:features.map(f=>check(f.id))};
test('acceptance regression scope includes approved transitive completed dependencies once',()=>{
 assert.deepEqual(regressionTasks(features,['reader'],manifest),['reader','service','runtime']);
 assert.deepEqual(regressionTasks(features,['reader','service'],manifest),['reader','service','runtime']);
 assert.deepEqual(regressionTasks(features,['reader'],{...manifest,cases:[check('reader'),check('runtime')]}),['reader','runtime']);
 assert.deepEqual(regressionTasks([features[0]!,feature('service',['runtime'],'todo'),features[2]!],['reader'],manifest),['reader']);
});
test('stale prerequisite approvals block dependent work rather than count as reused evidence',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'dependency-evidence-')),project=path.join(root,'app');await mkdir(project);
 try{
  await writeFile(path.join(project,'features.json'),JSON.stringify(features));
  const source=path.join(root,'checks.json'),pinned={...manifest,cases:manifest.cases.map(c=>({...c,taskDigest:taskDigest(features.find(f=>f.id===c.id)!)}))};
  await writeFile(source,JSON.stringify(pinned));await approveChecks(project,source);await requireChecks(project,['reader']);
  await writeFile(path.join(project,'features.json'),JSON.stringify(features.map(f=>f.id==='service'?{...f,criteria:['Changed service behaviour']}:f)));
  await assert.rejects(requireChecks(project,['reader']),/older requirements/);
 }finally{await rm(root,{recursive:true,force:true});}
});

import {assertAcceptanceProof} from '../src/acceptance/checks.ts';import {captureBaseline} from '../src/workspace/candidate.ts';import {randomUUID} from 'node:crypto';
test('a dependent application proof must include freshly executed prerequisite tasks',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'regression-proof-')),project=path.join(root,'app');await mkdir(project);
 try{
  await writeFile(path.join(project,'features.json'),JSON.stringify(features));await writeFile(path.join(project,'app.js'),'console.log(1)');
  const source=path.join(root,'checks.json');await writeFile(source,JSON.stringify(manifest));const approved=await approveChecks(project,source);
  const candidate=await captureBaseline(project,path.join(root,'baseline')),dir=(await realpath(project))+'-harness/acceptance/results';await mkdir(dir,{recursive:true});
  const proof={approvalDigest:approved.digest,candidateDigest:candidate.digest,evidencePath:path.join(dir,randomUUID()+'.json')};
  const base={version:1,project:await realpath(project),...proof,outcome:'passed'};
  await writeFile(proof.evidencePath,JSON.stringify({...base,tasks:['reader']}));await assert.rejects(assertAcceptanceProof(project,candidate,['reader'],proof),/does not cover/);
  await writeFile(proof.evidencePath,JSON.stringify({...base,tasks:['reader','service','runtime']}));await assertAcceptanceProof(project,candidate,['reader'],proof);
 }finally{await rm(root,{recursive:true,force:true});}
});

import {dependencyContext} from '../src/acceptance/dependency-context.ts';
test('outlining receives dependency regression descriptions without exposing executable checks',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'regression-context-')),project=path.join(root,'app');await mkdir(project);
 try{
  await writeFile(path.join(project,'features.json'),JSON.stringify(features));const source=path.join(root,'checks.json');await writeFile(source,JSON.stringify({...manifest,cases:manifest.cases.map(c=>({...c,description:'Observed '+c.id}))}));await approveChecks(project,source);
  const context=await dependencyContext(project,features[2]!);assert.match(context,/Observed service/);assert.match(context,/Observed runtime/);assert.doesNotMatch(context,/Observed unrelated|console\.log/);assert.match(context,/rerun on the new candidate/);
 }finally{await rm(root,{recursive:true,force:true});}
});
