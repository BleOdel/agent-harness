import {claimNativeSlot,releaseNativeSlot,readNativeSlot} from './active.ts';
import {stoppedVMs,outputMount} from './lifecycle.ts';
import {randomUUID} from 'node:crypto';import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile,copyFile,rm,statfs,lstat,chmod} from 'node:fs/promises';import {constants} from 'node:fs';import path from 'node:path';import os from 'node:os';
import {withWriter,recoverWriter,writerPath,canonicalProject} from '../workspace/writer-lock.ts';import {captureBaseline,assertLiveBaseline,assertSnapshot} from '../workspace/candidate.ts';
import {putArtifact,sha256,safeDirectory} from '../artifacts/store.ts';import {boundedOutput} from '../desktop/output.ts';import {run} from '../run.ts';
import {nativeRoot,tartHome,tart,nativeResources,readNativeProfile} from './provision.ts';import {nativeArguments,guestLaunch} from './runtime.ts';import {assessNative} from './schema.ts';
import {readNativeApproval,nativeRunRoot,listNativeRuns,saveNativeRun,readNativeRun,type NativeRun} from './store.ts';
const env=(root:string):NodeJS.ProcessEnv=>({PATH:`${nativeRoot}/bin:/usr/bin:/bin`,HOME:os.homedir(),TART_HOME:root+'/tart',TART_NO_AUTO_PRUNE:'1',TART_NO_TELEMETRY:'1'});
async function command(exe:string,args:string[],timeoutMs=30000,environment?:NodeJS.ProcessEnv){const r=await run(exe,args,{timeoutMs,maxOutputBytes:1024*1024,...(environment?{env:environment}:{})});if(r.code!==0||r.timedOut||r.outputLimited)throw Error(`${path.basename(exe)} stopped: ${r.stderr.slice(-1500)}`);return r;}
async function owned(project:string,r:NativeRun){const root=await nativeRunRoot(project,r.id);const mark=JSON.parse(await readFile(root+'/owner.json','utf8'));if(mark.id!==r.id||mark.token!==r.token)throw Error('Native resource ownership changed. Nothing removed.');return root;}
async function stopVM(project:string,r:NativeRun){
 const root=await owned(project,r);
 if(r.vmStarted){
  const stopped=await run(tart,['stop','job'],{env:env(root),timeoutMs:15000,maxOutputBytes:4000});
  if(stopped.timedOut)throw Error('VM stop timed out; recover this native run.');
  const result=await command(tart,['list','--format','json'],10000,env(root));
  const rows=JSON.parse(result.stdout);if(!stoppedVMs(rows))throw Error('Cannot confirm VM stopped; files retained.');
 }
}
async function cleanup(project:string,r:NativeRun){
 const root=await owned(project,r);await stopVM(project,r);
 if(r.outputMounted){const inventory=await command('/bin/sh',['-c','/usr/bin/hdiutil info -plist | /usr/bin/plutil -convert json -o - -']);if(outputMount(JSON.parse(inventory.stdout),root+'/output.dmg',root+'/output')==='owned')await command('/usr/bin/hdiutil',['detach',root+'/output'],30000);r.outputMounted=false;await saveNativeRun(project,r);}
 for(const part of ['input','output','output.dmg','tart','guardian.json'])await rm(root+'/'+part,{recursive:true,force:true});
 const slot=await readNativeSlot(nativeRoot);if(slot?.id===r.id)await releaseNativeSlot(nativeRoot,r.id,r.token);
}
export async function recoverNative(project:string,id:string){const saved=await readNativeRun(project,id);if(!['preparing','running'].includes(saved.status))return;for(const target of [project,nativeRoot]){const lock=await readFile(await writerPath(target),'utf8').then(s=>JSON.parse(s)).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return null;throw e;});if(lock){if(lock.pid!==saved.controllerPid)throw Error('A different writer owns this project or native runtime. Nothing recovered.');await recoverWriter(target,lock.token);}}return withWriter(project,'native recover',()=>withWriter(nativeRoot,'native resource recovery',async()=>{const r=await readNativeRun(project,id);if(!['preparing','running'].includes(r.status))return;await cleanup(project,r);r.status='interrupted';r.message='Owned VM resources removed. Re-run the saved check from fresh source.';await saveNativeRun(project,r);}));}
export async function verifyNative(project:string,id:string,notify:(s:string)=>void=()=>{},provisioning=false){return withWriter(project,'native verify',()=>withWriter(nativeRoot,'native VM',async()=>{
 const active=await readNativeSlot(nativeRoot);if(active)throw Error(`Recover native run ${active.id} in ${active.project} before starting another VM.`);
 if((await listNativeRuns(project)).some(r=>['preparing','running'].includes(r.status)))throw Error('Recover unfinished native resources before starting another run.');
 const a=await readNativeApproval(project,id),profile=await readNativeProfile(false,provisioning);if(a.profileDigest!==sha256(JSON.stringify(profile)))throw Error('Native runtime changed. Review and approve this check for the current profile.');
 const space=await statfs(nativeRoot);if(space.bavail*space.bsize<24*1024**3)throw Error('Native verification needs at least 24 GiB free; no VM started.');
 const r:NativeRun={version:1,id:`native-${randomUUID()}`,token:randomUUID(),approval:id,profileDigest:a.profileDigest,status:'preparing',message:'Preparing disposable native VM.',at:new Date().toISOString(),artifacts:[],outputMounted:false,controllerPid:process.pid};
 const root=await nativeRunRoot(project,r.id);await writeFile(root+'/owner.json',JSON.stringify({id:r.id,token:r.token}));await saveNativeRun(project,r);
 await claimNativeSlot(nativeRoot,{version:1,project:await canonicalProject(project),id:r.id,token:r.token,pid:process.pid});
 let guardian:ReturnType<typeof spawn>|undefined,cancelled=false;const cancel=()=>{cancelled=true;guardian?.kill('SIGTERM');};process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
 try{
  await mkdir(root+'/input');await mkdir(root+'/output');const baseline=await captureBaseline(project,root+'/input/source');if(!Object.hasOwn(baseline.files,a.check.entry))throw Error('Native entry script is missing from the source snapshot.');
  let total=0;for(const f of Object.keys(baseline.files)){total+=(await boundedOutput(baseline.directory,f,4*1024*1024)).length;if(total>32*1024*1024)throw Error('Native source exceeds 32 MiB.');}r.source=baseline.digest;
  await safeDirectory(root+'/tart/vms/job');for(const file of Object.keys(profile.files)){await command(nativeRoot+'/bin/clonefile',[path.join(tartHome,'vms',profile.image,file),root+'/tart/vms/job/'+file]);await chmod(root+'/tart/vms/job/'+file,0o600);}
  const config=JSON.parse(await readFile(root+'/tart/vms/job/config.json','utf8'));config.macAddress='02:'+randomUUID().replaceAll('-','').slice(0,10).match(/../gu)!.join(':');await writeFile(root+'/tart/vms/job/config.json',JSON.stringify(config));
  await command('/usr/bin/hdiutil',['create','-size','64m','-fs','HFS+','-volname','harness-output','-type','UDIF',root+'/output.dmg']);
  // Save mount intent before attachment. Recovery checks the owned mount path.
  r.outputMounted=true;await saveNativeRun(project,r);await command('/usr/bin/hdiutil',['attach','-nobrowse','-noautoopen','-mountpoint',root+'/output',root+'/output.dmg']);await chmod(root+'/output',0o1777);
  const nonce=randomUUID().replaceAll('-','');await writeFile(root+'/input/launch.zsh',guestLaunch(a.check,nonce));
  await writeFile(root+'/guardian.json',JSON.stringify({tart,args:nativeArguments('job',root),env:env(root),home:nativeRoot,log:root+'/vm.log',timeoutMs:a.check.timeoutSeconds*1000}));
  r.vmStarted=true;r.status='running';await saveNativeRun(project,r);guardian=spawn(process.execPath,[nativeResources+'/guardian.mjs',root+'/guardian.json'],{stdio:'ignore'});let ended=false;guardian.on('exit',()=>{ended=true;});guardian.on('error',()=>{ended=true;});
  const deadline=Date.now()+a.check.timeoutSeconds*1000;let nextNotice=0;
  for(;;){if(cancelled)throw Error('Native check cancelled.');if(Date.now()>=deadline)throw Error('Native check timed out.');if(Date.now()>nextNotice){notify('Native VM running offline; waiting for the declared script.');nextNotice=Date.now()+15000;}
   const done=await boundedOutput(root+'/output','complete.txt',100).then(b=>b.toString()).catch(()=>null);if(done===nonce+'\n')break;if(ended)throw Error('Native VM stopped before completing its observations.');await new Promise(resolve=>setTimeout(resolve,500));}
  await stopVM(project,r);
  const stdout=await boundedOutput(root+'/output','stdout.txt',1024*1024),stderr=await boundedOutput(root+'/output','stderr.txt',1024*1024),exit=Number((await boundedOutput(root+'/output','exit.txt',10)).toString().trim());
  const assessment=assessNative(a.check,{exit,stdout:stdout.toString()});
  for(const [name,bytes] of [['stdout.txt',stdout],['stderr.txt',stderr],['assessment.json',Buffer.from(JSON.stringify(assessment))]] as const){const artifact=await putArtifact(project,name,bytes,{producer:r.id,input:r.source,environment:r.profileDigest,verification:'unverified'});r.artifacts.push(artifact.id);}
  for(const file of a.check.artifacts){const content=await boundedOutput(root+'/output/artifacts',file,4*1024*1024);const artifact=await putArtifact(project,path.basename(file),content,{producer:r.id,input:r.source,environment:r.profileDigest,verification:'unverified'});r.artifacts.push(artifact.id);}
  await assertSnapshot(baseline);await assertLiveBaseline(project,baseline);if(!assessment.passed)throw Error('Native output or exit code did not match the approved expectations.');r.status='passed';r.message='Native script observations matched. This is diagnostic evidence, not full application acceptance.';
 }catch(error){r.status=cancelled?'interrupted':'failed';r.message=(error as Error).message;}
 finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);guardian?.kill('SIGTERM');try{await cleanup(project,r);}catch(e){r.status='running';r.message+=` Cleanup needs recovery: ${(e as Error).message}`;}if(r.source){try{const log=await boundedOutput(root,'vm.log',65536);const artifact=await putArtifact(project,'vm.log',log,{producer:r.id,input:r.source,environment:r.profileDigest,verification:'unverified'});r.artifacts.push(artifact.id);}catch{/* Preserve cleanup and other results when startup produced no log. */}}await saveNativeRun(project,r);notify(r.message);}
 return r;
}));}
