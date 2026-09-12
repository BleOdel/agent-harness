import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { artifactBytes, ARTIFACT_LIMITS, putArtifact, readJson, saveJson, sha256, releaseArtifacts } from '../artifacts/store.ts';
import { getAdapter } from '../adapters/registry.ts';
import { loadConfig, type Config } from '../config.ts';
import { buildRunArguments, type SandboxLayout } from '../containment/sandbox.ts';
import { stopContainer } from '../containment/stop.ts';
import { executionLayout, inspectCapabilities } from '../project/execution.ts';
import { readProfile } from '../project/profile.ts';
import { run } from '../run.ts';
import { assertLiveBaseline, assertSnapshot, captureBaseline } from '../workspace/candidate.ts';
import { DEFAULT_INSTALL_POLICY } from '../workspace/dependencies.ts';
import { withWriter } from '../workspace/writer-lock.ts';
import { OperatorError } from '../verbs/io.ts';
import { validateCheckpoint } from './schema.ts';
import { jobRoot, listJobs, readJob, saveJob, type Job } from './state.ts';
const resources=import.meta.dirname;
const required=(message:string):never=>{throw new OperatorError(message);};
async function command(docker:string,args:string[],timeoutMs=10000,maxOutputBytes=2*1024*1024){return run(docker,args,{timeoutMs,maxOutputBytes});}
async function owned(j:Job):Promise<boolean>{
 if(!j.container)return false;
 if(!j.token||!j.docker||!/^harness-job-[a-f0-9-]{36}$/u.test(j.container))required('Job container ownership is incomplete.');
 const result=await command(j.docker!,['inspect',j.container]);
 if(result.code!==0){if(/no such (object|container)/iu.test(result.stderr))return false;required(`Cannot inspect owned job resources: ${result.stderr}`);}
 const metadata=JSON.parse(result.stdout)[0];
 if(metadata?.Config?.Labels?.['harness.job']!==j.id||metadata?.Config?.Labels?.['harness.token']!==j.token||metadata?.Image!==j.image)required('Container ownership mismatch; refusing to stop another resource.');return true;
}
async function transfer(j:Job,file:string,optional=false):Promise<Buffer|undefined>{
 const result=await command(j.docker!,['exec',j.container!,'node','/harness-instrumentation/transport.mjs',file],10000,Math.ceil(ARTIFACT_LIMITS.file*4/3)+4096);
 if(result.code!==0||result.timedOut||result.outputLimited){if(optional&&/ENOENT/u.test(result.stderr))return undefined;required(`Cannot collect ${file}: unsafe, oversized or unavailable output. ${result.stderr.slice(-500)}`);}
 if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(result.stdout))required('Invalid artifact transfer encoding.');
 return Buffer.from(result.stdout,'base64');
}
async function checkpoint(project:string,j:Job):Promise<void>{
 if(!j.spec.checkpoint)return;
 const bytes=await transfer(j,'.harness-output/checkpoint.json',true);if(!bytes)return;
 const point=validateCheckpoint(bytes,j.spec.checkpoint,j.identity!,j.completed??0);
 if(j.checkpoint&&point.completed===(j.completed??0))return;
 if(j.events.filter(e=>e.phase==='checkpoint').length>=100)required('Checkpoint retention limit reached (100 per job).');
 const artifact=await putArtifact(project,'checkpoint.json',bytes,{producer:j.id,input:j.source!.digest,environment:j.identity!,verification:'unverified'});
 j.checkpoint=artifact.id;j.completed=point.completed;await saveJob(project,j,'checkpoint',`Saved compatible checkpoint: ${point.completed}/${point.total} steps (reported by job).`);
}
async function stopOwned(j:Job):Promise<void>{if(await owned(j))await stopContainer(j.docker!,j.container!);}
async function requestMatches(root:string,j:Job):Promise<boolean>{try{const value=await readJson(root,'cancel.json') as {token:string};return value.token===j.token;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
export async function requestCancel(project:string,id:string):Promise<void>{
 const j=await readJob(project,id);if(!['preparing','running'].includes(j.status)||!j.token)required('This job is not running. Use resume to continue a stopped job.');await saveJson(await jobRoot(project,id),'cancel.json',{version:1,token:j.token});
}
/** Called under the project writer: live owners must first exit or be recovered by existing rules. */
export async function recoverJob(project:string,id:string):Promise<Job>{return withWriter(project,'job recover',async()=>{
 const j=await readJob(project,id);if(!['preparing','running'].includes(j.status))return j;
 if(await owned(j)){
  // Stop first: artifacts remain in tmpfs only while the supervisor is alive. Last
  // committed checkpoint survives even if the worker destroyed its own supervisor.
  await command(j.docker!,['kill','--signal=TERM',j.container!]);await delay(300);
  try{await checkpoint(project,j);}catch{/* Invalid latest output never replaces saved recovery evidence. */}
  await stopOwned(j);
 }
 await rm(path.join(await jobRoot(project,id),`input-${j.attempts}`),{recursive:true,force:true});
 await rm(path.join(await jobRoot(project,id),`environment-${j.attempts}`),{recursive:true,force:true});
 j.status='interrupted';delete j.container;await saveJob(project,j,'interrupted','Owned resources removed. Resume uses only a previously validated checkpoint.');return j;
});}
export async function releaseJob(project:string,id:string):Promise<void>{return withWriter(project,'job release',async()=>{
 const j=await readJob(project,id);if(['preparing','running'].includes(j.status))required('Cannot release an active job; cancel or recover it first.');
 if(await owned(j))required('Job resources still exist; recover them first.');
 j.status='released';delete j.checkpoint;j.artifacts=[];await saveJob(project,j,'released','Recovery outputs released. This job can no longer resume.');await releaseArtifacts(project,id,new Set());
 const root=await jobRoot(project,id);for(const name of ['source',...Array.from({length:8},(_,i)=>`environment-${i+1}`),...Array.from({length:8},(_,i)=>`input-${i+1}`)])await rm(path.join(root,name),{recursive:true,force:true});
});}
export async function runJob(project:string,id:string,notify:(message:string)=>void=()=>{},config=loadConfig({...process.env,HARNESS_PROJECT:project})):Promise<Job>{
 return withWriter(project,'job run',async()=>{
 const j=await readJob(project,id),root=await jobRoot(project,id);
 if((await listJobs(project)).some(other=>other.id!==id&&['preparing','running'].includes(other.status)))required('Another job has active or unreconciled resources. Recover it before starting another job.');
 if(['preparing','running'].includes(j.status))required('This job was interrupted or is active. Recover its writer and run harness job recover before resuming.');
 if(['succeeded','released'].includes(j.status))required(`Job is ${j.status}; create a new job to run again.`);
 if(j.attempts>=j.spec.limits.maxAttempts||j.reservedSeconds+j.spec.limits.timeoutSeconds>j.spec.limits.totalSeconds)required('Job dispatch budget exhausted. Saved artifacts remain available; create a new job with an explicit budget to run more.');
 const adapter=getAdapter((await readProfile(project)).adapter);
 // A retry always starts from an accepted checkpoint. It never silently restarts a partial job.
 if(j.attempts>0&&(!j.checkpoint||!j.spec.checkpoint))required('No compatible checkpoint is saved. Create a new job to start from the beginning.');
 if(j.source){if(j.source.directory!==path.join(root,'source'))required('Saved source location changed.');await assertSnapshot(j.source);await assertLiveBaseline(project,j.source);}
 const profile=await readProfile(project),capabilities=await inspectCapabilities(profile,config),policy=config.installPolicy??DEFAULT_INSTALL_POLICY;
 if(j.identity&&(JSON.stringify(profile)!==JSON.stringify(j.profile)||JSON.stringify(capabilities)!==JSON.stringify(j.capabilities)||JSON.stringify(policy)!==JSON.stringify(j.installPolicy)||config.dockerExecutable!==j.docker))required('Job environment or settings changed. Restore the original settings before resume.');
 let resume:Buffer|undefined;
 if(j.checkpoint){resume=await artifactBytes(project,j.checkpoint);validateCheckpoint(resume,j.spec.checkpoint!,j.identity!,j.completed??0);}
 if(!j.source){await rm(path.join(root,'source'),{recursive:true,force:true});j.source=await captureBaseline(project,path.join(root,'source'),adapter.source.generatedDirectories);}
 j.profile=profile;j.capabilities=capabilities;j.image=config.imageId;j.docker=config.dockerExecutable;j.installPolicy=policy;
 j.status='preparing';j.token=randomUUID();j.attempts++;j.reservedSeconds+=j.spec.limits.timeoutSeconds;
 await saveJob(project,j,'preparing',`Preparing attempt ${j.attempts}/${j.spec.limits.maxAttempts}. Execution reservation ${j.reservedSeconds}/${j.spec.limits.totalSeconds}s; compute cost unknown.`);
 notify(j.events.at(-1)!.message);
 let interrupted=false,started=0;const signal=()=>{interrupted=true;};process.on('SIGINT',signal);process.on('SIGTERM',signal);
 const layout:SandboxLayout={...executionLayout(config,path.join(root,`input-${j.attempts}`),`harness-job-${randomUUID()}`),purpose:'job',instrumentationDirectory:resources,...(adapter.executionEnvironment?{environment:adapter.executionEnvironment}:{})};
 try{
  await rm(path.join(root,`environment-${j.attempts}`),{recursive:true,force:true});await rm(layout.workDirectory,{recursive:true,force:true});
  const environment=await adapter.prepare(j.source.directory,path.join(root,`environment-${j.attempts}`),{...layout,purpose:'verification'},config.gateTimeoutMs,config.installPolicy);
  const identity=sha256(JSON.stringify({version:1,protocol:j.spec.checkpoint?.protocol??null,spec:j.specDigest,source:j.source.digest,profile,capabilities,environment:environment.key,policy}));
  if(j.identity&&j.identity!==identity)required('Prepared dependency identity changed; checkpoint resume refused.');j.identity=identity;j.environment=environment.key;
  await adapter.install(j.source.directory,layout.workDirectory,environment,{...layout,purpose:'verification'},config.gateTimeoutMs);
  await assertSnapshot(j.source);await assertLiveBaseline(project,j.source);
  if(interrupted||await requestMatches(root,j)){j.status='cancelled';await saveJob(project,j,'cancelled','Stopped after the bounded preparation step.');return j;}
  if(resume){await mkdir(path.join(layout.workDirectory,'.harness-output'),{recursive:true});await writeFile(path.join(layout.workDirectory,'.harness-output/resume.json'),resume);}
  await writeFile(path.join(layout.workDirectory,'.harness-job-context.json'),JSON.stringify({command:j.spec.command,identity,total:j.spec.checkpoint?.total,resume:!!resume,timeoutSeconds:j.spec.limits.timeoutSeconds}));
  j.container=layout.containerName;j.status='running';await saveJob(project,j,'running',`Running offline: 2 CPUs, 2 GiB RAM, 512 MiB workspace, ${j.spec.limits.timeoutSeconds}s attempt limit.`);
  const launch={...layout,labels:{'harness.job':j.id,'harness.token':j.token!}};
  started=Date.now();const start=await command(config.dockerExecutable,buildRunArguments(launch,'none',['node','/harness-instrumentation/supervisor.mjs']));
  if(start.code!==0||start.timedOut)required(`Could not launch job: ${start.stderr}`);notify(j.events.at(-1)!.message);
  let lastNotice=Date.now(),prior=j.checkpoint;
  for(;;){
   if(interrupted||await requestMatches(root,j)||Date.now()-started>=j.spec.limits.timeoutSeconds*1000){j.status=interrupted||await requestMatches(root,j)?'cancelled':'timed-out';await command(config.dockerExecutable,['kill','--signal=TERM',j.container]);await delay(300);try{await checkpoint(project,j);}catch(e){notify(`Latest checkpoint refused: ${(e as Error).message}`);}break;}
   const bytes=await transfer(j,'.harness-job-status.json',true);
   if(bytes){
    const status=JSON.parse(bytes.toString()) as {version:number;phase:string;code:number|null;outputLimited:boolean;timedOut:boolean;stdout:string;stderr:string};
    if(status.version!==1||!['running','finished'].includes(status.phase)||typeof status.stdout!=='string'||typeof status.stderr!=='string'||typeof status.outputLimited!=='boolean'||typeof status.timedOut!=='boolean'||(status.code!==null&&!Number.isInteger(status.code)))required('Malformed job diagnostics.');
    await checkpoint(project,j);
    if(prior!==j.checkpoint){prior=j.checkpoint;notify(j.events.at(-1)!.message);}
    if(status.phase==='finished'){
     const log=await putArtifact(project,'job-log.txt',Buffer.from(status.stdout+'\n'+status.stderr),{producer:j.id,input:j.source.digest,environment:j.identity!,verification:'unverified'});j.artifacts.push(log.id);
     if(status.timedOut){j.status='timed-out';break;}
     if(status.code!==0||status.outputLimited)required(status.outputLimited?'Job log quota exceeded.':`Job command failed (exit ${String(status.code)}). Inspect retained logs.`);
     let total=0;
     for(const name of j.spec.outputs){const output=(await transfer(j,`.harness-output/${name}`))!;total+=output.length;if(total>ARTIFACT_LIMITS.batch)required('Declared outputs exceed 64 MiB batch limit.');const a=await putArtifact(project,name,output,{producer:j.id,input:j.source.digest,environment:j.identity!,verification:'unverified'});j.artifacts.push(a.id);}
     j.status='succeeded';break;
    }
   }
   if(Date.now()-lastNotice>=10000){notify(`Working: ${Math.floor((Date.now()-started)/1000)}s elapsed; last checkpoint ${j.completed??'none'}.`);lastNotice=Date.now();}
   await delay(500);
  }
 }catch(e){j.status='failed';await saveJob(project,j,'failed',(e as Error).message);notify((e as Error).message);}
 finally{
  process.off('SIGINT',signal);process.off('SIGTERM',signal);
  if(started)j.elapsedSeconds+=(Date.now()-started)/1000;
  // If cleanup cannot be confirmed, retain running ownership for explicit recovery.
  try{await stopOwned(j);}catch(e){j.status='running';await saveJob(project,j,'cleanup-blocked',(e as Error).message);throw e;}
  delete j.container;await rm(layout.workDirectory,{recursive:true,force:true});await rm(path.join(root,`environment-${j.attempts}`),{recursive:true,force:true});
  await saveJob(project,j,j.status,`${j.status}. ${j.artifacts.length} outputs retained; checkpoint ${j.completed??'none'}. No source applied or artifact published. Compute cost unknown.`);notify(j.events.at(-1)!.message);
 }
 return j;
 });
}
