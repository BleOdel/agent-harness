import {cp,rm} from 'node:fs/promises';import path from 'node:path';
import {run} from '../run.ts';import {withWriter} from '../workspace/writer-lock.ts';import {safeDirectory} from '../artifacts/store.ts';
import {runtimeRoot,configureTorch} from './runtime.ts';
async function command(exe:string,args:string[],notify:(s:string)=>void,timeoutMs=600000){const r=await run(exe,args,{timeoutMs,maxOutputBytes:2*1024*1024,onOutput:s=>notify(s.trim())});if(r.code!==0||r.timedOut||r.outputLimited)throw Error(`${path.basename(exe)} preparation failed: ${r.stderr.slice(-3000)}`);return r;}
export async function prepareTorchBytes(mode:'cpu'|'mac'|'model',notify:(s:string)=>void=()=>{}){
 await safeDirectory(runtimeRoot);const target=path.join(runtimeRoot,mode);await safeDirectory(target);
 await withWriter(runtimeRoot,'PyTorch downloads',async()=>{notify(`Downloading checksum-pinned ${mode} files. No model or project code runs on your host.`);await command('python3',[import.meta.dirname+'/download.py',mode,target],notify);});return target;
}
export async function provisionTorch(notify:(s:string)=>void=()=>{}){
 if(process.arch!=='arm64')throw Error('The initial CPU wheel manifest supports Linux arm64 containers only.');
 const wheels=await prepareTorchBytes('cpu',notify),docker=process.env.HARNESS_DOCKER?.trim()||'docker';
 return withWriter(runtimeRoot,'PyTorch image preparation',async()=>{
  const inspect=await run(docker,['image','inspect','harness-python:e2','--format','{{.Id}}'],{timeoutMs:10000});if(inspect.code!==0)throw Error('Build containers/python.Dockerfile as harness-python:e2 first. See PYTORCH.md.');const base=inspect.stdout.trim();if(!/^sha256:[a-f0-9]{64}$/u.test(base))throw Error('Invalid Python base image.');
  const tag='harness-torch-base:'+base.slice(7),context=runtimeRoot+'/build';await safeDirectory(context);
  try{
   await command(docker,['tag',base,tag],notify);await cp(path.resolve(import.meta.dirname,'../../containers/torch/Dockerfile'),context+'/Dockerfile');await cp(path.resolve(import.meta.dirname,'../../containers/torch/requirements.lock'),context+'/requirements.lock');await cp(wheels,context+'/wheels',{recursive:true});
   notify('Building CPU-only tools from local wheels; image build network is disabled.');await command(docker,['build','--network=none','--build-arg','BASE='+tag,'-t','harness-torch:p1',context],notify);
   const image=(await command(docker,['image','inspect','harness-torch:p1','--format','{{.Id}}'],()=>{})).stdout.trim();return configureTorch(image);
  }finally{await rm(context,{recursive:true,force:true});await run(docker,['image','rm',tag],{timeoutMs:10000,maxOutputBytes:1000});}
 });
}
