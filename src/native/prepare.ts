import {mkdir,writeFile,readFile,copyFile,rm,lstat} from 'node:fs/promises';import path from 'node:path';import {spawn} from 'node:child_process';import {randomUUID} from 'node:crypto';import os from 'node:os';
import {run} from '../run.ts';import {withWriter} from '../workspace/writer-lock.ts';import {sha256,safeDirectory} from '../artifacts/store.ts';
import {nativeRoot,tart,tartHome,nativeResources,nativeTools} from './provision.ts';
const archive='https://github.com/openai/tart/releases/download/2.39.0/tart.tar.gz',digest='cd17a1cb48fbdb72972a4f4cd467c0ed681f1225b3c0ce3c318c41c229e0dd42';
export async function installTart(notify:(s:string)=>void){
 if(await lstat(tart).catch(()=>null))return;
 const parent=path.resolve(path.dirname(tart),'../../..');await safeDirectory(parent);notify('Downloading verified Tart 2.39.0 (about 23 MB).');
 const response=await fetch(archive,{signal:AbortSignal.timeout(180000)});if(!response.ok||!response.body)throw Error('Tart download failed.');const chunks:Uint8Array[]=[];let count=0;for await(const chunk of response.body){count+=chunk.length;if(count>32*1024**2)throw Error('Tart download exceeded its size bound.');chunks.push(chunk);}const bytes=Buffer.concat(chunks);if(sha256(bytes)!==digest)throw Error('Tart release checksum does not match.');
 await writeFile(parent+'/tart.tar.gz',bytes);const unpack=await run('/usr/bin/tar',['-xzf',parent+'/tart.tar.gz','-C',parent],{timeoutMs:30000,maxOutputBytes:2000});if(unpack.code!==0)throw Error('Tart archive extraction failed.');const signed=await run('/usr/bin/codesign',['--verify','--deep','--strict',path.resolve(path.dirname(tart),'../../..')+'/tart.app'],{timeoutMs:30000,maxOutputBytes:2000});if(signed.code!==0)throw Error('Tart application signature could not be verified.');await rm(parent+'/tart.tar.gz');
}
export async function prepareNativeBase(notify:(s:string)=>void=()=>{}):Promise<{image:string;facts:string}>{
 await safeDirectory(nativeRoot);return withWriter(nativeRoot,'native image preparation',async()=>{
  if(await lstat(nativeRoot+'/profile.json').catch(()=>null))throw Error('A native base is already registered. Keep it immutable; use a separate reviewed replacement for upgrades.');
  await installTart(notify);await nativeTools();await safeDirectory(tartHome);
  const environment={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:os.homedir(),TART_HOME:tartHome,TART_NO_AUTO_PRUNE:'1',TART_NO_TELEMETRY:'1'};
  const image='harness-macos-base';const invoke=async(args:string[],timeoutMs=30000)=>{const r=await run(tart,args,{env:environment,timeoutMs,maxOutputBytes:1024*1024,onOutput:notify});if(r.code!==0||r.timedOut)throw Error(`Tart preparation stopped: ${r.stderr.slice(-1500)}`);return r;};
  if(!(await lstat(path.join(tartHome,'vms',image)).catch(()=>null))){notify('Downloading the macOS base image (about 27 GB compressed). No project source is shared during preparation.');await invoke(['clone','ghcr.io/cirruslabs/macos-tahoe-base@sha256:1b093499716409d29e8b5336844528e1cae375db97d2ad8e5aeff78cf0da201e',image],3600000);}
  await invoke(['set',image,'--cpu','2','--memory','4096']);
  const root=path.join(nativeRoot,'preparation-'+randomUUID()),nonce=randomUUID();await mkdir(root);await copyFile(nativeResources+'/guest-agent.zsh',root+'/guest-agent.zsh');await copyFile(nativeResources+'/bootstrap.zsh',root+'/bootstrap.zsh');await writeFile(root+'/nonce',nonce);await writeFile(root+'/askpass.sh',"#!/bin/sh\nprintf '%s\\n' admin\n",{mode:0o700});
  let child:ReturnType<typeof spawn>|undefined,cancelled=false;const cancel=()=>{cancelled=true;child?.kill('SIGTERM');};process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
  try{
   notify('Booting source-free preparation VM; installing the offline job launcher.');
   await writeFile(root+'/guardian.json',JSON.stringify({tart,args:['run','--no-graphics','--no-clipboard','--no-audio','--no-usb-accessories','--dir',`harness-prepare:${root}:ro`,image],env:environment,home:nativeRoot,timeoutMs:360000}));child=spawn(process.execPath,[nativeResources+'/guardian.mjs',root+'/guardian.json'],{stdio:'ignore'});let ended=false;child.on('exit',()=>{ended=true;});child.on('error',()=>{ended=true;});
   let ip='';const deadline=Date.now()+180000;
   while(Date.now()<deadline){if(cancelled)throw Error('Native preparation cancelled.');if(ended)throw Error('Preparation VM exited before SSH became available.');const found=await run(tart,['ip',image],{env:environment,timeoutMs:5000,maxOutputBytes:1000});const value=found.stdout.trim();if(found.code===0&&/^192\.168\.\d{1,3}\.\d{1,3}$/u.test(value)){ip=value;break;}await new Promise(r=>setTimeout(r,1000));}
   if(!ip)throw Error('Preparation VM did not obtain its private address.');
   const args=['-F','/dev/null','-o','StrictHostKeyChecking=accept-new','-o',`UserKnownHostsFile=${root}/known_hosts`,'-o','PubkeyAuthentication=no','-o','IdentityAgent=none','-o','IdentitiesOnly=yes','-o','NumberOfPasswordPrompts=1','-o','ConnectTimeout=5','-o','LogLevel=ERROR',`admin@${ip}`];
   const sshEnv={PATH:'/usr/bin:/bin',HOME:root,SSH_ASKPASS:root+'/askpass.sh',SSH_ASKPASS_REQUIRE:'force',DISPLAY:'harness'};
   let facts='';while(Date.now()<deadline){if(cancelled)throw Error('Native preparation cancelled.');const provision=await run('/usr/bin/ssh',[...args,`test "$(cat '/Volumes/My Shared Files/harness-prepare/nonce')" = '${nonce}' && sudo -n /bin/zsh '/Volumes/My Shared Files/harness-prepare/bootstrap.zsh'`],{env:sshEnv,timeoutMs:60000,maxOutputBytes:8000});if(provision.code===0){facts=provision.stdout;break;}if(ended)throw Error('Preparation VM exited.');notify('Waiting for the preparation VM to finish booting.');await new Promise(r=>setTimeout(r,3000));}
   if(!facts)throw Error('Preparation could not verify the owned guest or install its launcher.');
   await run('/usr/bin/ssh',[...args,'sudo -n shutdown -h now'],{env:sshEnv,timeoutMs:10000,maxOutputBytes:2000});
   for(let i=0;i<60&&!ended;i++)await new Promise(r=>setTimeout(r,1000));
   notify('Prepared base is shut down. Offline boundary verification is required before registering it.');return {image,facts};
  }finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);await run(tart,['stop',image],{env:environment,timeoutMs:15000,maxOutputBytes:2000});child?.kill('SIGTERM');await rm(root,{recursive:true,force:true});}
 });
}
