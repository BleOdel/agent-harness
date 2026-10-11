import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {approveTorch,readTorch} from '../src/torch/store.ts';import {TORCH_COMMAND} from '../src/torch/recipe.ts';
import {createJob,saveJob,readJob} from '../src/jobs/state.ts';import {retainCheckpoint} from '../src/jobs/checkpoints.ts';
import {beginRecoveryEvidence,updateRecoveryEvidence} from '../src/jobs/recovery-evidence.ts';import {run} from '../src/run.ts';
const image=process.env.HARNESS_TORCH_TEST_IMAGE;
for(const kind of ['classifier','kmeans'])test(`PyTorch Docker: ${kind} interrupted state equals uninterrupted state; invalid late state cannot promote`,{skip:!image},async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'torch-promotion-'))),project=root+'/app';try{
 await mkdir(project);await writeFile(project+'/pyproject.toml','[project]\nname="checkpoint"\n');await mkdir(root+'/input');await mkdir(root+'/output');
 const file=root+'/data.json';await writeFile(file,JSON.stringify({features:['x','y'],rows:Array.from({length:50},(_,i)=>({id:`r${i}`,x:[i/20,(i%7)/7],...(kind==='classifier'?{y:Number(i>=25)}:{})}))}));
 const spec={version:1,title:'CPU promotion trial',kind,seed:42,steps:45,learningRate:0.01,batchSize:7,clusters:2,maxError:0.2,limits:{timeoutSeconds:60,totalSeconds:180,maxAttempts:3}};
 const a=await approveTorch(project,file,spec,image!),{train}=await readTorch(project,a.id);
 await writeFile(root+'/input/config.json',JSON.stringify({context:a.digest,spec:a.spec,rows:train,means:a.means,scales:a.scales}));
 const j=await createJob(project,{version:1,title:a.spec.title,command:TORCH_COMMAND,outputs:['model.json'],recipe:{id:'torch-cpu',version:1,approvalId:a.id,approvalDigest:a.digest},checkpoint:{protocol:'json-step@1',total:a.spec.steps},limits:a.spec.limits});Object.assign(j,{identity:'b'.repeat(64),source:{digest:'c'.repeat(64)},image,attempts:1,status:'running'});await saveJob(project,j,'running','Bounded CPU fixture');await beginRecoveryEvidence(project,j);
 const r=await run(process.env.HARNESS_DOCKER??'docker',['run','--rm','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--cpus=2','--memory=2g','--pids-limit=256','--tmpfs','/tmp:rw,size=64m','--mount',`type=bind,src=${path.resolve('src/torch')},dst=/recipe,readonly`,'--mount',`type=bind,src=${path.resolve('test/fixtures/torch')},dst=/trial,readonly`,'--mount',`type=bind,src=${root}/input,dst=/input,readonly`,'--mount',`type=bind,src=${root}/output,dst=/output`,image!,'timeout','60','python3','-I','/trial/retention-trial.py',j.identity!],{timeoutMs:75000,maxOutputBytes:65536});assert.equal(r.code,0,r.stderr);assert.equal(r.timedOut,false);
 const partial=await readFile(root+'/output/partial.json');await retainCheckpoint(project,j,partial);const prior=await readJob(project,j.id),bad=JSON.parse(await readFile(root+'/output/resumed.json','utf8'));
 if(kind==='classifier')bad.payload.optimizer.dict[0][1].dict=[];else bad.payload.centers=[];
 await assert.rejects(retainCheckpoint(project,j,Buffer.from(JSON.stringify(bad))),/checkpoint/);assert.deepEqual(await readJob(project,j.id),prior);
 j.status='interrupted';await updateRecoveryEvidence(project,j,true,true);await saveJob(project,j,'interrupted','Checkpoint-bound interruption');j.attempts=2;j.status='running';await beginRecoveryEvidence(project,j);
 const resumed=await readFile(root+'/output/resumed.json');assert.deepEqual(JSON.parse(resumed.toString()),JSON.parse(await readFile(root+'/output/full.json','utf8')));await retainCheckpoint(project,j,resumed);j.status='succeeded';await updateRecoveryEvidence(project,j,true,true);
 const link=JSON.parse(await readFile(project+'-harness/jobs/'+j.id+'/recovery/attempt-2.json','utf8'));assert.equal(link.input,prior.checkpoint);assert.equal(link.from,21);assert.equal(link.to,45);assert.equal(link.output,j.checkpoint);assert.equal(link.cleaned,true);
 }finally{await rm(root,{recursive:true,force:true});}
});
