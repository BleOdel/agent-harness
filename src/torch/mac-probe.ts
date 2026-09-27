import {mkdir,readFile,writeFile,cp,chmod,lstat,rm,statfs} from 'node:fs/promises';
import {spawn} from 'node:child_process';import {randomUUID} from 'node:crypto';import path from 'node:path';import os from 'node:os';
import {nativeRoot,tartHome,tart,nativeResources,readNativeProfile,fileHash} from '../native/provision.ts';
import {nativeArguments} from '../native/runtime.ts';import {stoppedVMs} from '../native/lifecycle.ts';import {readNativeSlot} from '../native/active.ts';
import {withWriter,writerPath,recoverWriter} from '../workspace/writer-lock.ts';import {run} from '../run.ts';import {saveJson} from '../artifacts/store.ts';
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function command(exe:string,args:string[],env?:NodeJS.ProcessEnv){const r=await run(exe,args,{...(env?{env}:{}),timeoutMs:60000,maxOutputBytes:1024*1024});if(r.code!==0||r.timedOut)throw Error(r.stderr.slice(-2000));return r;}
export async function probeMacTorch(bundle:string,notify:(s:string)=>void=()=>{}){
 const base=await readNativeProfile(),manifest=JSON.parse(await readFile(import.meta.dirname+'/mac-bundle.json','utf8'));
 for(const f of manifest.files){const p=path.join(bundle,f.name),s=await lstat(p);if(!s.isFile()||s.isSymbolicLink()||s.size!==f.bytes||await fileHash(p)!==f.sha256)throw Error('Mac PyTorch tool bundle changed: '+f.name);}
 return withWriter(nativeRoot,'PyTorch Mac compatibility',async()=>{
  if(await readNativeSlot(nativeRoot)||await lstat(nativeRoot+'/torch-probe.json').catch(()=>null))throw Error('Recover the existing native operation first (harness torch recover-mac-probe for this probe).');
  const disk=await statfs(nativeRoot);if(disk.bavail*disk.bsize<24*1024**3)throw Error('Mac probe needs at least 24 GiB free.');
  const root=nativeRoot+'/torch-probe-'+randomUUID();await mkdir(root);await saveJson(nativeRoot,'torch-probe.json',{version:1,root,pid:process.pid});
  const env={PATH:nativeRoot+'/bin:/usr/bin:/bin',HOME:os.homedir(),TART_HOME:root+'/tart',TART_NO_AUTO_PRUNE:'1',TART_NO_TELEMETRY:'1'};
  let guardian:ReturnType<typeof spawn>|undefined,cancelled=false;const cancel=()=>{cancelled=true;guardian?.kill('SIGTERM');};process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
  try{
   await mkdir(root+'/input/wheels',{recursive:true});await mkdir(root+'/output',{mode:0o777});await chmod(root+'/output',0o777);await mkdir(root+'/tart/vms/job',{recursive:true});
   for(const f of manifest.files)await cp(path.join(bundle,f.name),path.join(root,'input',f.name),{dereference:false});await cp(import.meta.dirname+'/mac-probe.py',root+'/input/probe.py');
   for(const file of Object.keys(base.files)){await command(nativeRoot+'/bin/clonefile',[path.join(tartHome,'vms',base.image,file),root+'/tart/vms/job/'+file]);await chmod(root+'/tart/vms/job/'+file,0o600);}
   const config=JSON.parse(await readFile(root+'/tart/vms/job/config.json','utf8'));config.macAddress='02:'+randomUUID().replaceAll('-','').slice(0,10).match(/../gu)!.join(':');await writeFile(root+'/tart/vms/job/config.json',JSON.stringify(config));
   const nonce=randomUUID();await writeFile(root+'/input/launch.zsh',`#!/bin/zsh -f\nset -eu\nexec > '/Volumes/My Shared Files/harness-output/install.log' 2>&1\nmkdir -p /private/tmp/torch-tools\ntar -xf '/Volumes/My Shared Files/harness-input/python.tar.gz' -C /private/tmp/torch-tools\n/private/tmp/torch-tools/python/bin/python3 -I -m pip install --no-index --no-cache-dir --only-binary=:all: --find-links='/Volumes/My Shared Files/harness-input/wheels' torch==2.14.0 numpy==2.5.3\nPYTORCH_ENABLE_MPS_FALLBACK=0 /private/tmp/torch-tools/python/bin/python3 -I '/Volumes/My Shared Files/harness-input/probe.py'\nprintf '%s' '${nonce}' > '/Volumes/My Shared Files/harness-output/complete.txt'\n`);
   await writeFile(root+'/guardian.json',JSON.stringify({tart,args:nativeArguments('job',root),env,home:nativeRoot,log:root+'/vm.log',timeoutMs:300000}));
   guardian=spawn(process.execPath,[nativeResources+'/guardian.mjs',root+'/guardian.json'],{stdio:'ignore'});let ended=false;guardian.on('exit',()=>{ended=true;});guardian.on('error',()=>{ended=true;});const deadline=Date.now()+300000;let notice=0;
   for(;;){if(cancelled||ended||Date.now()>deadline)throw Error('Mac compatibility probe interrupted or timed out. Evidence retained in '+root);if(await readFile(root+'/output/complete.txt','utf8').catch(()=>null)===nonce)break;if(Date.now()>notice){notify('Testing PyTorch in an offline Mac VM clone; CPU fallback disabled.');notice=Date.now()+15000;}await pause(500);}
   const report=JSON.parse(await readFile(root+'/output/probe.json','utf8'));await saveJson(nativeRoot,'torch-mps-probe.json',{...report,profile:base,observedAt:new Date().toISOString()});notify(JSON.stringify(report));return report;
  }finally{
   process.off('SIGINT',cancel);process.off('SIGTERM',cancel);guardian?.kill('SIGTERM');await run(tart,['stop','job'],{env,timeoutMs:15000,maxOutputBytes:1000});let stopped=false;
   for(let n=0;n<5;n++){const r=await run(tart,['list','--format','json'],{env,timeoutMs:10000,maxOutputBytes:10000});if(r.code===0&&(stoppedVMs(JSON.parse(r.stdout))||JSON.parse(r.stdout).length===0)){stopped=true;break;}await pause(1000);}
   if(stopped){const log=await readFile(root+'/output/install.log','utf8').catch(()=>'' );await writeFile(nativeRoot+'/torch-mps-probe.log',log.slice(-100000));await rm(root,{recursive:true,force:true});await rm(nativeRoot+'/torch-probe.json',{force:true});}else notify('Cannot confirm probe VM stopped; resources retained. Use harness torch recover-mac-probe.');
  }
 });
}
export async function recoverMacProbe(){const receipt=JSON.parse(await readFile(nativeRoot+'/torch-probe.json','utf8'));if(receipt.version!==1||path.dirname(receipt.root)!==nativeRoot||!/^torch-probe-[a-f0-9-]{36}$/u.test(path.basename(receipt.root))||!Number.isSafeInteger(receipt.pid))throw Error('Invalid probe ownership.');const lock=await readFile(await writerPath(nativeRoot),'utf8').then(s=>JSON.parse(s)).catch(()=>null);if(lock){if(lock.pid!==receipt.pid)throw Error('Another writer owns the native runtime.');await recoverWriter(nativeRoot,lock.token);}else{try{process.kill(receipt.pid,0);throw Error('Probe owner is still live.');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}}
 await withWriter(nativeRoot,'PyTorch probe recovery',async()=>{const env={PATH:'/usr/bin:/bin',HOME:os.homedir(),TART_HOME:receipt.root+'/tart'};await run(tart,['stop','job'],{env,timeoutMs:15000,maxOutputBytes:1000});for(let n=0;n<5;n++){const r=await command(tart,['list','--format','json'],env);if(stoppedVMs(JSON.parse(r.stdout))||JSON.parse(r.stdout).length===0){await rm(receipt.root,{recursive:true,force:true});await rm(nativeRoot+'/torch-probe.json');return;}await pause(1000);}throw Error('Cannot confirm probe VM stopped.');});
}
