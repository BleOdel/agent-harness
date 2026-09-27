import {randomUUID} from 'node:crypto';import {readdir,rename,rm} from 'node:fs/promises';import path from 'node:path';
import {stateRoot,safeDirectory,saveJson,readJson} from '../artifacts/store.ts';import {syncDirectory} from '../workspace/atomic.ts';
import {fingerprint,splitDataset,type Row,type Preprocessing,type Assessment} from '../ml/schema.ts';import {loadCsv} from '../ml/store.ts';
import {parseMetalSpec,validateCheckpoint,type MetalSpec,type Checkpoint} from './schema.ts';import type {MetalRuntime} from './runtime.ts';
export interface MetalApproval {version:1;id:string;at:string;spec:MetalSpec;runtime:MetalRuntime;sourceHash:string;trainHash:string;holdoutHash:string;features:string[];preprocessing:Preprocessing;baseline:number;digest:string;}
export interface Attempt {index:number;from:number;to:number;status:'running'|'completed'|'interrupted';}
export interface MetalState {version:1;id:string;status:'approved'|'running'|'paused'|'trained'|'passed'|'failed'|'released';attempts:Attempt[];controllerPid?:number;checkpoint?:Checkpoint;checkpointHash?:string;evaluatedHash?:string;assessment?:Assessment;artifact?:string;message?:string;}
export async function metalRoot(project:string){const root=path.join(await stateRoot(project),'metal');await safeDirectory(root);return root;}
export async function metalDirectory(project:string,id:string){if(!/^metal-[a-f0-9-]{36}$/u.test(id))throw Error('Invalid Metal workflow ID. Use harness metal list.');const root=path.join(await metalRoot(project),id);await safeDirectory(root);return root;}
export async function approveMetal(project:string,file:string,raw:unknown,runtime:MetalRuntime,expectedSourceHash?:string){
 const spec=parseMetalSpec(raw),{data,sourceHash}=await loadCsv(project,file,spec.target),split=splitDataset(data,spec.seed);
 if(data.rows.length>2000)throw Error('This Metal recipe supports at most 2000 rows.');if(expectedSourceHash&&sourceHash!==expectedSourceHash)throw Error('Dataset changed after preview. Review it again.');
 const value={version:1 as const,id:'metal-'+randomUUID(),at:new Date().toISOString(),spec,runtime,sourceHash,trainHash:fingerprint(split.train),holdoutHash:fingerprint(split.holdout),features:data.features,preprocessing:split.preprocessing,baseline:split.baseline},a={...value,digest:fingerprint(value)};
 const root=await metalRoot(project),pending=path.join(root,'.pending-'+a.id);await safeDirectory(pending);
 try{await saveJson(pending,'approved.json',a);await saveJson(pending,'train.json',split.train);await saveJson(pending,'holdout.json',split.holdout);await saveJson(pending,'state.json',{version:1,id:a.id,status:'approved',attempts:[]});await rename(pending,path.join(root,a.id));await syncDirectory(root);}finally{await rm(pending,{recursive:true,force:true});}return a;
}
export async function readMetal(project:string,id:string){const root=await metalDirectory(project,id),a=await readJson(root,'approved.json') as MetalApproval;const {digest,...body}=a;if(a.version!==1||a.id!==id||digest!==fingerprint(body))throw Error('Metal approval changed. Restore the approved settings.');parseMetalSpec(a.spec);
 const train=await readJson(root,'train.json') as Row[],holdout=await readJson(root,'holdout.json') as Row[];if(fingerprint(train)!==a.trainHash||fingerprint(holdout)!==a.holdoutHash)throw Error('Metal dataset or immutable split changed.');return {approval:a,train,holdout};}
export async function readMetalState(project:string,id:string):Promise<MetalState>{
 const {approval:a}=await readMetal(project,id),s=await readJson(await metalDirectory(project,id),'state.json') as MetalState;
 if(s.version!==1||s.id!==id||!['approved','running','paused','trained','passed','failed','released'].includes(s.status)||!Array.isArray(s.attempts)||s.attempts.length>a.spec.limits.maxAttempts||s.attempts.length*a.spec.limits.timeoutSeconds>a.spec.limits.totalSeconds)throw Error('Invalid Metal workflow state or budget.');
 if(s.status==='running'&&(!Number.isSafeInteger(s.controllerPid)||Number(s.controllerPid)<1))throw Error('Invalid Metal controller identity.');
 let completed=0;for(const [i,t]of s.attempts.entries()){if(t.index!==i+1||t.from!==completed||t.to!==Math.min(completed+a.spec.checkpointEvery,a.spec.epochs)||!['running','completed','interrupted'].includes(t.status)||(t.status==='running'&&i!==s.attempts.length-1))throw Error('Invalid Metal attempt progress.');if(t.status==='completed')completed=t.to;}
 if((s.status==='running')!==(s.attempts.at(-1)?.status==='running'))throw Error('Metal active attempt is inconsistent.');
 if(s.checkpoint){const last=s.attempts.filter(t=>t.status==='completed').at(-1);if(!last||s.checkpointHash!==fingerprint(s.checkpoint))throw Error('Metal checkpoint is corrupt.');validateCheckpoint(s.checkpoint,a,last.from,last.to);if(s.checkpoint.model.completed!==completed)throw Error('Checkpoint progress changed.');}else if(completed)throw Error('Metal checkpoint is missing.');
 if(['trained','passed','failed'].includes(s.status)&&completed!==a.spec.epochs)throw Error('Metal model is not complete.');if(s.evaluatedHash&&(!s.checkpoint||s.evaluatedHash!==fingerprint(s.checkpoint.model)))throw Error('Evaluated model identity changed.');return s;
}
export async function saveMetalState(project:string,s:MetalState){await saveJson(await metalDirectory(project,s.id),'state.json',s);}
export async function listMetal(project:string){const all:MetalApproval[]=[];for(const id of await readdir(await metalRoot(project)))if(/^metal-[a-f0-9-]{36}$/u.test(id))all.push((await readMetal(project,id)).approval);return all.sort((a,b)=>a.at.localeCompare(b.at));}
