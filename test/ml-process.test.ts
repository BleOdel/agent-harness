import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { init } from '../src/verbs/init.ts';
import { loadConfig } from '../src/config.ts';
import { approveMl, mlDirectory, modelContext, readMl, readMlState } from '../src/ml/store.ts';
import { trainMl, trainingJob, releaseMl } from '../src/ml/workflow.ts';
import { evaluateMl, exportModel } from '../src/ml/evaluation.ts';
import { runJob, requestCancel, releaseJob } from '../src/jobs/controller.ts';
import { artifactBytes, collectArtifacts, listArtifacts, putArtifact } from '../src/artifacts/store.ts';
import { readJob } from '../src/jobs/state.ts';
import { sourceFiles } from '../src/workspace/candidate.ts';
import { run } from '../src/run.ts';
import { csv, spec } from './ml-fixture.ts';
const options={skip:process.env.HARNESS_DOCKER&&process.env.HARNESS_PYTHON_IMAGE_ID?false:'configure Python Docker ML runner'};
async function fixture(action:(project:string,file:string,root:string,config:ReturnType<typeof loadConfig>)=>Promise<void>){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'ml-process-'))),project=path.join(root,'model');await mkdir(project);
 const previous=process.env.HARNESS_IMAGE_ID;process.env.HARNESS_IMAGE_ID=process.env.HARNESS_PYTHON_IMAGE_ID!;
 try{await init(project,['--python']);const file=path.join(root,'data.csv');await writeFile(file,csv());await action(project,file,root,loadConfig({...process.env,HARNESS_PROJECT:project}));}
 finally{if(previous===undefined)delete process.env.HARNESS_IMAGE_ID;else process.env.HARNESS_IMAGE_ID=previous;await rm(root,{recursive:true,force:true});}
}
test('Docker ML: train, fresh inference, host evaluation and safe export preserve source and provenance',options,async()=>fixture(async(project,file,root,config)=>{
 const before=await sourceFiles(project),a=await approveMl(project,file,spec);
 const initial=await trainingJob(project,a.id),trained=await runJob(project,initial.id,()=>{},config);assert.equal(trained.status,'succeeded',JSON.stringify(trained.events));
 const transient=await evaluateMl(project,a.id,undefined,{...config,dockerExecutable:'/missing-ml-test-docker'});assert.equal(transient.outcome,'failed');assert.equal(transient.retryable,true);assert.equal((await readMlState(project,a.id)).status,'evaluating');
 const result=await trainMl(project,a.id,()=>{},config);assert.equal(result.job.status,'succeeded',JSON.stringify(result.job.events));assert.equal(result.evaluation?.outcome,'passed',JSON.stringify(result.evaluation));
 assert.ok(result.evaluation.assessment!.rmse<0.01);assert.ok(result.evaluation.assessment!.relativeImprovement>0.99);
 const artifacts=await listArtifacts(project),raw=artifacts.find(a=>a.producer===result.job.id&&a.name==='model.json')!;assert.equal(raw.verification,'unverified');
 const state=await readMlState(project,a.id),model=artifacts.find(a=>a.id===state.modelArtifact)!;assert.equal(model.verification,'evaluation-passed');assert.equal(model.evaluation?.approval,a.digest);
 const destination=path.join(root,'export.json');await exportModel(project,a.id,destination);assert.equal(await readFile(destination,'utf8'),(await artifactBytes(project,raw.id)).toString());await assert.rejects(exportModel(project,a.id,destination),/exists/);
 assert.deepEqual(await sourceFiles(project),before);assert.deepEqual(await evaluateMl(project,a.id,undefined,config),result.evaluation);
 const alternative=JSON.parse((await artifactBytes(project,raw.id)).toString());alternative.bias+=1;const bad=await putArtifact(project,'other.json',Buffer.from(JSON.stringify(alternative)),{producer:result.job.id,input:result.job.source!.digest,environment:result.job.identity!,verification:'unverified'});
 await assert.rejects(evaluateMl(project,a.id,bad.id,config),/different model/);await assert.rejects(releaseJob(project,result.job.id),/ml release/);
 await releaseMl(project,a.id);await collectArtifacts(project);assert.deepEqual(await listArtifacts(project),[]);await assert.rejects(exportModel(project,a.id,path.join(root,'after.json')),/Only a model/);
}));
test('Docker ML: degraded models and mismatched preprocessing never earn evaluated provenance',options,async()=>fixture(async(project,file,_root,config)=>{
 for(const mode of ['degraded','preprocessing']){
  const a=await approveMl(project,file,spec),job=await trainingJob(project,a.id),finished=await runJob(project,job.id,()=>{},config);assert.equal(finished.status,'succeeded',JSON.stringify(finished.events));
  const model={...modelContext(a),version:1,kind:'linear-regression@1',completed:spec.epochs,weights:[0],bias:a.baseline};if(mode==='preprocessing')model.preprocessing={means:[-999],scales:[1]};
  const candidate=await putArtifact(project,'negative.json',Buffer.from(JSON.stringify(model)),{producer:job.id,input:finished.source!.digest,environment:finished.identity!,verification:'unverified'});
  const report=await evaluateMl(project,a.id,candidate.id,config);assert.equal(report.outcome,'failed');if(mode==='degraded')assert.equal(report.assessment?.relativeImprovement,0);else assert.match(report.reason!,/preprocessing/);
  assert.equal((await readMlState(project,a.id)).modelArtifact,undefined);assert.ok(!(await listArtifacts(project)).some(x=>x.producer===a.id&&x.verification==='evaluation-passed'));
 }
}));
test('Docker ML: cancelled training retains a domain-checked checkpoint and resumes in a fresh container',options,async()=>fixture(async(project,file,_root,config)=>{
 await writeFile(file,csv(10000));const a=await approveMl(project,file,{...spec,epochs:500}),data=await readMl(project,a.id),job=await trainingJob(project,a.id);
 let cancel:Promise<void>|undefined;let inspectionError:unknown;
 const first=await runJob(project,job.id,message=>{if(message.includes('Saved compatible checkpoint')&&!cancel)cancel=(async()=>{
  try{
   const active=await readJob(project,job.id);
   const inspected=await run(config.dockerExecutable,['inspect',active.container!],{timeoutMs:10000});assert.equal(inspected.code,0);
   const metadata=JSON.parse(inspected.stdout)[0];assert.equal(metadata.HostConfig.NetworkMode,'none');assert.ok(metadata.Mounts.every((m:{Source:string;RW:boolean})=>!m.RW&&!m.Source.includes('/ml/')&&!m.Source.includes('/pi-agent')));
   const check=await run(config.dockerExecutable,['exec',active.container!,'/usr/local/bin/python3','-I','-S','-c',"import json,pathlib; print(json.dumps({'request':json.loads(pathlib.Path('/work/.harness-ml-training.json').read_text()),'credentials':pathlib.Path('/pi-agent').exists()}))"],{timeoutMs:10000,maxOutputBytes:2*1024*1024});assert.equal(check.code,0);
   const observed=JSON.parse(check.stdout);assert.equal(observed.credentials,false);assert.deepEqual(observed.request.rows,data.train);assert.ok(!observed.request.rows.some((r:{id:string})=>a.dataset.holdoutIds.includes(r.id)));assert.deepEqual(Object.keys(observed.request).sort(),['baseline','context','rows']);
  }catch(error){inspectionError=error;}finally{await requestCancel(project,job.id);}
 })();},config);await cancel;if(inspectionError)throw inspectionError;
 assert.equal(first.status,'cancelled',JSON.stringify(first.events));assert.ok(first.checkpoint);assert.ok(first.completed!>0&&first.completed!<500);
 const checkpoint=JSON.parse((await artifactBytes(project,first.checkpoint!)).toString());assert.equal(checkpoint.payload.completed,first.completed);assert.equal(checkpoint.payload.approval,a.digest);
 const dir=await mlDirectory(project,a.id),held=await readFile(path.join(dir,'holdout.json'));await writeFile(path.join(dir,'holdout.json'),'[]');await assert.rejects(runJob(project,job.id,()=>{},config),/holdout changed/);await writeFile(path.join(dir,'holdout.json'),held);
 await writeFile(path.join(project,'leak.json'),JSON.stringify(data.holdout.slice(0,1)));await assert.rejects(runJob(project,job.id,()=>{},config),/holdout/);await rm(path.join(project,'leak.json'));
 const resumed=await trainMl(project,a.id,()=>{},config);assert.equal(resumed.job.status,'succeeded',JSON.stringify(resumed.job.events));assert.equal(resumed.job.attempts,2);assert.equal(resumed.evaluation?.outcome,'passed',JSON.stringify(resumed.evaluation));
 const logs=(await listArtifacts(project)).filter(x=>x.producer===job.id&&x.name==='job-log.txt');assert.ok((await Promise.all(logs.map(async x=>(await artifactBytes(project,x.id)).toString()))).some(x=>x.includes(`Starting from epoch ${first.completed}`)));
 assert.equal((await run(config.dockerExecutable,['ps','-aq','--filter',`label=harness.job=${job.id}`],{timeoutMs:10000})).stdout.trim(),'');
}));
