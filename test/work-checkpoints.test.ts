import {nextRunId} from '../src/record/record.ts';
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {captureBaseline,copySource} from '../src/workspace/candidate.ts';
import {saveWorkCheckpoint,findWorkCheckpoint,restoreWorkCheckpoint,retireWorkCheckpoint,assertCheckpointInputs} from '../src/workspace/work-checkpoints.ts';
async function fixture(run:(root:string,project:string,worker:string)=>Promise<void>){const root=await mkdtemp(path.join(os.tmpdir(),'work-checkpoint-')),project=path.join(root,'app'),worker=path.join(root,'worker');await mkdir(project);await writeFile(path.join(project,'a.js'),'original');await writeFile(path.join(project,'remove.js'),'old');await copySource(project,worker);try{await run(root,project,worker);}finally{await rm(root,{recursive:true,force:true});}}
const identity={goal:'service',workDigest:'a'.repeat(64),approvalDigest:'b'.repeat(64),executionDigest:'c'.repeat(64)};
test('timeout checkpoint restores additions, edits and deletions without claims, secrets or generated state',()=>fixture(async(root,project,worker)=>{
 const baseline=await captureBaseline(project,path.join(root,'baseline'));
 await writeFile(path.join(worker,'a.js'),'partial');await writeFile(path.join(worker,'new.js'),'new');await rm(path.join(worker,'remove.js'));await writeFile(path.join(worker,'.harness-claim.json'),'{unfinished');await writeFile(path.join(worker,'.env'),'private');await mkdir(path.join(worker,'node_modules'));await writeFile(path.join(worker,'node_modules','generated'),'dependency');
 const saved=await saveWorkCheckpoint(project,'r1',worker,{...identity,baseline,attempt:2,instruction:'Keep the original goal and fix its tests.'});
 assert.equal(saved.attempt,2);assert.equal(saved.instruction,'Keep the original goal and fix its tests.');assert.equal(await readFile(path.join(project,'a.js'),'utf8'),'original');
 await rm(worker,{recursive:true});const target=path.join(root,'fresh');await copySource(project,target);await mkdir(path.join(target,'node_modules'));await writeFile(path.join(target,'node_modules','fresh'),'reinstalled');
 await restoreWorkCheckpoint(saved,target);assert.equal(await readFile(path.join(target,'a.js'),'utf8'),'partial');assert.equal(await readFile(path.join(target,'new.js'),'utf8'),'new');
 for(const name of ['remove.js','.harness-claim.json','.env'])await assert.rejects(readFile(path.join(target,name)),{code:'ENOENT'});
 assert.equal(await readFile(path.join(target,'node_modules','fresh'),'utf8'),'reinstalled');
 assert.equal(await nextRunId(project),'r2'); // Published source reserves its ID before record append.
 assert.equal((await findWorkCheckpoint(project,'service'))?.runId,'r1');await retireWorkCheckpoint(saved,'completed','r2');assert.equal(await findWorkCheckpoint(project,'service'),undefined);
}));
test('stale inputs and modified checkpoints are rejected; saved source is retained for inspection',()=>fixture(async(root,project,worker)=>{
 const baseline=await captureBaseline(project,path.join(root,'baseline'));const saved=await saveWorkCheckpoint(project,'r1',worker,{...identity,baseline,attempt:1,instruction:'Continue.'});
 assertCheckpointInputs(saved,{...identity,baseline});
 for(const changed of [{workDigest:'d'.repeat(64)},{approvalDigest:'d'.repeat(64)},{executionDigest:'d'.repeat(64)},{baseline:{...baseline,digest:'d'.repeat(64)}},{baseline:{...baseline,controls:'d'.repeat(64)}}])assert.throws(()=>assertCheckpointInputs(saved,{...identity,baseline,...changed}),/changed/);
 await writeFile(path.join(saved.directory,'source','a.js'),'tampered');await assert.rejects(restoreWorkCheckpoint(saved,path.join(root,'target')),/changed/);
 assert.equal(await readFile(path.join(saved.directory,'source','a.js'),'utf8'),'tampered');
}));
test('checkpoint capture rejects links and ignores incomplete publications and other tasks',()=>fixture(async(root,project,worker)=>{
 const baseline=await captureBaseline(project,path.join(root,'baseline'));await symlink(path.join(project,'a.js'),path.join(worker,'link'));await assert.rejects(saveWorkCheckpoint(project,'r1',worker,{...identity,baseline,attempt:1,instruction:'Continue.'}),/symlink/);
 assert.equal(await findWorkCheckpoint(project,'service'),undefined);await rm(path.join(worker,'link'));await saveWorkCheckpoint(project,'r2',worker,{...identity,baseline,attempt:1,instruction:'Continue.'});assert.equal(await findWorkCheckpoint(project,'different'),undefined);
 await assert.rejects(findWorkCheckpoint(project,'service','../r2'),/run id/);
}));

test('checkpoint restores file/directory replacements and keeps installed dependencies',()=>fixture(async(root,project,worker)=>{
 await mkdir(path.join(project,'directory'));await writeFile(path.join(project,'directory','old'),'old');
 await copySource(project,worker);const baseline=await captureBaseline(project,path.join(root,'baseline'));
 await rm(path.join(worker,'directory'),{recursive:true});await writeFile(path.join(worker,'directory'),'now a file');
 await rm(path.join(worker,'a.js'));await mkdir(path.join(worker,'a.js'));await writeFile(path.join(worker,'a.js','nested'),'now a directory');
 const saved=await saveWorkCheckpoint(project,'r1',worker,{...identity,baseline,attempt:1,instruction:'Continue.'});
 const target=path.join(root,'target');await copySource(project,target);await restoreWorkCheckpoint(saved,target);
 assert.equal(await readFile(path.join(target,'directory'),'utf8'),'now a file');assert.equal(await readFile(path.join(target,'a.js','nested'),'utf8'),'now a directory');
}));
