/** Loopback TCP bridge into a network-disabled container; no candidate code runs on the host. */
import {createServer,type Socket} from 'node:net';import {spawn,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';import {readFile} from 'node:fs/promises';import path from 'node:path';
import {run} from '../run.ts';import {loadConfig} from '../config.ts';
import {requireStagingChecks} from '../acceptance/checks.ts';
import {assertExecutionCompatible} from '../project/execution.ts';import {projectTestCommand} from '../project/profile.ts';
import {readStage,assertStageCurrent,stageBinding,stageDirectory} from './store.ts';
import {readArtifact,atomicWrite} from '../planning/store.ts';
import {OperatorError} from '../verbs/io.ts';
export interface PreviewSettings {entry:string;databaseEnv?:string;}
export async function previewSettings(project:string,id:string):Promise<PreviewSettings>{
 const s=await readStage(project,id),a=await requireStagingChecks(project,s.tasks);
 const journeys=a.manifest.cases.filter(c=>c.browser&&(c.tasks.includes('*')||c.tasks.some(t=>s.tasks.includes(t)))).map(c=>c.browser!);
 const unique=[...new Set(journeys.map(j=>JSON.stringify({entry:j.entry,...(j.databaseEnv?{databaseEnv:j.databaseEnv}:{})})))];
 if(unique.length!==1)throw new OperatorError('Preview requires one agreed Node startup and database configuration from approved browser journeys.','The candidate remains staged. Inspect it with an appropriate isolated runner; do not execute untrusted source on the host.');
 return JSON.parse(unique[0]!) as PreviewSettings;
}
export function previewArguments(name:string,token:string,source:string,image:string,port:number,settings:PreviewSettings):string[]{return ['run','--detach','--init','--name',name,'--label',`harness.stage-preview=${token}`,'--read-only','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--cpus','2','--memory','1024m','--pids-limit','128','--user',`${process.getuid?.()??501}:${process.getgid?.()??20}`,'--tmpfs','/tmp:rw,nosuid,nodev,size=134217728','--tmpfs','/data:rw,nosuid,nodev,mode=1777,size=134217728','--mount',`type=bind,src=${source},dst=/app,readonly`,'--workdir','/app','--env','HOME=/tmp','--env',`PORT=${port}`,...(settings.databaseEnv?['--env',`${settings.databaseEnv}=/data/preview.sqlite`]:[]),'--log-driver','local','--log-opt','max-size=1m','--log-opt','max-file=1','--log-opt','compress=false','--entrypoint','timeout',image,'-k','3','1800','node',settings.entry];}
async function removeOwned(docker:string,name:string,token:string,image:string):Promise<void>{
 const r=await run(docker,['inspect',name],{timeoutMs:10000,maxOutputBytes:100000});
 if(r.code!==0){if(/no such (object|container)/i.test(r.stderr))return;throw new OperatorError('Could not inspect preview container for cleanup.');}
 const c=JSON.parse(r.stdout)[0];if(c.Image!==image||c.Config?.Labels?.['harness.stage-preview']!==token)throw new OperatorError('Preview container ownership mismatch.');
 const removed=await run(docker,['rm','-f',name],{timeoutMs:10000,maxOutputBytes:10000});if(removed.code!==0)throw new OperatorError('Preview cleanup failed. Run harness stage preview again to recover owned resources.');
}
export async function startStagePreview(project:string,id:string):Promise<{url:string;close:()=>Promise<void>}>{
 const s=await readStage(project,id);if(s.status!=='pending')throw new OperatorError('Only a pending candidate can be previewed.');await assertStageCurrent(project,s);
 const settings=await previewSettings(project,id),config=loadConfig();
 if(!s.execution)throw new OperatorError('Preview requires the staged execution identity.');
 await assertExecutionCompatible(s.execution,project,config,await projectTestCommand(project,process.env.HARNESS_TEST_COMMAND));
 const pkg=JSON.parse(await readFile(path.join(s.candidate.directory,'package.json'),'utf8'));
 if(pkg.workspaces||['dependencies','optionalDependencies'].some(k=>Object.keys(pkg[k]??{}).length))throw new OperatorError('This preview lane currently supports dependency-free Node web servers. Candidate and evidence remain retained.');
 if(!Object.hasOwn(s.candidate.files,settings.entry))throw new OperatorError('Preview entry is missing from staged source.');
 const dir=stageDirectory(s.project,id),old=await readArtifact(dir,'preview.json');
 if(old){const previous=JSON.parse(old);if(previous.status==='running'){
  if(previous.docker!==config.dockerExecutable||previous.image!==config.imageId||!/^harness-stage-[a-f0-9-]+$/.test(previous.name)||! /^[a-f0-9-]+$/.test(previous.token))throw new OperatorError('Invalid retained preview ownership.');
  await removeOwned(config.dockerExecutable,previous.name,previous.token,previous.image);
 }}
 const token=randomUUID(),name=`harness-stage-${randomUUID()}`,sockets=new Set<Socket>(),children=new Set<ChildProcess>();let ready=false;
 const server=createServer(socket=>{
  if(!ready||sockets.size>=24){socket.destroy();return;}sockets.add(socket);socket.setTimeout(30000,()=>socket.destroy());
  const child=spawn(config.dockerExecutable,['exec','-i',name,'node','-e',`const net=require('node:net');const s=net.connect(${port},'127.0.0.1',()=>{process.stdin.pipe(s);s.pipe(process.stdout);});s.on('error',()=>process.exit(1));s.on('close',()=>process.stdin.destroy());`],{stdio:['pipe','pipe','ignore']});
  children.add(child);socket.pipe(child.stdin!);child.stdout!.pipe(socket);
  child.stdin!.on('error',()=>socket.destroy());child.on('error',()=>socket.destroy());child.on('close',()=>{children.delete(child);socket.destroy();});socket.on('error',()=>{});socket.on('close',()=>{sockets.delete(socket);child.kill();});
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});
 const address=server.address();if(!address||typeof address==='string')throw new OperatorError('Preview did not bind loopback.');const port=address.port,url=`http://127.0.0.1:${port}`;
 const receipt={version:1,binding:stageBinding(s),docker:config.dockerExecutable,image:config.imageId,name,token,url,at:new Date().toISOString(),status:'running'};
 let closed=false;
 const close=async()=>{if(closed)return;ready=false;for(const socket of sockets)socket.destroy();for(const child of children)child.kill();await new Promise<void>(resolve=>server.close(()=>resolve()));await removeOwned(config.dockerExecutable,name,token,config.imageId);await atomicWrite(path.join(dir,'preview.json'),JSON.stringify({...receipt,status:'stopped'})+'\n');closed=true;};
 try{
  await atomicWrite(path.join(dir,'preview.json'),JSON.stringify(receipt)+'\n');
  const r=await run(config.dockerExecutable,previewArguments(name,token,s.candidate.directory,config.imageId,port,settings),{timeoutMs:15000,maxOutputBytes:10000});if(r.code!==0||r.timedOut)throw new OperatorError('Preview container failed to start: '+r.stderr.slice(-1500));
  const probe=await run(config.dockerExecutable,['exec',name,'node','-e',`(async()=>{for(let i=0;i<50;i++){try{const r=await fetch('${url}/',{redirect:'manual'});if(r.status===200)process.exit(0)}catch{}await new Promise(r=>setTimeout(r,100));}process.exit(1)})();`],{timeoutMs:10000,maxOutputBytes:10000});
  if(probe.code!==0||probe.timedOut)throw new OperatorError('Staged preview did not serve its entry page with HTTP 200.');
  await assertStageCurrent(project,s);ready=true;
  await atomicWrite(path.join(dir,'preview-observed.json'),JSON.stringify({version:1,binding:stageBinding(s),url,at:new Date().toISOString(),environment:'Network-disabled Linux container; isolated ephemeral data; host browser and assistive technology'})+'\n');
  return {url,close};
 }catch(error){await close();throw error;}
}
export async function previewStage(project:string,id:string,write:(text:string)=>void):Promise<void>{
 const handle=await startStagePreview(project,id);
 write(`Staged preview: ${handle.url}\nUse your browser and screen reader here. Data is temporary; nothing is applied. Keep this terminal open, then press Ctrl+C when finished. Maximum 30 minutes.`);
 try{await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);process.off('SIGINT',done);process.off('SIGTERM',done);resolve();};const timer=setTimeout(done,1800000);process.once('SIGINT',done);process.once('SIGTERM',done);});}finally{await handle.close();}
 write(`Preview stopped. Record observations: harness stage review ${id}`);
}
