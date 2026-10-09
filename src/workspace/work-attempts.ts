/** A durable pointer is not a checkpoint: it can survive a host death without inventing a snapshot. */
import {hostname} from 'node:os';
import {readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {atomicBytes,durableDirectory} from './atomic.ts';
import {harnessDirectory} from '../record/record.ts';
import {readArtifact} from '../planning/store.ts';
import {OperatorError} from '../verbs/io.ts';
export interface WorkAttempt {version:1;runId:string;project:string;task:string;attempt:number;pid:number;host:string;source:string;controller:string;container:string;previousCheckpoint?:string;status:'running'|'finished'|'quarantined';at:string;}
const directory=(project:string)=>path.join(harnessDirectory(project),'implementation','attempts');
export async function saveWorkAttempt(project:string,input:Omit<WorkAttempt,'version'|'project'|'pid'|'host'|'at'>):Promise<void>{
 const record:WorkAttempt={...input,version:1,project:await realpath(project),pid:process.pid,host:hostname(),at:new Date().toISOString()};
 if(!/^r[1-9][0-9]*$/.test(record.runId))throw new OperatorError('Invalid work attempt identity.');
 await durableDirectory(directory(record.project),0o700);await atomicBytes(path.join(directory(record.project),record.runId+'.json'),Buffer.from(JSON.stringify(record)+'\n'),0o600);
}
export async function unfinishedWorkAttempts(project:string):Promise<WorkAttempt[]>{
 project=await realpath(project);const entries=await readdir(directory(project)).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return [];throw e;});const result:WorkAttempt[]=[];
 for(const name of entries.filter(n=>/^r[1-9][0-9]*\.json$/.test(n))){const raw=await readArtifact(directory(project),name);if(!raw)continue;const s=JSON.parse(raw) as WorkAttempt;
  if(s.version!==1||s.project!==project||name!==s.runId+'.json'||!['running','finished','quarantined'].includes(s.status)||!Number.isSafeInteger(s.pid)||s.pid<1||typeof s.host!=='string'||![s.source,s.controller].every(p=>typeof p==='string'&&path.isAbsolute(p))||typeof s.task!=='string')throw new OperatorError('Invalid retained work-attempt reference.');
  if(s.status!=='finished')result.push(s);
 }return result;
}
export function attemptNotice(s:WorkAttempt):string{return `Unfinished ${s.runId} (${s.status}): unverified workspace ${s.source}; container ${s.container}. Last completed checkpoint: ${s.previousCheckpoint??'none recorded'}. A host death may have lost unsaved work; this reference is not a completed checkpoint. Confirm worker termination before inspecting source. Recover a dead writer with harness recover-lock; resume only an available checkpoint.`;}
