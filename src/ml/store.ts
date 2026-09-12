/** Approved data and holdout labels never enter a job's writable or readonly mounts. */
import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { readJson, safeDirectory, saveJson, stateRoot } from '../artifacts/store.ts';
import { safePath } from '../workspace/safe-path.ts';
import { syncDirectory } from '../workspace/atomic.ts';
import { sourceFiles } from '../workspace/candidate.ts';
import { readProfile } from '../project/profile.ts';
import { getAdapter } from '../adapters/registry.ts';
import { OperatorError } from '../verbs/io.ts';
import { containsProtectedCsvRows, fingerprint, hash, parseDataset, parseMlSpec, splitDataset, type Dataset, type MlSpec, type ModelContext, type Row, type Preprocessing } from './schema.ts';
export const resources=import.meta.dirname;
export interface MlApproval {version:1;id:string;approvedAt:string;spec:MlSpec;schema:{features:string[];target:string};dataset:{sourceHash:string;trainHash:string;holdoutHash:string;trainIds:string[];holdoutIds:string[]};preprocessing:Preprocessing;baseline:number;recipe:string;digest:string;}
export interface MlState {version:1;id:string;jobId?:string;candidateHash?:string;report?:string;modelArtifact?:string;status:'approved'|'training'|'ready'|'evaluating'|'passed'|'failed'|'released';reason?:string;}
export interface ApprovedData {approval:MlApproval;train:Row[];holdout:Row[];}
export async function recipeHash():Promise<string>{return fingerprint(await Promise.all(['train.py','predict.py','schema.ts','evaluation.ts','recipe.ts','store.ts','workflow.ts'].map(async name=>[name,hash(await readFile(path.join(resources,name)))])));}
export async function mlRoot(project:string):Promise<string>{const root=path.join(await stateRoot(project),'ml');await safeDirectory(root);return root;}
export async function mlDirectory(project:string,id:string):Promise<string>{
 if(!/^ml-[a-f0-9-]{36}$/u.test(id))throw new OperatorError('Invalid ML approval ID. Use harness ml list.');
 const root=path.join(await mlRoot(project),id);await lstat(root).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')throw new OperatorError('Unknown ML approval. Use harness ml list.');throw e;});await safeDirectory(root);return root;
}
export async function loadCsv(project:string,file:string,target:string):Promise<{data:Dataset;sourceHash:string}>{
 const absolute=path.resolve(file),parent=await realpath(path.dirname(absolute)),actual=await safePath(parent,path.basename(absolute)),live=await realpath(project),state=await stateRoot(project);
 if([live,state].some(root=>actual===root||actual.startsWith(root+path.sep)))throw new OperatorError('Keep the dataset outside project source and harness state; select an external CSV file.');
 if((await lstat(actual)).size>2*1024*1024)throw new OperatorError('Dataset exceeds 2 MiB.');
 const bytes=await readFile(actual);return {data:parseDataset(bytes.toString('utf8'),target),sourceHash:hash(bytes)};
}
function body(a:MlApproval):Omit<MlApproval,'digest'>{const {digest:_,...value}=a;return value;}
export async function approveMl(project:string,file:string,raw:unknown,expectedSourceHash?:string):Promise<MlApproval>{
 if((await readProfile(project)).adapter.id!=='python-pip')throw new OperatorError('CPU ML requires a Python project. Use harness init --python in an empty project, then select the Python image.');
 const spec=parseMlSpec(raw),{data,sourceHash}=await loadCsv(project,file,spec.target),split=splitDataset(data,spec.seed);
 if(expectedSourceHash&&expectedSourceHash!==sourceHash)throw new OperatorError('Dataset changed after the approval preview. Review it again.');
 if([split.train,split.holdout].some(rows=>Buffer.byteLength(JSON.stringify(rows,null,2)+'\n')>2*1024*1024))throw new OperatorError('Expanded ML data exceeds the 2 MiB state-file limit. Use fewer rows or predictors.');
 const value={version:1 as const,id:`ml-${randomUUID()}`,approvedAt:new Date().toISOString(),spec,schema:{features:data.features,target:data.target},dataset:{sourceHash,trainHash:fingerprint(split.train),holdoutHash:fingerprint(split.holdout),trainIds:split.train.map(r=>r.id),holdoutIds:split.holdout.map(r=>r.id)},preprocessing:split.preprocessing,baseline:split.baseline,recipe:await recipeHash()};
 const approval={...value,digest:fingerprint(value)};
 await assertNoProtectedSource(project,{approval,...split});
 const root=await mlRoot(project),pending=path.join(root,`.pending-${approval.id}`);await safeDirectory(pending);
 try{
  await saveJson(pending,'approved.json',approval);await saveJson(pending,'train.json',split.train);await saveJson(pending,'holdout.json',split.holdout);await saveJson(pending,'state.json',{version:1,id:approval.id,status:'approved'});
  await rename(pending,path.join(root,approval.id));await syncDirectory(root);
 }finally{await rm(pending,{recursive:true,force:true});}return approval;
}
export async function readMl(project:string,id:string):Promise<ApprovedData>{
 const root=await mlDirectory(project,id),approval=await readJson(root,'approved.json') as MlApproval;
 if(!approval||approval.version!==1||approval.id!==id||approval.digest!==fingerprint(body(approval)))throw new OperatorError('ML approval changed or is invalid. Restore it before continuing.');
 parseMlSpec(approval.spec);
 const train=await readJson(root,'train.json') as Row[],holdout=await readJson(root,'holdout.json') as Row[];
 if(fingerprint(train)!==approval.dataset.trainHash||fingerprint(holdout)!==approval.dataset.holdoutHash)throw new OperatorError('Approved training data or protected holdout changed.');
 if(!Array.isArray(train)||!Array.isArray(holdout)||JSON.stringify(train.map(r=>r.id))!==JSON.stringify(approval.dataset.trainIds)||JSON.stringify(holdout.map(r=>r.id))!==JSON.stringify(approval.dataset.holdoutIds))throw new OperatorError('Immutable split membership changed.');
 const ids=new Set(train.map(r=>r.id)),inputs=new Set(train.map(r=>JSON.stringify(r.x)));
 if(holdout.some(r=>ids.has(r.id)||inputs.has(JSON.stringify(r.x))))throw new OperatorError('Training/holdout overlap detected.');
 return {approval,train,holdout};
}
export async function readMlState(project:string,id:string):Promise<MlState>{const state=await readJson(await mlDirectory(project,id),'state.json') as MlState;if(!state||state.version!==1||state.id!==id||!['approved','training','ready','evaluating','passed','failed','released'].includes(state.status))throw new OperatorError('Invalid ML run state.');return state;}
export async function saveMlState(project:string,state:MlState):Promise<void>{await saveJson(await mlDirectory(project,state.id),'state.json',state);}
export async function listMl(project:string):Promise<MlApproval[]>{const result:MlApproval[]=[];for(const id of await readdir(await mlRoot(project)))if(/^ml-[a-f0-9-]{36}$/u.test(id))result.push((await readMl(project,id)).approval);return result.sort((a,b)=>a.approvedAt.localeCompare(b.approvedAt));}
export function modelContext(a:MlApproval):ModelContext{return {approval:a.digest,features:a.schema.features,target:a.schema.target,preprocessing:a.preprocessing,training:{seed:a.spec.seed,epochs:a.spec.epochs,learningRate:a.spec.learningRate}};}
/** These checks catch known copies; no generic scan can prove absence of encoded or semantic leakage. */
export async function assertNoProtectedSource(project:string,data:ApprovedData):Promise<void>{
 const adapter=getAdapter((await readProfile(project)).adapter),files=await sourceFiles(project,'',adapter.source.generatedDirectories);
 const ids=new Set(data.holdout.map(r=>r.id));
 for(const [file,digest] of Object.entries(files)){
  if(digest===data.approval.dataset.sourceHash)throw new OperatorError(`Protected dataset was copied into project source: ${file}. Move datasets outside the project.`);
  if(!/\.(?:csv|json)$/iu.test(file))continue;
  let rows:Row[]=[];
  const text=await readFile(path.join(project,file),'utf8');
  let csvLeak=false;
  try{if(file.toLowerCase().endsWith('.csv'))csvLeak=containsProtectedCsvRows(text,data.approval.spec.target,ids);else{const raw=JSON.parse(text);rows=Array.isArray(raw)?raw:Array.isArray(raw?.rows)?raw.rows:[];}}catch{continue;}
  if(csvLeak)throw new OperatorError(`Protected holdout rows found in project source: ${file}.`);
  if(rows.some(r=>r&&ids.has(r.id)&&Array.isArray(r.x)&&typeof r.y==='number'))throw new OperatorError(`Protected holdout rows found in project source: ${file}.`);
 }
}
