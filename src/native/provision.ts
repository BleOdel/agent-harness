import path from 'node:path';import os from 'node:os';
import {readFile,mkdir,writeFile,lstat,chmod,readdir,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';import {createReadStream} from 'node:fs';
import {run} from '../run.ts';import {OperatorError} from '../verbs/io.ts';
import {sha256,saveJson,safeDirectory} from '../artifacts/store.ts';
export const nativeRoot=path.join(os.homedir(),'Library/Application Support/Harness/native');
export const tartHome=path.join(os.homedir(),'Library/Application Support/Harness/tart');
export const tart=path.join(os.homedir(),'Library/Application Support/Harness/tools/tart/2.39.0/tart.app/Contents/MacOS/tart');
export const nativeResources=path.join(import.meta.dirname,'instrumentation');
export interface NativeProfile {version:1;tart:string;tartHash:string;networkHash:string;cloneHash:string;image:string;files:Record<string,string>;identities:Record<string,string>;protocol:string;cpu:2;memoryMiB:4096;os:string;arch:'arm64';}
const fail=(message:string):never=>{throw new OperatorError(message);};
export async function fileHash(file:string):Promise<string>{const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
export async function fileIdentity(file:string):Promise<string>{const s=await lstat(file,{bigint:true});if(!s.isFile())fail('Native image must be a regular file.');return sha256([s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.mode].map(String).join(':'));}
export async function protocolHash(){return sha256(Buffer.concat(await Promise.all(['offline-network.c','clonefile.c','guest-agent.zsh','guardian.mjs','../runtime.ts','../schema.ts','../controller.ts','../lifecycle.ts','../active.ts','../store.ts','../provision.ts'].map(f=>readFile(path.join(nativeResources,f))))));}
export async function nativeTools(){
 if(process.platform!=='darwin'||process.arch!=='arm64')fail('The native runner currently requires an Apple Silicon Mac.');
 const r=await run(tart,['--version'],{timeoutMs:10000,maxOutputBytes:1000});if(r.code!==0||r.stdout.trim()!=='2.39.0')fail('Install the verified Tart 2.39.0 application before provisioning native checks.');
 await safeDirectory(nativeRoot);await safeDirectory(nativeRoot+'/bin');
 const compile=await run('/usr/bin/xcrun',['clang','-Wall','-Wextra','-Werror',nativeResources+'/offline-network.c','-o',nativeRoot+'/bin/softnet'],{timeoutMs:60000,maxOutputBytes:4000});
 if(compile.code!==0||compile.timedOut)fail('The offline network terminator could not be compiled. Xcode command-line tools are required.');
 const clone=await run('/usr/bin/xcrun',['clang','-Wall','-Wextra','-Werror',nativeResources+'/clonefile.c','-o',nativeRoot+'/bin/clonefile'],{timeoutMs:60000,maxOutputBytes:4000});if(clone.code!==0)fail('macOS clone helper could not be compiled.');
 return {tart,version:r.stdout.trim(),tartHash:await fileHash(tart)};
}
export async function saveNativeProfile(image:string,osVersion:string):Promise<NativeProfile>{
 const t=await nativeTools(),imagePath=path.join(tartHome,'vms',image);if(!/^harness-macos-[a-z0-9-]+$/u.test(image))fail('Only a Harness-owned base VM can be registered.');
 const inventory=await run(tart,['list','--format','json'],{env:{PATH:'/usr/bin:/bin',HOME:os.homedir(),TART_HOME:tartHome},timeoutMs:10000,maxOutputBytes:100000});if(inventory.code!==0||!JSON.parse(inventory.stdout).some((r:any)=>r.Source==='local'&&r.Name===image&&r.State==='stopped'))fail('The native base must be stopped before registration.');
 const entries=await readdir(imagePath);if(entries.includes('control.sock')&&!(await lstat(imagePath+'/control.sock')).isSocket())fail('Invalid Tart control socket.');if(entries.some(f=>!['disk.img','nvram.bin','config.json','control.sock'].includes(f)))fail('Base VM has unexpected files; inspect it before registration.');
 const previous=await readFile(nativeRoot+'/profile.candidate.json','utf8').then(s=>JSON.parse(s)).catch(()=>null);const files:Record<string,string>={},identities:Record<string,string>={};for(const f of ['disk.img','nvram.bin','config.json']){const p=imagePath+'/'+f;if(!(await lstat(p)).isFile()||(await realpath(p))!==p)fail('VM base must contain real files, not aliases.');if(((await lstat(p)).mode&0o777)!==0o400)await chmod(p,0o400);identities[f]=await fileIdentity(p);files[f]=previous?.image===image&&previous?.identities?.[f]===identities[f]&&/^[a-f0-9]{64}$/u.test(previous?.files?.[f]??'')?previous.files[f]:await fileHash(p);}
 const config=JSON.parse(await readFile(imagePath+'/config.json','utf8'));if(config.cpuCount!==2||config.memorySize!==4096*1024**2||config.os!=='darwin'||config.arch!=='arm64')fail('The native base must be macOS arm64, 2 CPUs and 4096 MiB.');
 const profile:NativeProfile={version:1,tart:tart,tartHash:t.tartHash,networkHash:await fileHash(nativeRoot+'/bin/softnet'),cloneHash:await fileHash(nativeRoot+'/bin/clonefile'),image,files,identities,protocol:await protocolHash(),cpu:2,memoryMiB:4096,os:osVersion,arch:'arm64'};await saveJson(nativeRoot,'profile.candidate.json',profile);return profile;
}
export async function readNativeProfile(deep=false,candidate=false):Promise<NativeProfile>{
 let p:NativeProfile;try{p=JSON.parse(await readFile(nativeRoot+(candidate?'/profile.candidate.json':'/profile.json'),'utf8'));}catch{fail('Native VM is not provisioned. Run harness native provision, or choose Native macOS checks in harness guide.');}
 if(p!.version!==1||p!.tart!==tart||!/^harness-macos-[a-z0-9-]+$/u.test(p!.image)||p!.cpu!==2||p!.memoryMiB!==4096||p!.arch!=='arm64'||!p!.files||Object.keys(p!.files).sort().join(',')!=='config.json,disk.img,nvram.bin')fail('Invalid native runtime profile.');
 if(await fileHash(nativeRoot+'/bin/clonefile')!==p!.cloneHash||await fileHash(tart)!==p!.tartHash||await fileHash(nativeRoot+'/bin/softnet')!==p!.networkHash||await protocolHash()!==p!.protocol)fail('Native runtime protocol changed. Run harness native revalidate, then review the saved check again.');
 for(const [f,hash]of Object.entries(p!.files)){const full=path.join(tartHome,'vms',p!.image,f);if((await realpath(full))!==full||await fileIdentity(full)!==p!.identities?.[f]||(deep&&await fileHash(full)!==hash))fail('Native base image changed. Revalidate it before running project code.');}
 return p!;
}
