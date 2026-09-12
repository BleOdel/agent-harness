/** Each atomic revision carries a bounded event history; no state is stored in worker mounts. */
import { randomUUID } from 'node:crypto';
import { lstat, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { readJson, safeDirectory, saveJson, sha256, stateRoot } from '../artifacts/store.ts';
import { parseJobSpec, type JobSpec } from './schema.ts';
import type { Snapshot } from '../workspace/candidate.ts';
import type { ProjectProfile } from '../project/profile.ts';
import type { Capabilities } from '../runners/contract.ts';
import { syncDirectory } from '../workspace/atomic.ts';
import { OperatorError } from '../verbs/io.ts';
export type JobStatus='ready'|'preparing'|'running'|'interrupted'|'cancelled'|'timed-out'|'failed'|'succeeded'|'released';
export interface JobEvent {at:string;phase:string;message:string;}
export interface Job {version:1;id:string;spec:JobSpec;specDigest:string;status:JobStatus;attempts:number;reservedSeconds:number;elapsedSeconds:number;events:JobEvent[];
 profile?:ProjectProfile;capabilities?:Capabilities;image?:string;docker?:string;installPolicy?:unknown;environment?:string;source?:Snapshot;identity?:string;
 container?:string;token?:string;checkpoint?:string;completed?:number;artifacts:string[];cost:{reportedUsd:number|null;unknown:boolean};}
export async function jobsRoot(project:string):Promise<string>{const root=path.join(await stateRoot(project),'jobs');await safeDirectory(root);return root;}
export async function jobRoot(project:string,id:string,create=false):Promise<string>{if(!/^job-[a-f0-9-]{36}$/u.test(id))throw new OperatorError('Invalid job ID. Use harness job list.');const root=path.join(await jobsRoot(project),id);if(!create)await lstat(root).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')throw new OperatorError('Unknown job. Use harness job list.');throw e;});await safeDirectory(root);return root;}
export async function readJob(project:string,id:string):Promise<Job>{
 const j=await readJson(await jobRoot(project,id),'state.json') as Job;
 if(j.version!==1||j.id!==id||j.specDigest!==sha256(JSON.stringify(parseJobSpec(j.spec)))||!['ready','preparing','running','interrupted','cancelled','timed-out','failed','succeeded','released'].includes(j.status)||!Number.isSafeInteger(j.attempts)||j.attempts<0||j.attempts>8||!Number.isFinite(j.reservedSeconds)||!Number.isFinite(j.elapsedSeconds)||!Array.isArray(j.events)||j.events.length>512||!Array.isArray(j.artifacts))throw new OperatorError('Invalid saved job.');return j;
}
export async function saveJob(project:string,j:Job,phase:string,message:string):Promise<void>{
 j.events.push({at:new Date().toISOString(),phase,message});if(j.events.length>512)throw new OperatorError('Job event limit reached.');await saveJson(await jobRoot(project,j.id),'state.json',j);
}
export async function createJob(project:string,raw:unknown):Promise<Job>{const spec=parseJobSpec(raw),j:Job={version:1,id:`job-${randomUUID()}`,spec,specDigest:sha256(JSON.stringify(spec)),status:'ready',attempts:0,reservedSeconds:0,elapsedSeconds:0,events:[],artifacts:[],cost:{reportedUsd:null,unknown:true}};const root=await jobsRoot(project),pending=path.join(root,`.pending-${j.id}`);await safeDirectory(pending);try{j.events.push({at:new Date().toISOString(),phase:'ready',message:'Job settings saved. No commands have run.'});await saveJson(pending,'state.json',j);await rename(pending,path.join(root,j.id));await syncDirectory(root);}finally{await rm(pending,{recursive:true,force:true});}return j;}
export async function listJobs(project:string):Promise<Job[]>{
 const root=await jobsRoot(project),result:Job[]=[];for(const id of (await readdir(root)).sort())if(/^job-[a-f0-9-]{36}$/u.test(id))result.push(await readJob(project,id));return result.sort((a,b)=>a.events[0]!.at.localeCompare(b.events[0]!.at));
}
