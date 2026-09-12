import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { runJob, requestCancel, releaseJob } from '../src/jobs/controller.ts';
import { createJob, readJob } from '../src/jobs/state.ts';
import { artifactBytes, collectArtifacts, listArtifacts } from '../src/artifacts/store.ts';
import { withWriter } from '../src/workspace/writer-lock.ts';
import { run } from '../src/run.ts';
const options={skip:process.env.HARNESS_DOCKER&&process.env.HARNESS_IMAGE_ID?false:'configure Docker job runner'};
export const program=`import fs from 'node:fs';
const out=process.env.HARNESS_JOB_OUTPUT;
if(process.getuid()===0)throw Error('root user');
if(!fs.readFileSync('/proc/self/status','utf8').includes('CapEff:\t0000000000000000'))throw Error('capabilities');
if(fs.readFileSync('/proc/net/route','utf8').includes('eth0'))throw Error('network');
if(fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim()!=='2147483648')throw Error('memory quota');
if(Number(fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').split(' ')[0])!==200000)throw Error('CPU quota');
const stat=fs.statfsSync('/work');if(stat.blocks*stat.bsize>536870912)throw Error('workspace quota');
if(fs.existsSync('/pi-agent')||fs.existsSync('/opt/pi-package'))throw Error('credential mount');
try{fs.writeFileSync('/harness-input/escape','x');throw Error('writable source')}catch(e){if(e.message==='writable source')throw e;}
let value=process.env.HARNESS_JOB_RESUME?JSON.parse(fs.readFileSync(process.env.HARNESS_JOB_RESUME)).completed:0;
for(;value<4;){await new Promise(r=>setTimeout(r,500));value++;const point={version:1,protocol:'json-step@1',identity:process.env.HARNESS_JOB_IDENTITY,total:4,completed:value,payload:{value}};fs.writeFileSync(out+'/pending.json',JSON.stringify(point));fs.renameSync(out+'/pending.json',out+'/checkpoint.json');}
fs.writeFileSync(out+'/result.json',JSON.stringify({count:value}));console.log('counted',value);`;
export const spec={version:1,title:'Count four steps',command:['node','count.mjs'],outputs:['result.json'],checkpoint:{protocol:'json-step@1',total:4},limits:{timeoutSeconds:20,totalSeconds:60,maxAttempts:3}};
test('Docker jobs: cancel retains compatible checkpoint, fresh resume exports output, changed inputs and corrupt blobs fail closed',options,async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'jobs-docker-'))),project=path.join(root,'project');await mkdir(project);
 const config=loadConfig({...process.env,HARNESS_PROJECT:project});
 try{
  await writeFile(path.join(project,'package.json'),JSON.stringify({type:'module'}));await writeFile(path.join(project,'count.mjs'),program);
  const job=await withWriter(project,'test',()=>createJob(project,spec));let requested=false;
  const first=await runJob(project,job.id,message=>{if(!requested&&message.includes('Saved compatible checkpoint')){requested=true;void requestCancel(project,job.id);}},config);
  assert.equal(first.status,'cancelled');assert.ok(first.checkpoint);assert.ok(first.completed!<4);
  const checkpoint=await artifactBytes(project,first.checkpoint!);assert.equal(JSON.parse(checkpoint.toString()).completed,first.completed);
  const after=await run(config.dockerExecutable,['ps','-aq','--filter',`label=harness.job=${job.id}`],{timeoutMs:10000});assert.equal(after.stdout.trim(),'');
  await writeFile(path.join(project,'count.mjs'),program+'\n// changed');await assert.rejects(runJob(project,job.id,()=>{},config),/changed/);await writeFile(path.join(project,'count.mjs'),program);
  const manifest=(await listArtifacts(project)).find(a=>a.id===first.checkpoint)!;const blob=path.join(project+'-harness/artifacts/blobs',manifest.sha256);
  await writeFile(blob,'bad');await assert.rejects(runJob(project,job.id,()=>{},config),/corrupt|hash/);await writeFile(blob,checkpoint);
  const second=await runJob(project,job.id,()=>{},config);assert.equal(second.status,'succeeded',JSON.stringify(second.events));assert.equal(second.attempts,2);assert.equal(second.completed,4);
  const output=(await listArtifacts(project)).find(a=>a.name==='result.json')!;assert.deepEqual(JSON.parse((await artifactBytes(project,output.id)).toString()),{count:4});assert.equal(output.verification,'unverified');
  assert.equal(await readFile(path.join(project,'count.mjs'),'utf8'),program);await collectArtifacts(project);assert.ok((await listArtifacts(project)).length>0);
  await releaseJob(project,job.id);await collectArtifacts(project);assert.deepEqual(await listArtifacts(project),[]);assert.equal((await readJob(project,job.id)).status,'released');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Docker jobs: timeouts, output limits, workspace quotas and unsafe outputs remain nonpassing',options,async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'jobs-limits-'))),project=path.join(root,'project');await mkdir(project);await writeFile(path.join(project,'package.json'),JSON.stringify({type:'module'}));
 const config=loadConfig({...process.env,HARNESS_PROJECT:project});
 try{
  for(const [name,code,reason]of [
   ['timeout',"setInterval(()=>{},1000)",'timed-out'],
   ['missing',"// unused",'failed'],
   ['oversized',"import fs from 'node:fs';fs.writeFileSync(process.env.HARNESS_JOB_OUTPUT+'/result.json',Buffer.alloc(33*1024*1024))",'failed'],
   ['symlink',"import fs from 'node:fs';fs.symlinkSync('/etc/passwd',process.env.HARNESS_JOB_OUTPUT+'/result.json')",'failed'],
   ['scratch',"import fs from 'node:fs';const fd=fs.openSync('/work/huge','w');for(let i=0;i<600;i++)fs.writeSync(fd,Buffer.alloc(1024*1024));fs.writeFileSync(process.env.HARNESS_JOB_OUTPUT+'/result.json','ok');",'failed'],
   ['logging',"import fs from 'node:fs';console.log('x'.repeat(2*1024*1024));fs.writeFileSync(process.env.HARNESS_JOB_OUTPUT+'/result.json','ok');",'failed'],
  ]){
   await writeFile(path.join(project,'case.mjs'),code!);
   const job=await withWriter(project,'test',()=>createJob(project,{version:1,title:name,command:name==='missing'?['harness-missing-program']:['node','case.mjs'],outputs:['result.json'],limits:{timeoutSeconds:name==='timeout'?1:20,totalSeconds:name==='timeout'?1:20,maxAttempts:1}}));
   const result=await runJob(project,job.id,()=>{},config);assert.equal(result.status,reason,JSON.stringify(result.events));
   if(name==='missing'){const log=(await listArtifacts(project)).find(a=>a.producer===job.id&&a.name==='job-log.txt')!;assert.match((await artifactBytes(project,log.id)).toString(),/ENOENT/);}
   assert.equal((await run(config.dockerExecutable,['ps','-aq','--filter',`label=harness.job=${job.id}`],{timeoutMs:10000})).stdout.trim(),'');
   await assert.rejects(runJob(project,job.id,()=>{},config),/budget exhausted/);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Docker jobs: killed controller preserves ownership, reconciles resources, then resumes from saved checkpoint',options,async()=>{
 const {spawn}=await import('node:child_process');const {recoverWriter}=await import('../src/workspace/writer-lock.ts');const {recoverJob}=await import('../src/jobs/controller.ts');
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'jobs-crash-'))),project=path.join(root,'project');await mkdir(project);await writeFile(path.join(project,'package.json'),JSON.stringify({type:'module'}));await writeFile(path.join(project,'count.mjs'),program.replace('setTimeout(r,500)','setTimeout(r,1000)'));
 const config=loadConfig({...process.env,HARNESS_PROJECT:project});
 let child:ReturnType<typeof spawn>|undefined;
 try{
  const job=await withWriter(project,'test',()=>createJob(project,{...spec,limits:{timeoutSeconds:3,totalSeconds:9,maxAttempts:3}}));
  child=spawn(process.execPath,[path.resolve('src/cli.ts'),'job','run',job.id],{env:{...process.env,HARNESS_PROJECT:project},stdio:['ignore','pipe','pipe']});
  await new Promise<void>((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('checkpoint not reached')),30000);child!.stdout!.on('data',chunk=>{text+=chunk;if(text.includes('Saved compatible checkpoint')){clearTimeout(timer);resolve();}});child!.once('exit',code=>{clearTimeout(timer);if(!text.includes('Saved compatible checkpoint'))reject(Error('early exit '+code+' '+text));});});
  const owner=JSON.parse(await readFile(project+'-harness.writer-lock','utf8'));await assert.rejects(recoverWriter(project,owner.token),/still alive/);await assert.rejects(recoverJob(project,job.id),/locked/);
  child.kill('SIGKILL');await new Promise(resolve=>child!.once('close',resolve));
  await new Promise(resolve=>setTimeout(resolve,3500));
  const interrupted=await readJob(project,job.id);
  const watchdog=await run(config.dockerExecutable,['exec',interrupted.container!,'node','/harness-instrumentation/transport.mjs','.harness-job-status.json'],{timeoutMs:10000});assert.equal(watchdog.code,0);assert.equal(JSON.parse(Buffer.from(watchdog.stdout,'base64').toString()).timedOut,true);
  await recoverWriter(project,owner.token);
  const other=await withWriter(project,'test',()=>createJob(project,spec));await assert.rejects(runJob(project,other.id,()=>{},config),/unreconciled resources/);
  const {saveJson}=await import('../src/artifacts/store.ts');const {jobRoot}=await import('../src/jobs/state.ts');const saved=await readJob(project,job.id);
  await saveJson(await jobRoot(project,job.id),'state.json',{...saved,token:'wrong-owner'});await assert.rejects(recoverJob(project,job.id),/ownership mismatch/);await saveJson(await jobRoot(project,job.id),'state.json',saved);
  const recovered=await recoverJob(project,job.id);assert.equal(recovered.status,'interrupted');assert.ok(recovered.checkpoint);
  assert.equal((await run(config.dockerExecutable,['ps','-aq','--filter',`label=harness.job=${job.id}`],{timeoutMs:10000})).stdout.trim(),'');
  const result=await runJob(project,job.id,()=>{},config);assert.equal(result.status,'succeeded',JSON.stringify(result.events));
 }finally{child?.kill('SIGKILL');await rm(root,{recursive:true,force:true});}
});
