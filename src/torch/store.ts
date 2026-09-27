import {readProfile} from '../project/profile.ts';
import {randomUUID} from 'node:crypto';
import {lstat,readFile,readdir,realpath,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {safeDirectory,stateRoot,readJson,saveJson} from '../artifacts/store.ts';
import {fingerprint,hash} from '../ml/schema.ts';
import {safePath} from '../workspace/safe-path.ts';
import {sourceFiles} from '../workspace/candidate.ts';
import {parseTorchData,parseTorchSpec,splitTorchData,type TorchRow,type TorchSpec} from './schema.ts';
export const resources=import.meta.dirname;
export const recipeHash=async()=>fingerprint(await Promise.all(['train.py','predict.py','schema.ts','store.ts','recipe.ts','workflow.ts'].map(async f=>[f,hash(await readFile(path.join(resources,f)))])));
export interface TorchApproval {version:1;id:string;spec:TorchSpec;features:string[];means:number[];scales:number[];trainHash:string;holdoutHash:string;sourceHash:string;recipe:string;image:string;digest:string;}
export interface TorchState {id:string;status:'approved'|'training'|'passed'|'failed'|'released';jobId?:string;candidateHash?:string;report?:any;artifact?:string;}
export async function torchRoot(project:string){const p=path.join(await stateRoot(project),'torch');await safeDirectory(p);return p;}
export async function torchDirectory(project:string,id:string){if(!/^torch-[a-f0-9-]{36}$/u.test(id))throw Error('Invalid PyTorch approval ID.');const p=path.join(await torchRoot(project),id);await lstat(p);await safeDirectory(p);return p;}
export async function readTorchState(project:string,id:string){return await readJson(await torchDirectory(project,id),'state.json') as TorchState;}
export async function saveTorchState(project:string,s:TorchState){await saveJson(await torchDirectory(project,s.id),'state.json',s);}
export async function readTorch(project:string,id:string){
 const p=await torchDirectory(project,id),a=await readJson(p,'approved.json') as TorchApproval,{digest,...body}=a;
 if(a.id!==id||fingerprint(body)!==digest)throw Error('PyTorch approval changed.');parseTorchSpec(a.spec);
 const train=await readJson(p,'train.json') as TorchRow[],holdout=await readJson(p,'holdout.json') as TorchRow[];
 if(fingerprint(train)!==a.trainHash||fingerprint(holdout)!==a.holdoutHash)throw Error('Frozen PyTorch data changed.');
 return {approval:a,train,holdout};
}
export async function listTorch(project:string){return (await readdir(await torchRoot(project))).filter(id=>/^torch-[a-f0-9-]{36}$/u.test(id));}
export async function assertTorchSource(project:string,a:TorchApproval,holdout:TorchRow[]){
 const files=await sourceFiles(project,'',['.venv','__pycache__','.harness-python','dist','build']),ids=new Set(holdout.map(r=>r.id));
 for(const [file,digest] of Object.entries(files)){
  if(digest===a.sourceHash)throw Error('Move the dataset outside project source.');
  if(file.endsWith('.json')){let rows:any;try{const raw=JSON.parse(await readFile(path.join(project,file),'utf8'));rows=Array.isArray(raw)?raw:raw.rows;}catch{continue;}
   if(Array.isArray(rows)&&rows.some(r=>r&&ids.has(r.id)&&Array.isArray(r.x)))throw Error('Protected holdout rows found in project source.');}
 }
}
export async function approveTorch(project:string,file:string,raw:unknown,image:string){
 if((await readProfile(project)).adapter.id!=='python-pip')throw Error('Use a Python project: harness init --python in an empty directory.');
 if(!/^sha256:[a-f0-9]{64}$/u.test(image))throw Error('PyTorch needs an immutable image ID.');
 const absolute=path.resolve(file),actual=await safePath(await realpath(path.dirname(absolute)),path.basename(absolute));
 for(const root of [await realpath(project),await stateRoot(project)])if(actual===root||actual.startsWith(root+path.sep))throw Error('Select a dataset outside project source and state.');
 if((await lstat(actual)).size>1024*1024)throw Error('Dataset exceeds 1 MiB.');
 const bytes=await readFile(actual),spec=parseTorchSpec(raw),data=parseTorchData(JSON.parse(bytes.toString()),spec.kind),{train,holdout,means,scales}=splitTorchData(data,spec.seed);
 if(spec.kind==='classifier'&&[train,holdout].some(rows=>new Set(rows.map(r=>r.y)).size!==2))throw Error('Both splits must contain both classes. Choose more representative data.');
 const body={version:1 as const,id:`torch-${randomUUID()}`,spec,features:data.features,means,scales,trainHash:fingerprint(train),holdoutHash:fingerprint(holdout),sourceHash:hash(bytes),recipe:await recipeHash(),image};
 const a={...body,digest:fingerprint(body)};await assertTorchSource(project,a,holdout);
 const root=await torchRoot(project),pending=path.join(root,`.pending-${a.id}`);await safeDirectory(pending);
 try{await saveJson(pending,'approved.json',a);await saveJson(pending,'train.json',train);await saveJson(pending,'holdout.json',holdout);await saveJson(pending,'state.json',{id:a.id,status:'approved'});await rename(pending,path.join(root,a.id));}finally{await rm(pending,{recursive:true,force:true});}return a;
}
