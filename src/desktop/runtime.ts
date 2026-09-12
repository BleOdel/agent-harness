import {existsSync} from 'node:fs';
import {mkdtemp,readFile,realpath,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {sha256} from '../artifacts/store.ts';
import {run} from '../run.ts';
import {runContained} from '../containment/process.ts';
import {buildVerificationArguments,type SandboxLayout} from '../containment/sandbox.ts';
import {OperatorError} from '../verbs/io.ts';
export interface Runtime {image:string;arch:string;electron:string;playwright:string;asar:string;node:string;protocol:string;}
export const desktopResources=path.join(import.meta.dirname,'instrumentation');
export function desktopDocker():string {
 const docker=process.env.HARNESS_DOCKER?.trim()||'/usr/local/bin/docker';
 if(!path.isAbsolute(docker)||!existsSync(docker))throw new OperatorError('Set HARNESS_DOCKER to the installed Docker executable.');return docker;
}
export function desktopLayout(docker:string,image:string,work:string,container=`harness-desktop-${randomUUID()}`):SandboxLayout {
 return {dockerExecutable:docker,imageId:image,workDirectory:work,containerName:container,user:`${process.getuid?.()??501}:${process.getgid?.()??20}`,agentDirectory:'',piPackageDirectory:'',purpose:'verification',instrumentationDirectory:desktopResources};
}
export async function inspectDesktop(docker=desktopDocker(),selected=process.env.HARNESS_DESKTOP_IMAGE_ID?.trim()||'harness-desktop:e6'):Promise<Runtime>{
 if(selected!=='harness-desktop:e6'&&!/^sha256:[a-f0-9]{64}$/u.test(selected))throw new OperatorError('HARNESS_DESKTOP_IMAGE_ID must be an immutable sha256 image ID.');
 const result=await run(docker,['image','inspect',selected],{timeoutMs:10000,maxOutputBytes:1024*1024});
 if(result.code!==0||result.timedOut||result.outputLimited)throw new OperatorError('Linux desktop image is unavailable. Use harness desktop image to prepare it.');
 const metadata=JSON.parse(result.stdout)[0];
 if(metadata?.Os!=='linux'||!/^sha256:[a-f0-9]{64}$/u.test(metadata.Id)||!['arm64','amd64'].includes(metadata.Architecture)||(selected!=='harness-desktop:e6'&&selected!==metadata.Id))throw new OperatorError('Desktop image must be immutable Linux arm64 or x64.');
 const work=await realpath(await mkdtemp(path.join(os.tmpdir(),'harness-desktop-probe-')));
 try{
  const layout=desktopLayout(docker,metadata.Id,work);
  const probe=await runContained(layout,buildVerificationArguments(layout,'none',['timeout','-k','3','15','node','/harness-instrumentation/probe.mjs']),{timeoutMs:20000,maxOutputBytes:10000});
  if(probe.code!==0||probe.timedOut||probe.outputLimited)throw new OperatorError(`Desktop image tools are missing or incompatible. Rebuild with harness desktop image. ${probe.stderr.slice(-1500)}`);
  const facts=JSON.parse(probe.stdout),protocol=sha256(Buffer.concat(await Promise.all(['driver.mjs','package.mjs','probe.mjs','../schema.ts','../runtime.ts'].map(f=>readFile(path.join(desktopResources,f))))));
  if(facts.electron!=='44.3.0'||facts.playwright!=='1.63.0'||facts.asar!=='4.3.0'||facts.node!=='v26.5.0'||facts.arch!==(metadata.Architecture==='amd64'?'x64':'arm64'))throw new OperatorError('Desktop image toolchain differs from this harness release.');
  return {image:metadata.Id,...facts,protocol};
 }finally{await rm(work,{recursive:true,force:true});}
}
export async function buildDesktopImage(notify:(message:string)=>void):Promise<void>{
 const result=await run(desktopDocker(),['build','-t','harness-desktop:e6',path.resolve(desktopResources,'../../../containers/desktop')],{timeoutMs:1200000,maxOutputBytes:2*1024*1024,onOutput:notify});
 if(result.code!==0||result.timedOut||result.outputLimited)throw new OperatorError(`Desktop image preparation failed. ${result.stderr.slice(-4000)}`);
 notify('Linux desktop image prepared. Existing approvals keep their original image.');
}
