import {randomUUID} from 'node:crypto';
import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {readJson,saveJson,safeDirectory,stateRoot,sha256} from '../artifacts/store.ts';
import {parseJourney,type Journey,type Assessment} from './schema.ts';
import type {Runtime} from './runtime.ts';
import {OperatorError} from '../verbs/io.ts';
export interface Approval {version:1;id:string;at:string;journey:Journey;runtime:Runtime;digest:string;}
export interface DesktopRun {version:1;id:string;approval:string;approvalDigest:string;runtime:Runtime;docker:string;token:string;status:'preparing'|'running'|'passed'|'failed'|'interrupted'|'released';at:string;message:string;artifacts:string[];container?:string;source?:string;identity?:string;package?:string;report?:string;assessment?:Assessment;}
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
function idCheck(id:string,prefix:string){if(!new RegExp(`^${prefix}-[a-f0-9-]{36}$`,'u').test(id))throw new OperatorError('Invalid desktop ID. Use harness desktop list.');}
export async function desktopRoot(project:string):Promise<string>{const root=path.join(await stateRoot(project),'desktop');await safeDirectory(root);for(const part of ['approvals','runs'])await safeDirectory(path.join(root,part));return root;}
export async function runRoot(project:string,id:string):Promise<string>{idCheck(id,'desktop');const root=path.join(await desktopRoot(project),'runs',id);await safeDirectory(root);return root;}
export async function saveApproval(project:string,raw:unknown,runtime:Runtime):Promise<Approval>{
 const content={version:1 as const,id:`journey-${randomUUID()}`,at:new Date().toISOString(),journey:parseJourney(raw),runtime};const a={...content,digest:sha256(JSON.stringify(content))};await saveJson(await desktopRoot(project),`approvals/${a.id}.json`,a);return a;
}
export async function readApproval(project:string,id:string):Promise<Approval>{
 idCheck(id,'journey');const a=await readJson(await desktopRoot(project),`approvals/${id}.json`) as Approval;const {digest,...content}=a;
 if(a.version!==1||a.id!==id||sha256(JSON.stringify(content))!==digest)throw new OperatorError('Desktop approval identity changed.');parseJourney(a.journey);return a;
}
export async function listApprovals(project:string):Promise<Approval[]>{const root=await desktopRoot(project),all=[];for(const file of (await readdir(path.join(root,'approvals'))).sort())if(/^journey-[a-f0-9-]{36}\.json$/u.test(file))all.push(await readApproval(project,file.slice(0,-5)));return all.sort((a,b)=>a.at.localeCompare(b.at));}
export async function saveDesktopRun(project:string,j:DesktopRun):Promise<void>{await saveJson(await runRoot(project,j.id),'state.json',j);}
export async function newRun(project:string,a:Approval,docker:string):Promise<DesktopRun>{const j:DesktopRun={version:1,id:`desktop-${randomUUID()}`,approval:a.id,approvalDigest:a.digest,runtime:a.runtime,docker,token:randomUUID(),status:'preparing',at:new Date().toISOString(),message:'Preparing a fresh packaged journey.',artifacts:[]};await saveDesktopRun(project,j);return j;}
export async function readDesktopRun(project:string,id:string):Promise<DesktopRun>{
 const j=await readJson(await runRoot(project,id),'state.json') as DesktopRun;
 if(j.version!==1||j.id!==id||!['preparing','running','passed','failed','interrupted','released'].includes(j.status)||!hash(j.approvalDigest)||!Array.isArray(j.artifacts)||j.artifacts.length>40||j.artifacts.some(a=>!/^artifact-[a-f0-9-]{36}$/u.test(a))||!/^sha256:[a-f0-9]{64}$/u.test(j.runtime?.image)||!path.isAbsolute(j.docker)||!/^[-a-f0-9]{36}$/u.test(j.token)||(j.source!==undefined&&!hash(j.source))||(j.container!==undefined&&!/^harness-desktop-[a-f0-9-]{36}$/u.test(j.container)))throw new OperatorError('Invalid saved desktop run.');
 return j;
}
export async function listDesktopRuns(project:string):Promise<DesktopRun[]>{const root=await desktopRoot(project),all=[];for(const id of (await readdir(path.join(root,'runs'))).sort())if(/^desktop-[a-f0-9-]{36}$/u.test(id))all.push(await readDesktopRun(project,id));return all.sort((a,b)=>a.at.localeCompare(b.at));}
