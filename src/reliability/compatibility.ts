/** Compatibility boundaries only. Existing controllers retain their current record ownership. */
import {createHash} from 'node:crypto';
import {mkdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {parseFeatures} from '../features.ts';
import {readArtifact} from '../planning/store.ts';
import {atomicBytes} from '../workspace/atomic.ts';
import {safePath} from '../workspace/safe-path.ts';
import {withWriter,canonicalProject} from '../workspace/writer-lock.ts';
import {harnessDirectory} from '../record/record.ts';
import {atomicJson} from '../team/state.ts';
import {legacyReference,parseLifecycleRecord,transitionOperation,type LegacyReference,type OperationRecord,type OperationEvent} from './lifecycle.ts';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
function canonical(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
 return JSON.stringify(value);
}
function relativeFile(file:string):void {
 if(path.isAbsolute(file)||file.includes('\\')||file.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('Invalid operation path.');
}
/** Update an already-adopted owner file; never create a parallel operation index or rewrite legacy state. */
export async function updateOperationFile(project:string,file:string,expected:OperationRecord,event:OperationEvent):Promise<OperationRecord> {
 relativeFile(file);const wanted=parseLifecycleRecord(expected);if(wanted.kind!=='operation')throw Error('Expected operation record.');
 project=await canonicalProject(project);
 return withWriter(project,'lifecycle transition',async()=>{
  const root=harnessDirectory(project),target=await safePath(root,file);
  const raw=await readArtifact(root,file,1024*1024);
  if(raw===undefined)throw Error('Operation record is missing; explicit owner migration is required.');
  const current=parseLifecycleRecord(JSON.parse(raw));
  if(current.kind!=='operation'||canonical(current)!==canonical(wanted))throw Error('Stale operation or binding; reload the owner record.');
  const next=transitionOperation(current,wanted.revision,event);
  const stat=await lstat(target);if(!stat.isFile()||stat.nlink!==1)throw Error('Operation file must be a single regular file.');
  await atomicBytes(target,Buffer.from(JSON.stringify(next,null,2)+'\n'),0o600,path.dirname(target),async()=>{
   // Also detect a non-cooperating edit after our read, before replacement.
   if(await readArtifact(root,file,1024*1024)!==raw)throw Error('Stale operation changed before replacement.');
  });
  return next;
 });
}
export interface LegacyArchive {
 version:1;reference:LegacyReference;original:string;formatVersion:number;
 authority:'legacy-owner';validation:'inspection-only';
}
function inspect(owner:LegacyReference['owner'],original:string):LegacyArchive {
 if(typeof original!=='string'||Buffer.byteLength(original)>1024*1024)throw Error('Legacy JSON exceeds the 1 MiB inspection limit.');
 legacyReference(owner,hash(original));
 const raw=JSON.parse(original) as Record<string,unknown>;
 let version=0;
 if(owner==='features'){
  const result=parseFeatures(original);if(!result.ok)throw Error('Invalid legacy features: '+result.reason);
 }else{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid legacy state.');
  const allowed=owner==='team'?[1,2,3,4]:[1];
  if(typeof raw.version!=='number'||!allowed.includes(raw.version))throw Error('Unsupported legacy version.');
  version=raw.version;
  const id=owner==='stage'?raw.id:owner==='team'?raw.runId:owner==='implementation'?raw.runId:raw.taskId;
  if(typeof id!=='string'||!id.trim())throw Error('Missing legacy identity.');
  const field=owner==='preparation'?'state':owner==='review-progress'?'proposal':owner==='implementation'?'partial':owner==='stage'?'candidate':'plan';
  if(!raw[field]||typeof raw[field]!=='object'||Array.isArray(raw[field]))throw Error('Missing legacy state.');
 }
 return {version:1,reference:legacyReference(owner,hash(original)),original,formatVersion:version,authority:'legacy-owner',validation:'inspection-only'};
}
export async function readLegacyArchive(file:string):Promise<LegacyArchive> {
 const raw=await readArtifact(path.dirname(file),path.basename(file),8*1024*1024);
 if(raw===undefined)throw Error('Legacy archive is missing.');
 const a=JSON.parse(raw) as LegacyArchive;
 if(!a||a.version!==1||Object.keys(a).sort().join(',')!=='authority,formatVersion,original,reference,validation,version'||a.authority!=='legacy-owner'||a.validation!=='inspection-only')throw Error('Invalid legacy archive.');
 const expected=inspect(a.reference?.owner,a.original);
 if(canonical(a)!==canonical(expected))throw Error('Legacy archive digest or metadata changed.');
 return a;
}
/** Opt-in immutable archive. Original text is retained exactly; no approval or current evidence is inferred. */
export async function retainLegacyRecord(directory:string,owner:LegacyReference['owner'],original:string):Promise<string> {
 const archive=inspect(owner,original);
 await mkdir(directory,{recursive:true,mode:0o700});
 const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Legacy archive root must be a real directory.');
 const file=await safePath(directory,`${owner}-${archive.reference.digest}.json`);
 try {await atomicJson(file,archive,true);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 const existing=await readLegacyArchive(file);
 if(canonical(existing)!==canonical(archive))throw Error('Legacy archive changed.');
 return file;
}
