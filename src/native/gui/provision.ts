import {mkdir,readFile,writeFile,copyFile,rm,rename,chmod,lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';import {spawn} from 'node:child_process';import path from 'node:path';import os from 'node:os';
import {run} from '../../run.ts';import {withWriter,writerPath,recoverWriter} from '../../workspace/writer-lock.ts';
import {sha256,saveJson} from '../../artifacts/store.ts';
import {nativeRoot,tartHome,tart,nativeResources,readNativeProfile,type NativeProfile} from '../provision.ts';
import {nativeArguments} from '../runtime.ts';import {stoppedVMs} from '../lifecycle.ts';import {readNativeSlot} from '../active.ts';
export const GUI_IMAGE='harness-macos-gui';
export const ELECTRON_VERSION='44.3.0';
export const ELECTRON_SHA='49b91ef265c603c8888500f807484b63816069c30f87ba2b403e7c87f0f45035';
export const guiResources=path.join(import.meta.dirname,'instrumentation');
export async function guiProtocol(){return sha256(Buffer.concat(await Promise.all(['schema.ts','store.ts','controller.ts','provision.ts','instrumentation/driver.mjs'].map(p=>readFile(path.join(import.meta.dirname,p))))));}
export async function readGuiRuntime(){
 const profile=await readNativeProfile();
 const receipt=JSON.parse(await readFile(nativeRoot+'/gui-tools.json','utf8').catch(()=>{throw Error('macOS GUI tools are not provisioned. Use harness macos provision.');}));
 if(profile.image!==GUI_IMAGE||receipt.profile!==sha256(JSON.stringify(profile))||receipt.electron!==ELECTRON_VERSION||receipt.archive!==ELECTRON_SHA)throw Error('The macOS GUI runtime needs provisioning or revalidation.');
 return {profile,protocol:await guiProtocol(),electron:ELECTRON_VERSION};
}
async function command(executable:string,args:string[],env?:NodeJS.ProcessEnv,timeoutMs=60000){const r=await run(executable,args,{...(env?{env}:{}),timeoutMs,maxOutputBytes:1024*1024});if(r.code!==0||r.timedOut||r.outputLimited)throw Error(`${path.basename(executable)} failed: ${r.stderr.slice(-2000)}`);return r;}
export async function prepareGuiBase(notify:(s:string)=>void=()=>{}){
 const base=await readNativeProfile();if(base.image===GUI_IMAGE)return base;
 return withWriter(nativeRoot,'macOS GUI preparation',async()=>{
  if(await readNativeSlot(nativeRoot))throw Error('Recover the active native run before GUI preparation.');
  if(await lstat(nativeRoot+'/gui-preparation.json').catch(()=>null))throw Error('Recover the previous GUI preparation: harness macos recover-preparation.');
  const destination=path.join(tartHome,'vms',GUI_IMAGE);
  if(await lstat(destination).catch(()=>null))throw Error('A prepared GUI base already exists. Use harness macos validate to resume verification.');
  const root=path.join(nativeRoot,'gui-prepare-'+randomUUID());await mkdir(root);await saveJson(nativeRoot,'gui-preparation.json',{version:1,root,pid:process.pid});await mkdir(root+'/input/tools',{recursive:true});await mkdir(root+'/output',{mode:0o777});await chmod(root+'/output',0o777);await mkdir(root+'/tart/vms/job',{recursive:true});
  const environment={PATH:`${nativeRoot}/bin:/usr/bin:/bin`,HOME:os.homedir(),TART_HOME:root+'/tart',TART_NO_AUTO_PRUNE:'1',TART_NO_TELEMETRY:'1'};
  let guardian:ReturnType<typeof spawn>|undefined,cancelled=false;const cancel=()=>{cancelled=true;guardian?.kill('SIGTERM');};process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
  try{
   notify('Downloading the pinned macOS Electron runtime; no project source is included.');
   const download=await fetch(`https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-darwin-arm64.zip`,{signal:AbortSignal.timeout(180000)});if(!download.ok||!download.body)throw Error('Electron download failed.');const chunks:Uint8Array[]=[];let size=0;for await(const chunk of download.body){size+=chunk.length;if(size>200*1024**2)throw Error('Electron archive exceeds its bound.');chunks.push(chunk);}const bytes=Buffer.concat(chunks);if(sha256(bytes)!==ELECTRON_SHA)throw Error('Electron checksum mismatch.');await writeFile(root+'/electron.zip',bytes);
   await command('/usr/bin/ditto',['-x','-k',root+'/electron.zip',root+'/input/tools']);
   // Electron's development archive is pinned by its official SHA-256; the
   // packaged application is signed ad hoc only inside the disposable guest.
   if(!(await lstat(root+'/input/tools/Electron.app/Contents/MacOS/Electron')).isFile())throw Error('Electron executable is missing.');
   const toolsRoot=path.resolve(import.meta.dirname,'../../../containers/desktop');for(const file of ['package.json','package-lock.json'])await copyFile(toolsRoot+'/'+file,root+'/input/tools/'+file);
   notify('Installing pinned UI-driver packages without lifecycle scripts.');
   await command('npm',['ci','--prefix',root+'/input/tools','--ignore-scripts','--no-audit','--no-fund'],undefined,180000);
   await command('/usr/bin/tar',['-cf',root+'/input/tools.tar','-C',root+'/input/tools','.']);
   await rm(root+'/input/tools',{recursive:true,force:true});
   if(cancelled)throw Error('GUI preparation cancelled.');
   for(const file of Object.keys(base.files)){await command(nativeRoot+'/bin/clonefile',[path.join(tartHome,'vms',base.image,file),root+'/tart/vms/job/'+file]);await chmod(root+'/tart/vms/job/'+file,0o600);}
   const nonce=randomUUID().replaceAll('-','');
   const launch=`#!/bin/zsh -f\nset -eu\nexec > '/Volumes/My Shared Files/harness-output/install.log' 2>&1\ntrap 'printf failed > \"/Volumes/My Shared Files/harness-output/failed.txt\"' ZERR\n/usr/bin/sudo -n /bin/mkdir -p /usr/local/lib/harness/gui-tools\n/usr/bin/sudo -n /usr/bin/tar -xf '/Volumes/My Shared Files/harness-input/tools.tar' -C /usr/local/lib/harness/gui-tools\n/usr/bin/env ELECTRON_RUN_AS_NODE=1 /usr/local/lib/harness/gui-tools/Electron.app/Contents/MacOS/Electron -p 'process.versions.electron' > '/Volumes/My Shared Files/harness-output/version.txt'\n/bin/sync\n/usr/bin/printf '%s\\n' '${nonce}' > '/Volumes/My Shared Files/harness-output/complete.txt'\n/usr/bin/sudo -n /sbin/shutdown -h now\n`;
   await writeFile(root+'/input/launch.zsh',launch);await writeFile(root+'/guardian.json',JSON.stringify({tart,args:nativeArguments('job',root),env:environment,home:nativeRoot,log:root+'/vm.log',timeoutMs:300000}));
   notify('Installing tools in an offline clone; the existing script base stays unchanged.');
   if(cancelled)throw Error('GUI preparation cancelled.');
   guardian=spawn(process.execPath,[nativeResources+'/guardian.mjs',root+'/guardian.json'],{stdio:'ignore'});let ended=false;guardian.on('exit',()=>{ended=true});guardian.on('error',()=>{ended=true});
   const deadline=Date.now()+300000;let notice=0;
   for(;;){if(cancelled||Date.now()>deadline||ended)throw Error('GUI preparation interrupted or timed out. Re-run preparation after cleanup.');if(await lstat(root+'/output/failed.txt').catch(()=>null))throw Error('Guest tool installation failed: '+(await readFile(root+'/output/install.log','utf8')).slice(-2000));const complete=await readFile(root+'/output/complete.txt','utf8').catch(()=>null);if(complete===nonce+'\n')break;if(Date.now()>notice){notify('Waiting for offline GUI tool installation.');notice=Date.now()+15000;}await new Promise(r=>setTimeout(r,500));}
   if((await readFile(root+'/output/version.txt','utf8')).trim()!==ELECTRON_VERSION)throw Error('Guest Electron version differs from the approved runtime.');
   notify('Waiting for clean guest shutdown so installed tools reach the base disk.');
   for(let attempt=0;attempt<60&&!ended;attempt++)await new Promise(r=>setTimeout(r,1000));
   if(!ended)throw Error('GUI preparation did not shut down cleanly; base was not registered.');
   const list=await command(tart,['list','--format','json'],environment);if(!stoppedVMs(JSON.parse(list.stdout)))throw Error('Cannot confirm GUI preparation VM stopped.');
   // Publish preparation intent first: a crash must never leave a completed
   // base with no receipt and no way to resume validation.
   await saveJson(nativeRoot,'gui-prepared.json',{version:1,image:GUI_IMAGE,os:base.os,electron:ELECTRON_VERSION,archive:ELECTRON_SHA});await rename(root+'/tart/vms/job',destination);
   notify('GUI base prepared. Real packaged-app verification is required before enabling it.');return {...base,image:GUI_IMAGE};
  }finally{
   process.off('SIGINT',cancel);process.off('SIGTERM',cancel);guardian?.kill('SIGTERM');
   const stopped=await run(tart,['stop','job'],{env:environment,timeoutMs:15000,maxOutputBytes:1000});
   const inventory=await run(tart,['list','--format','json'],{env:environment,timeoutMs:10000,maxOutputBytes:10000});
   if(inventory.code===0){const rows=JSON.parse(inventory.stdout);if(stoppedVMs(rows)||rows.length===0){await rm(root,{recursive:true,force:true});await rm(nativeRoot+'/gui-preparation.json',{force:true});}else notify(`Preparation resources retained: ${root}`);}else notify(`Preparation resources retained: ${root}`);
  }
 });
}

export async function recoverGuiPreparation(){
 const receipt=JSON.parse(await readFile(nativeRoot+'/gui-preparation.json','utf8'));
 if(receipt.version!==1||typeof receipt.root!=='string'||path.dirname(receipt.root)!==nativeRoot||!/^gui-prepare-[a-f0-9-]{36}$/u.test(path.basename(receipt.root))||!Number.isSafeInteger(receipt.pid))throw Error('Invalid GUI preparation ownership.');
 const lock=await readFile(await writerPath(nativeRoot),'utf8').then(s=>JSON.parse(s)).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return null;throw e;});
 if(lock){if(lock.pid!==receipt.pid)throw Error('A different writer owns the native runtime.');await recoverWriter(nativeRoot,lock.token);}
 else{try{process.kill(receipt.pid,0);throw Error('GUI preparation is still running.');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}}
 await withWriter(nativeRoot,'GUI preparation recovery',async()=>{
  const environment={PATH:'/usr/bin:/bin',HOME:os.homedir(),TART_HOME:receipt.root+'/tart'};
  await run(tart,['stop','job'],{env:environment,timeoutMs:15000,maxOutputBytes:1000});const inventory=await command(tart,['list','--format','json'],environment);const rows=JSON.parse(inventory.stdout);
  if(!stoppedVMs(rows)&&rows.length!==0)throw Error('Preparation VM stop could not be confirmed.');await rm(receipt.root,{recursive:true,force:true});await rm(nativeRoot+'/gui-preparation.json');
 });
}
