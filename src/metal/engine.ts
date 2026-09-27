import {mkdir,copyFile,writeFile,lstat,readFile} from 'node:fs/promises';import path from 'node:path';
import {artifactBytes,listArtifacts} from '../artifacts/store.ts';import {writerPath,recoverWriter} from '../workspace/writer-lock.ts';
import {approveNative,listNativeRuns,type NativeRun} from '../native/store.ts';import {verifyNative,recoverNative} from '../native/controller.ts';
import {metalDirectory,type MetalApproval,type Attempt} from './store.ts';import {trainingInput,type Checkpoint} from './schema.ts';import {resources} from './runtime.ts';import type {Row} from '../ml/schema.ts';
export async function candidatePath(project:string,id:string,index:number){if(!Number.isInteger(index)||index<1||index>8)throw Error('Invalid segment index.');return path.join(await metalDirectory(project,id),'segment-'+index);}
async function completedResult(candidate:string,r:NativeRun){
 const all=await listArtifacts(candidate),checkpoint=all.find(a=>r.artifacts.includes(a.id)&&a.name==='checkpoint.json');
 if(!checkpoint)throw Error('Metal segment has no retained checkpoint.');return JSON.parse((await artifactBytes(candidate,checkpoint.id)).toString());
}
export async function runSegment(project:string,a:MetalApproval,rows:Row[],prior:Checkpoint|null,to:number,attempt:Attempt,notify:(s:string)=>void){
 const candidate=await candidatePath(project,a.id,attempt.index);await mkdir(candidate);
 for(const name of ['train.swift','run.sh'])await copyFile(path.join(resources,name),path.join(candidate,name));
 await writeFile(candidate+'/input.json',JSON.stringify(trainingInput(a,rows,prior,to)),{mode:0o600});await writeFile(candidate+'/package.json','{"name":"harness-metal-training","private":true}');
 const approval=await approveNative(candidate,{version:1,title:a.spec.title,entry:'run.sh',timeoutSeconds:a.spec.limits.timeoutSeconds,expectedExit:0,stdout:'Metal checkpoint ready\n',artifacts:['checkpoint.json']},a.runtime.profile);
 const r=await verifyNative(candidate,approval.id,notify);
 if(r.status!=='passed'){const files=await listArtifacts(candidate),stderr=files.find(f=>r.artifacts.includes(f.id)&&f.name==='stderr.txt');throw Error(r.message+(stderr?'\n'+(await artifactBytes(candidate,stderr.id)).toString().slice(-2000):''));}
 return completedResult(candidate,r);
}
export async function recoverOwnedNative(project:string,id:string,recover=recoverNative,pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))){
 // Tart can acknowledge stop before its process leaves the inventory. Never
 // release resources on that acknowledgement alone; retry the existing gate.
 for(let i=0;;i++){try{return await recover(project,id);}catch(e){if(i>=4||(e as Error).message!=='Cannot confirm VM stopped; files retained.')throw e;await pause(1000);}}
}
export async function recoverSegment(project:string,a:MetalApproval,attempt:Attempt){
 const candidate=await candidatePath(project,a.id,attempt.index);if(!await lstat(candidate).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return null;throw e;}))return null;
 const runs=await listNativeRuns(candidate);if(runs.length>1)throw Error('Unexpected extra native runs for one Metal segment.');
 const r=runs[0];if(r&&['preparing','running'].includes(r.status))await recoverOwnedNative(candidate,r.id);
 // Covers a crash after taking the candidate lock but before writing a native run record.
 const lock=await readFile(await writerPath(candidate),'utf8').then(s=>JSON.parse(s)).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return null;throw e;});if(lock)await recoverWriter(candidate,lock.token);
 return r?.status==='passed'?completedResult(candidate,r):null;
}
