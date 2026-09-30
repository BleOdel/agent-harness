import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {saveJson,safeDirectory,stateRoot,sha256} from '../artifacts/store.ts';
import {assertProductCurrent} from '../product/spec.ts';
import {EvidenceReader} from '../product/evidence/reader.ts';
import {object,hash,uuidId,timestamp} from '../product/evidence/schema.ts';
import {run} from '../run.ts';
import {parseProfile,canonicalHash,type Profile} from './schema.ts';
export const resources=import.meta.dirname;
export async function performanceProtocol(){return sha256(Buffer.concat(await Promise.all(['schema.ts','store.ts','controller.ts','report.ts','evidence.ts','instrumentation/probe.mjs','instrumentation/json.mjs','../run.ts','../workspace/candidate.ts','../workspace/safe-path.ts','../desktop/output.ts','../artifacts/store.ts','../product/evidence/reader.ts'].map(f=>readFile(path.join(resources,f))))));}
export interface Environment {image:string;dockerVersion:string;kernel:string;os:string;arch:string;cpus:number;memoryBytes:number;}
export function parseEnvironment(raw:unknown):Environment{
 const e=object(raw,['image','dockerVersion','kernel','os','arch','cpus','memoryBytes']);
 if(typeof e.image!=='string'||!/^sha256:[a-f0-9]{64}$/u.test(e.image)||['dockerVersion','kernel','os','arch'].some(k=>typeof e[k]!=='string'||!(e[k] as string).length||(e[k] as string).length>200||/[\x00-\x1f]/u.test(e[k] as string))||e.os!=='linux'||!Number.isSafeInteger(e.cpus)||Number(e.cpus)<1||!Number.isSafeInteger(e.memoryBytes)||Number(e.memoryBytes)<512*1024**2)throw Error('Invalid benchmark runtime identity.');return e as unknown as Environment;
}
export async function inspectEnvironment(docker:string,image:string){
 const result=await run(docker,['info','--format','{{json .}}'],{timeoutMs:10000,maxOutputBytes:128*1024});if(result.code!==0||result.timedOut||result.outputLimited)throw Error('Cannot inspect the benchmark Docker runtime.');
 const e=JSON.parse(result.stdout);return parseEnvironment({image,dockerVersion:e.ServerVersion,kernel:e.KernelVersion,os:e.OSType,arch:e.Architecture,cpus:e.NCPU,memoryBytes:e.MemTotal});
}
export interface Baseline {run:string;artifact:string;record:string;source:string;meanMs:number;throughputRps:number;}
export function parseBaseline(raw:unknown):Baseline{
 const b=object(raw,['run','artifact','record','source','meanMs','throughputRps']);if(!uuidId(b.run,'performance-run')||!uuidId(b.artifact,'artifact')||!hash(b.record)||!hash(b.source)||typeof b.meanMs!=='number'||!Number.isFinite(b.meanMs)||b.meanMs<0||typeof b.throughputRps!=='number'||!Number.isFinite(b.throughputRps)||b.throughputRps<=0)throw Error('Invalid benchmark baseline.');return b as unknown as Baseline;
}
export interface Approval {version:1;id:string;at:string;product:string;profile:Profile;environment:Environment;protocol:string;baseline?:Baseline;digest:string;}
export interface PerformanceRun {version:1;id:string;at:string;approval:string;approvalId:string;product:string;protocol:string;image:string;docker:string;token:string;status:'preparing'|'running'|'passed'|'failed'|'interrupted';containers:string[];source?:string;identity?:string;report?:string;verified?:true;message:string;}
export async function performanceRoot(project:string){const root=path.join(await stateRoot(project),'performance');await safeDirectory(root);await safeDirectory(root+'/runs');await safeDirectory(root+'/approvals');return root;}
export function parseApproval(raw:unknown):Approval{
 const a=object(raw,['version','id','at','product','profile','environment','protocol','baseline','digest']),{digest,...body}=a;
 if(a.version!==1||!uuidId(a.id,'performance-scope')||!timestamp(a.at)||!hash(a.product)||!hash(a.protocol)||digest!==canonicalHash(body))throw Error('Invalid performance approval.');parseProfile(a.profile);parseEnvironment(a.environment);if(a.baseline!==undefined)parseBaseline(a.baseline);return a as unknown as Approval;
}
export async function approvePerformance(project:string,profile:unknown,environment:Environment,baselineId?:string,expectedProduct?:string){
 const product=await assertProductCurrent(project);if(!product)throw Error('Approve product requirements first.');if(expectedProduct&&product.digest!==expectedProduct)throw Error('Product requirements changed.');
 const parsed=parseProfile(profile),runtime=parseEnvironment(environment),protocol=await performanceProtocol();
 const baseline=baselineId?await (await import('./evidence.ts')).selectBaseline(project,baselineId,parsed,runtime,protocol):undefined;
 const body={version:1 as const,id:'performance-scope-'+randomUUID(),at:new Date().toISOString(),product:product.digest,profile:parsed,environment:runtime,protocol,...(baseline?{baseline}:{})},a=parseApproval({...body,digest:canonicalHash(body)}),root=await performanceRoot(project);
 await saveJson(root+'/approvals',a.id+'.json',a);await saveJson(root,'approved.json',a);return a;
}
export async function readPerformance(project:string){const reader=new EvidenceReader(project+'-harness'),raw=await reader.json('performance/approved.json');if(!raw)return undefined;const a=parseApproval(raw);await reader.assertUnchanged();return a;}
export function parseRun(raw:unknown):PerformanceRun{
 const r=object(raw,['version','id','at','approval','approvalId','product','protocol','image','docker','token','status','containers','source','identity','report','verified','message']);
 if((r.verified!==undefined&&r.verified!==true)||r.version!==1||!uuidId(r.id,'performance-run')||!uuidId(r.approvalId,'performance-scope')||!timestamp(r.at)||!hash(r.approval)||!hash(r.product)||!hash(r.protocol)||typeof r.image!=='string'||!/^sha256:[a-f0-9]{64}$/u.test(r.image)||typeof r.docker!=='string'||!path.isAbsolute(r.docker)||typeof r.token!=='string'||!/^[a-f0-9-]{36}$/u.test(r.token)||!['preparing','running','passed','failed','interrupted'].includes(String(r.status))||typeof r.message!=='string'||r.message.length>500||!Array.isArray(r.containers)||r.containers.length>2||r.containers.some(n=>typeof n!=='string'||!/^harness-performance-[a-f0-9-]{36}$/u.test(n))||(r.source!==undefined&&!hash(r.source))||(r.identity!==undefined&&!hash(r.identity))||(r.report!==undefined&&!uuidId(r.report,'artifact')))throw Error('Invalid performance run.');return r as unknown as PerformanceRun;
}
export async function saveRun(project:string,r:PerformanceRun){parseRun(r);const root=(await performanceRoot(project))+'/runs/'+r.id;await safeDirectory(root);await saveJson(root,'state.json',r);}
export const runIdentity=(source:string,a:Approval)=>canonicalHash({source,approval:a.digest,environment:a.environment,protocol:a.protocol,resources:{appCPUs:2,observerCPUs:1,memoryMiB:512},method:'sequential-json-get-v1'});
