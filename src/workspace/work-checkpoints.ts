/** Unverified source checkpoints live outside the project and are never applied directly. */
import {lstat,mkdir,mkdtemp,readdir,realpath,rename,rm,rmdir,open} from 'node:fs/promises';
import path from 'node:path';
import {assertSnapshot,captureBaseline,copySource,sourceFiles,type Snapshot} from './candidate.ts';
import {EXCLUDED_FROM_COPY,NEVER_APPLIED} from './changes.ts';
import {atomicBytes,syncDirectory} from './atomic.ts';
import {harnessDirectory} from '../record/record.ts';
import {readArtifact} from '../planning/store.ts';
import {OperatorError} from '../verbs/io.ts';
export interface CheckpointInputs {
 goal:string;workDigest:string;approvalDigest:string;executionDigest:string;
 baseline:Pick<Snapshot,'digest'|'controls'|'exclusions'>;
}
interface State extends CheckpointInputs {
 version:1;project:string;runId:string;savedAt:string;attempt:number;instruction:string;
 partial:Pick<Snapshot,'digest'|'files'|'exclusions'>;
 status:'available'|'completed'|'superseded'|'discarded';updatedBy?:string;
}
export interface WorkCheckpoint extends State {directory:string;}
const root=(project:string)=>path.join(harnessDirectory(project),'implementation');
const validId=(id:string)=>/^r[1-9][0-9]*$/.test(id);
const hex=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const remedy='Saved work was retained. Restore the original inputs, or use harness work --fresh <item-id> to start from the current project.';
async function boundedSource(directory:string,exclusions:readonly string[]):Promise<void>{
 let bytes=0,count=0;
 async function walk(prefix=''):Promise<void>{for(const entry of await readdir(path.join(directory,prefix),{withFileTypes:true})){
  if(exclusions.includes(entry.name)||NEVER_APPLIED.has(entry.name)||(!prefix&&(EXCLUDED_FROM_COPY.has(entry.name)||entry.name==='.harness-claim.json')))continue;
  const relative=prefix?`${prefix}/${entry.name}`:entry.name,stat=await lstat(path.join(directory,relative));
  if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory())||(stat.isFile()&&stat.nlink!==1))throw new OperatorError(`Cannot checkpoint ${relative}: symlink, hard link or special file.`);
  if(stat.isDirectory())await walk(relative);
  else {bytes+=stat.size;if(++count>10000||stat.size>8*1024*1024||bytes>64*1024*1024)throw new OperatorError('Partial source exceeds checkpoint limits (10,000 files, 8 MiB per file, 64 MiB total).');}
 }}
 await walk();
}
async function writeState(checkpoint:WorkCheckpoint):Promise<void>{const {directory,...state}=checkpoint;const bytes=Buffer.from(JSON.stringify(state,null,2)+'\n');if(bytes.length>4*1024*1024)throw new OperatorError('Checkpoint metadata exceeds the 4 MiB limit.');await atomicBytes(path.join(directory,'state.json'),bytes,0o600);}
export async function saveWorkCheckpoint(project:string,runId:string,worker:string,input:CheckpointInputs&{attempt:number;instruction:string}):Promise<WorkCheckpoint>{
 project=await realpath(project);if(!validId(runId))throw new OperatorError('Invalid checkpoint run id.');
 await boundedSource(worker,input.baseline.exclusions??[]);
 await mkdir(root(project),{recursive:true,mode:0o700});const pending=await mkdtemp(path.join(root(project),'.pending-'));
 try {
  const partial=await captureBaseline(worker,path.join(pending,'source'),input.baseline.exclusions);
  const state:WorkCheckpoint={...input,baseline:{digest:input.baseline.digest,...(input.baseline.controls?{controls:input.baseline.controls}:{}),...(input.baseline.exclusions?{exclusions:input.baseline.exclusions}:{})},version:1,project,runId,savedAt:new Date().toISOString(),partial:{digest:partial.digest,files:partial.files,...(partial.exclusions?{exclusions:partial.exclusions}:{})},status:'available',directory:pending};
  // Flush source bytes before publishing the manifest; a visible checkpoint is complete.
  for (const file of Object.keys(partial.files)) {const h=await open(path.join(pending,'source',file),'r');try{await h.sync();}finally{await h.close();}}
  const directories=new Set(['source']);for(const file of Object.keys(partial.files)){let d=path.posix.dirname(`source/${file}`);while(d!=='.'){directories.add(d);d=path.posix.dirname(d);}}
  for(const d of [...directories].sort((a,b)=>b.length-a.length))await syncDirectory(path.join(pending,d));
  await rm(path.join(pending,'source.json'));
  await writeState(state);const directory=path.join(root(project),runId);await rename(pending,directory);await syncDirectory(root(project));return {...state,directory};
 }finally{await rm(pending,{recursive:true,force:true});}
}
async function readCheckpoint(project:string,runId:string):Promise<WorkCheckpoint|undefined>{
 if(!validId(runId))throw new OperatorError('Invalid checkpoint run id.');const directory=path.join(root(project),runId);
 const stat=await lstat(directory).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return undefined;throw e;});if(!stat)return;
 if(!stat.isDirectory()||stat.isSymbolicLink())throw new OperatorError('Checkpoint must be a real directory.');
 const raw=await readArtifact(directory,'state.json',4*1024*1024);if(!raw)return;
 const s=JSON.parse(raw) as State;
 if(!s||s.version!==1||s.project!==project||s.runId!==runId||typeof s.goal!=='string'||!s.goal||typeof s.instruction!=='string'||!s.instruction||![1,2].includes(s.attempt)||!['available','completed','superseded','discarded'].includes(s.status)||![s.workDigest,s.approvalDigest,s.executionDigest,s.baseline?.digest,s.partial?.digest].every(hex)||!s.partial?.files||typeof s.partial.files!=='object'||Array.isArray(s.partial.files))throw new OperatorError('Invalid saved implementation checkpoint.',remedy);
 for(const exclusions of [s.baseline.exclusions,s.partial.exclusions])if(exclusions!==undefined&&(!Array.isArray(exclusions)||exclusions.some(v=>typeof v!=='string')))throw new OperatorError('Invalid checkpoint exclusions.');
 if(JSON.stringify(s.baseline.exclusions??[])!==JSON.stringify(s.partial.exclusions??[])||(s.baseline.controls!==undefined&&!hex(s.baseline.controls)))throw new OperatorError('Invalid checkpoint source identity.');
 return {...s,directory};
}
export async function listWorkCheckpoints(project:string):Promise<WorkCheckpoint[]>{
 project=await realpath(project);const entries=await readdir(root(project)).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return [];throw e;});const result:WorkCheckpoint[]=[];
 for(const id of entries.filter(validId).sort((a,b)=>Number(b.slice(1))-Number(a.slice(1)))){const c=await readCheckpoint(project,id);if(c?.status==='available')result.push(c);}
 return result;
}
export async function findWorkCheckpoint(project:string,goal?:string,runId?:string):Promise<WorkCheckpoint|undefined>{
 project=await realpath(project);
 if(runId){const c=await readCheckpoint(project,runId);if(!c||c.status!=='available')throw new OperatorError(`No available implementation checkpoint for ${runId}.`);if(goal!==undefined&&c.goal!==goal)throw new OperatorError('Checkpoint belongs to a different task.');return c;}
 return (await listWorkCheckpoints(project)).find(c=>c.goal===goal);
}
export function assertCheckpointInputs(c:WorkCheckpoint,input:CheckpointInputs):void{
 for(const name of ['goal','workDigest','approvalDigest','executionDigest'] as const)if(c[name]!==input[name])throw new OperatorError(`Cannot resume ${c.runId}: ${name} changed.`,remedy);
 if(c.baseline.digest!==input.baseline.digest||c.baseline.controls!==input.baseline.controls||JSON.stringify(c.baseline.exclusions??[])!==JSON.stringify(input.baseline.exclusions??[]))throw new OperatorError(`Cannot resume ${c.runId}: project source or requirements changed.`,remedy);
}
export async function restoreWorkCheckpoint(c:WorkCheckpoint,target:string):Promise<void>{
 const directory=path.join(c.directory,'source'),stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new OperatorError('Checkpoint source must be a real directory.');
 await boundedSource(directory,c.partial.exclusions??[]);await assertSnapshot({...c.partial,directory});
 await mkdir(target,{recursive:true});
 const parents=new Set<string>();
 for(const file of Object.keys(await sourceFiles(target,'',c.partial.exclusions))){await rm(path.join(target,file));let d=path.dirname(file);while(d!=='.'){parents.add(d);d=path.dirname(d);}}
 // Remove only empty source directories: an old directory may now be a file.
 for(const d of [...parents].sort((a,b)=>b.length-a.length))await rmdir(path.join(target,d)).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='ENOTEMPTY'&&error.code!=='ENOENT')throw error;});
 // A previous claim cannot stand in for completion after an interruption.
 await rm(path.join(target,'.harness-claim.json'),{force:true});await copySource(directory,target,c.partial.exclusions);
 await assertSnapshot({...c.partial,directory:target});
}
export async function retireWorkCheckpoint(c:WorkCheckpoint,status:'completed'|'superseded'|'discarded',updatedBy:string):Promise<void>{await writeState({...c,status,updatedBy});}
