/** Host-owned delegation and retained proposals are outside worker source. */
import path from 'node:path';import {createHash} from 'node:crypto';import {mkdir} from 'node:fs/promises';
import {harnessDirectory} from '../record/record.ts';import {readArtifact,atomicWrite} from '../planning/store.ts';
import {readFeatures,type Feature} from '../features.ts';import {readApproval} from './checks.ts';
import {requestCheckJson,taskDigest} from './draft.ts';import {sourceFiles} from '../workspace/candidate.ts';
import {readProfile} from '../project/profile.ts';import {getAdapter} from '../adapters/registry.ts';
import {withWriter,canonicalProject} from '../workspace/writer-lock.ts';import {confirmed,type Dialogue} from '../guide/dialogue.ts';
import {OperatorError} from '../verbs/io.ts';import type {Blueprint} from './preparation.ts';
import {delegationFor,resolveAmendment,errorBlocker,type AmendmentCheckpoint} from './interface-amendments.ts';
const directory=(project:string)=>path.join(harnessDirectory(project),'acceptance','interface-choices');
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export async function configureInterfaceChoices(project:string,id:string,io:Dialogue,revoke=false):Promise<void>{
 project=await canonicalProject(project);
 const features=await readFeatures(project),task=features?.ok?features.features.find(t=>t.id===id):undefined;if(!task)throw new OperatorError('Select an existing task for routine interface choices.');
 const selected=taskDigest(task);
 io.write('This delegates accessible names/control types and splits of unapproved observations only. Scope, privacy, evidence sufficiency and final approval remain yours. At most two independently reviewed amendments per preparation. Model requests use the existing preparation allowance.');
 if(!await confirmed(io,revoke?'Revoke routine design delegation?':'Allow these routine choices for '+task.title+'?'))return;
 await withWriter(project,'interface choices',async()=>{
  const current=await readFeatures(project);if(!current?.ok||!current.features.some(t=>t.id===id&&taskDigest(t)===selected))throw new OperatorError('Task changed during delegation.');
  await mkdir(directory(project),{recursive:true,mode:0o700});await atomicWrite(path.join(directory(project),selected+'.json'),JSON.stringify(revoke?{version:1,revoked:true}:delegationFor(task),null,2)+'\n');
 });io.write(revoke?'Routine design delegation revoked.':'Routine choices delegated. Continue preparation; no checks or application changes were approved.');
}
export async function amendProjectOutline(project:string,task:Feature,b:Blueprint,error:unknown,progress:(s:string)=>void):Promise<Blueprint>{
 const blocker=errorBlocker(error),root=directory(project),raw=await readArtifact(root,taskDigest(task)+'.json',4096),delegation=raw?JSON.parse(raw):undefined;
 const approval=await readApproval(project),approved=!!approval?.manifest.cases.some(c=>c.tasks.includes('*')||c.tasks.includes(task.id));
 const profile=await readProfile(project,true),source=await sourceFiles(project,'',getAdapter(profile.adapter).source.generatedDirectories);
 const file='amendment-'+hash({task:taskDigest(task),source,b,blocker})+'.json',saved=await readArtifact(root,file,512*1024);
 return resolveAmendment(task,b,blocker,delegation,approved,{progress,request:prompt=>requestCheckJson(project,prompt,{tools:'none',stage:'interface-amendment'}),save:async state=>{const bytes=JSON.stringify(state,null,2)+'\n';if(Buffer.byteLength(bytes)>512*1024)throw new OperatorError('Interface amendment checkpoint exceeds its size limit.');await mkdir(root,{recursive:true,mode:0o700});await atomicWrite(path.join(root,file),bytes);}},saved?JSON.parse(saved) as AmendmentCheckpoint:undefined);
}
