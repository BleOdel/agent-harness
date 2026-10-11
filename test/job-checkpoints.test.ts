import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {createJob,saveJob,readJob} from '../src/jobs/state.ts';
import {retainCheckpoint,selectCheckpoint,retainedCheckpoint} from '../src/jobs/checkpoints.ts';
import {putArtifact,listArtifacts} from '../src/artifacts/store.ts';
import {approveTorch} from '../src/torch/store.ts';import {TORCH_COMMAND} from '../src/torch/recipe.ts';
import {beginRecoveryEvidence,updateRecoveryEvidence} from '../src/jobs/recovery-evidence.ts';
async function fixture(kind:string,fn:(f:any)=>Promise<void>){const root=await mkdtemp(path.join(os.tmpdir(),'job-checkpoints-')),project=root+'/app';await mkdir(project);try{
 await writeFile(project+'/pyproject.toml','[project]\nname="checkpoint"\n');const f=JSON.parse(await readFile(new URL(`./fixtures/torch/${kind}.json`,import.meta.url),'utf8'));
 const file=root+'/data.json';await writeFile(file,JSON.stringify({features:['x','y'],rows:Array.from({length:50},(_,i)=>({id:`r${i}`,x:[i,i%7],...(kind==='classifier'?{y:i%2}:{})}))}));
 const a=await approveTorch(project,file,f.binding.spec,'sha256:'+'a'.repeat(64));const j=await createJob(project,{version:1,title:kind,command:TORCH_COMMAND,outputs:['model.json'],recipe:{id:'torch-cpu',version:1,approvalId:a.id,approvalDigest:a.digest},checkpoint:{protocol:'json-step@1',total:a.spec.steps},limits:a.spec.limits});
 Object.assign(j,{identity:'b'.repeat(64),source:{digest:'c'.repeat(64)},attempts:1,status:'running',image:a.image});f.checkpoint.identity=j.identity;f.checkpoint.payload.context=a.digest;await saveJob(project,j,'running','Fixture host state');
 await fn({root,project,j,point:f.checkpoint,a});
 }finally{await rm(root,{recursive:true,force:true});}}
for(const kind of ['classifier','kmeans'])test(`${kind}: malformed late checkpoint leaves previous reference and bytes unchanged`,()=>fixture(kind,async({project,j,point}:any)=>{
 const bytes=Buffer.from(JSON.stringify(point));await retainCheckpoint(project,j,bytes);const prior=await readJob(project,j.id),artifacts=await listArtifacts(project);
 const broken=structuredClone(point);if(kind==='classifier')broken.payload.optimizer.dict[0][1].dict=[];else broken.payload.centers=[];
 await assert.rejects(retainCheckpoint(project,j,Buffer.from(JSON.stringify(broken))),/checkpoint/);
 assert.deepEqual(await readJob(project,j.id),prior);assert.equal(j.checkpoint,prior.checkpoint);assert.equal((await listArtifacts(project)).length,artifacts.length);assert.deepEqual((await retainedCheckpoint(project,j,prior.checkpoint!)).bytes,bytes);
 const other=structuredClone(point);other.identity='d'.repeat(64);await assert.rejects(retainCheckpoint(project,j,Buffer.from(JSON.stringify(other))),/incompatible/);assert.equal((await readJob(project,j.id)).checkpoint,prior.checkpoint);
}));
test('corrupt current checkpoint is refused; explicit validated older selection records provenance',()=>fixture('kmeans',async({project,j,point}:any)=>{
 await beginRecoveryEvidence(project,j);await retainCheckpoint(project,j,Buffer.from(JSON.stringify(point)));const first=j.checkpoint;
 const next=structuredClone(point);next.completed++;next.payload.completed++;next.payload.losses.push(1);await retainCheckpoint(project,j,Buffer.from(JSON.stringify(next)));const current=j.checkpoint;
 j.status='interrupted';await updateRecoveryEvidence(project,j,true,true);await saveJob(project,j,'interrupted','Stopped');
 const a=(await listArtifacts(project)).find(a=>a.id===current)!;await writeFile(project+'-harness/artifacts/blobs/'+a.sha256,'corrupt');
 await assert.rejects(retainedCheckpoint(project,j,current),/corrupt|mismatch/);assert.equal((await readJob(project,j.id)).checkpoint,current);
 await assert.rejects(selectCheckpoint(project,j.id,current),/corrupt|mismatch/);
 const selected=await selectCheckpoint(project,j.id,first);assert.equal(selected.checkpoint,first);assert.equal(selected.completed,point.completed);assert.equal(selected.attempts,1);
 assert.deepEqual(selected.checkpointSelections?.map((v:any)=>[v.previous,v.selected,v.completed,v.afterAttempt]),[[current,first,point.completed,1]]);
 selected.attempts=2;await beginRecoveryEvidence(project,selected);const attempt=JSON.parse(await readFile(project+'-harness/jobs/'+j.id+'/recovery/attempt-2.json','utf8'));assert.equal(attempt.input,first);assert.equal(attempt.from,point.completed);
}));
test('selection rejects foreign provenance, active jobs and unsupported payloads without changing progress',()=>fixture('classifier',async({project,j,point}:any)=>{
 await retainCheckpoint(project,j,Buffer.from(JSON.stringify(point)));await assert.rejects(selectCheckpoint(project,j.id,j.checkpoint),/active/);
 j.status='failed';await saveJob(project,j,'failed','Stopped');const before=await readJob(project,j.id);
 const foreign=await putArtifact(project,'checkpoint.json',Buffer.from(JSON.stringify(point)),{producer:'other-job',input:j.source.digest,environment:j.identity,verification:'unverified'});await assert.rejects(selectCheckpoint(project,j.id,foreign.id),/provenance/);
 const malformed=await putArtifact(project,'checkpoint.json',Buffer.from('{}'),{producer:j.id,input:j.source.digest,environment:j.identity,verification:'unverified'});await assert.rejects(selectCheckpoint(project,j.id,malformed.id),/incompatible/);assert.deepEqual(await readJob(project,j.id),before);
}));
