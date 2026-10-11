/** Project-owned route facts are checked without a model; semantic discovery stays bounded and resumable. */
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {readProfile} from '../project/profile.ts';
import {readProduct} from '../product/spec.ts';
import {readSafe} from '../workspace/safe-path.ts';
import {harnessDirectory} from '../record/record.ts';
import {atomicWrite,readArtifact} from '../planning/store.ts';
import type {Feature} from '../features.ts';
import type {Blueprint} from './preparation.ts';
import {caseKind,type EvidenceKind} from './evidence-kind.ts';
import {assertRoute,discoverEvidence,type EvidenceCheckpoint,type EvidenceGap,type RouteInput} from './feasibility.ts';
import {OperatorError} from '../verbs/io.ts';
export async function projectRoute(project:string,kinds:EvidenceKind[]=[]):Promise<RouteInput>{
 const profile=await readProfile(project,true),product=await readProduct(project);let dependencies=false;
 if(profile.adapter.id==='node-npm'){const bytes=await readSafe(project,'package.json');if(bytes){if(bytes.length>1024*1024)throw new OperatorError('Package input exceeds its planning limit.');const pkg=JSON.parse(bytes.toString());dependencies=Object.keys(pkg.dependencies??{}).length>0||Object.keys(pkg.optionalDependencies??{}).length>0;}}
 const input:RouteInput={profile,dependencies,kinds:[...new Set([...kinds,...(product?.kind==='web'?['browser' as const]:[])])],sensitive:product?.consequence==='sensitive'};
 assertRoute(input);return input;
}
export async function inspectEvidenceRuntime(project:string,input:RouteInput):Promise<EvidenceGap[]>{
 const gaps:EvidenceGap[]=[];
 const inspect=async(stage:string,probe:()=>Promise<unknown>)=>{try{await probe();}catch(error){const message=(error as Error).message;gaps.push({kind:(error as NodeJS.ErrnoException).code==='ENOENT'||/unavailable|missing/i.test(message)?'missing-installation':'unqualified-runtime',stage,detail:message});}};
 await inspect('build/test/apply',async()=>{const {loadConfig}=await import('../config.ts');const {inspectCapabilities}=await import('../project/execution.ts');return inspectCapabilities(input.profile,loadConfig({...process.env,HARNESS_PROJECT:project}));});
 if(input.kinds.includes('browser'))await inspect('ui/preview',async()=>(await import('../browser/runtime.ts')).inspectBrowser());
 return gaps;
}
export async function prepareEvidence(project:string,task:Feature,b:Blueprint,progress:(text:string)=>void,services?:{request:(n:number,prompt:string)=>Promise<unknown>;runtime:(input:RouteInput)=>Promise<EvidenceGap[]>}){
 const input=await projectRoute(project,b.cases.map(caseKind));
 const runtime=await (services?.runtime??(i=>inspectEvidenceRuntime(project,i)))(input);
 const root=path.join(harnessDirectory(project),'acceptance');await mkdir(root,{recursive:true,mode:0o700});
 if(runtime.length){await atomicWrite(root+'/evidence-runtime.json',JSON.stringify({version:1,at:new Date().toISOString(),issues:runtime},null,2)+'\n');throw new OperatorError('Evidence runtime is not ready; no semantic request was sent.',runtime.map(g=>`${g.kind} / ${g.stage}: ${g.detail}`).join('\n'));}
 const raw=await readArtifact(root,'evidence-planning.json',2*1024*1024),saved=raw?JSON.parse(raw) as EvidenceCheckpoint:undefined;
 let archived=false;
 const result=await discoverEvidence(task,b,input,{request:services?.request??(async(n,prompt)=>{progress(`Checking atomic evidence for criterion ${n}/${task.criteria.length}; completed discoveries are reused.`);const {requestCheckJson}=await import('./draft.ts');return requestCheckJson(project,prompt,{tools:'none',stage:'evidence-feasibility-'+n});}),save:async state=>{if(raw&&saved?.identity!==state.identity&&!archived){await mkdir(root+'/evidence-history',{recursive:true,mode:0o700});await atomicWrite(root+'/evidence-history/'+randomUUID()+'.json',raw);archived=true;}const bytes=JSON.stringify(state,null,2)+'\n';if(Buffer.byteLength(bytes)>2*1024*1024)throw new OperatorError('Evidence planning exceeds its retained size limit.');await atomicWrite(root+'/evidence-planning.json',bytes);}},saved);
 await atomicWrite(root+'/evidence-design.json',JSON.stringify(result,null,2)+'\n');
 progress(`Evidence feasibility: ${result.obligations.length} atomic observations; ${result.unresolved.length} require human evidence. This is a design, not application verification.`);
 return result;
}
