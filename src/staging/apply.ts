/** Application intent is durable before writes; recovery accepts only before/after bytes. */
import {mkdir,readFile,rm,realpath,lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {atomicBytes} from '../workspace/atomic.ts';
import {assertStageCurrent,assertStageReview,readStage,writeStage,type Stage} from './store.ts';
import {sourceFiles,assertLiveBaseline} from '../workspace/candidate.ts';
import {safePath,readSafe} from '../workspace/safe-path.ts';
import {snapshotForRecovery} from '../workspace/sandbox-lifecycle.ts';
import {parseFeatures} from '../features.ts';
import {harnessDirectory,nextRunId,recoveryPath,appendRunOnce} from '../record/record.ts';
import {atomicWrite,readArtifact} from '../planning/store.ts';
import {assertExecutionCompatible} from '../project/execution.ts';
import {assertProductCurrent} from '../product/spec.ts';
import {loadConfig} from '../config.ts';
import {projectTestCommand} from '../project/profile.ts';
import {readContinuation,saveContinuation} from '../workflow/store.ts';
import {OperatorError} from '../verbs/io.ts';
const pending=(p:string)=>path.join(harnessDirectory(p),'staged-application.json');
async function completeContinuation(project:string,s:Stage):Promise<void>{
 const state=await readContinuation(project);if(!state||state.task!==s.task||state.status==='complete')return;
 state.status='complete';state.message=`Applied reviewed candidate ${s.id} as ${s.application!.record.id}. Nothing was published.`;state.updated=new Date().toISOString();state.events.push({at:state.updated,stage:'apply',message:state.message});state.events=state.events.slice(-30);await saveContinuation(project,state);
}
async function featuresAfter(p:string,s:Stage){
 const raw=await readFile(path.join(p,'features.json'),'utf8'),list=parseFeatures(raw);if(!list.ok)throw new OperatorError(list.reason);
 if(!list.features.some(f=>f.id===s.task))throw new OperatorError('The staged task is missing.');
 const affected=new Set([s.task]);if(s.candidate.changes.length)for(let more=true;more;){more=false;for(const f of list.features)if(!affected.has(f.id)&&f.dependsOn.some(d=>affected.has(d))){affected.add(f.id);more=true;}}
 return {featuresBefore:raw,featuresAfter:JSON.stringify(list.features.map(f=>f.id===s.task?{...f,status:'done'}:(s.candidate.sharedInputsChanged||affected.has(f.id))&&['done','doing'].includes(f.status)?{...f,status:'needs-revalidation'}:f),null,2)+'\n'};
}
export async function applyStage(project:string,id:string,checkpoint?:(point:string)=>Promise<void>):Promise<Stage>{
 project=await realpath(project);const s=await readStage(project,id);
 if(s.status==='applied'){const marker=await readArtifact(harnessDirectory(project),'staged-application.json');if(marker&&JSON.parse(marker).id===id)await rm(pending(project),{force:true});await completeContinuation(project,s);return s;}
 if(!['pending','applying'].includes(s.status))throw new OperatorError('Rejected candidate cannot be applied.');
 if(await readArtifact(harnessDirectory(project),'application.json'))throw new OperatorError('Recover the pending team application first.');
 const marker=await readArtifact(harnessDirectory(project),'staged-application.json');
 if(marker&&JSON.parse(marker).id!==id)throw new OperatorError('Another staged application requires recovery.');
 await assertStageCurrent(project,s,s.status==='applying');await assertStageReview(s);
 if(s.execution)await assertExecutionCompatible(s.execution,project,loadConfig(),await projectTestCommand(project,process.env.HARNESS_TEST_COMMAND));
 if((await assertProductCurrent(project))?.digest!==s.baseline.productDigest)throw new OperatorError('Product specification changed.');
 if(s.status==='pending'){
  const applicationId=await nextRunId(project),features=await featuresAfter(project,s);
  const recovery=await snapshotForRecovery(project,s.candidate.directory,s.candidate.changes,recoveryPath(project,applicationId));
  await checkpoint?.('prepared-recovery');
  for(const c of s.candidate.changes)for(const [side,expected] of [['before',s.baseline.files[c.file]],['after',s.candidate.files[c.file]]] as const){
   if(expected===undefined)continue;const bytes=await readFile(path.join(recovery.directory,side,c.file));if(createHash('sha256').update(bytes).digest('hex')!==expected)throw new OperatorError('Recovery bytes changed while preparing application.');
  }
  await assertLiveBaseline(project,s.baseline);
  s.application={...features,record:{id:applicationId,at:new Date().toISOString(),project,goal:s.task,attempts:0,outcome:'applied',gates:[...s.gates,...s.acceptance.summaries,'Final operator review passed (manual observations are operator-reported).'],review:s.review,changes:s.candidate.changes,baselineDigest:s.baseline.digest,candidateDigest:s.candidate.digest,acceptance:s.acceptance,...(s.execution?{execution:s.execution}:{}),reason:`Applied reviewed staged candidate ${s.id}. Manual review: staging/${s.id}/state.json`}};
  s.status='applying';await writeStage(s);
 }
 if(!s.application)throw new OperatorError('Staged application intent missing.');
 await atomicWrite(pending(project),JSON.stringify({id,version:1})+'\n');
 await checkpoint?.('intent');
 // Before any write, reject unrelated edits, including files not touched by the candidate.
 const live=await sourceFiles(project,'',s.baseline.exclusions);
 for(const file of new Set([...Object.keys(live),...Object.keys(s.baseline.files),...Object.keys(s.candidate.files)]))if(live[file]!==s.baseline.files[file]&&live[file]!==s.candidate.files[file])throw new OperatorError(`External change at ${file}; restore it before resuming this application.`);
 const featureFile=path.join(project,'features.json'),features=await readFile(featureFile,'utf8');
 if(![s.application.featuresBefore,s.application.featuresAfter].includes(features))throw new OperatorError('Requirements changed during staged application.');
 for(const c of s.candidate.changes){
  const target=await safePath(project,c.file);
  const unchanged=async()=>{await safePath(project,c.file);const bytes=await readSafe(project,c.file),hash=bytes?createHash('sha256').update(bytes).digest('hex'):undefined;if(hash!==s.baseline.files[c.file]&&hash!==s.candidate.files[c.file])throw new OperatorError(`External change at ${c.file}; refusing replacement.`);};
  if(c.kind==='deleted'){await checkpoint?.('prepared-file:'+c.file);await unchanged();await rm(target,{force:true});}
  else {const source=await safePath(s.candidate.directory,c.file),bytes=await readFile(source);if(createHash('sha256').update(bytes).digest('hex')!==s.candidate.files[c.file])throw new OperatorError('Candidate changed during application.');await mkdir(path.dirname(target),{recursive:true});await atomicBytes(target,bytes,(await lstat(target).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return lstat(source);throw e;})).mode&0o777,path.dirname(target),async()=>{await checkpoint?.('prepared-file:'+c.file);await unchanged();});}
  await checkpoint?.('file:'+c.file);
 }
 await atomicBytes(featureFile,Buffer.from(s.application.featuresAfter),(await lstat(await safePath(project,'features.json'))).mode&0o777,path.dirname(featureFile),async()=>{await checkpoint?.('prepared-features');await safePath(project,'features.json');const current=await readFile(featureFile,'utf8');if(![s.application!.featuresBefore,s.application!.featuresAfter].includes(current))throw new OperatorError('Requirements changed during replacement.');});await checkpoint?.('features');
 await appendRunOnce(project,s.application.record);await checkpoint?.('record');
 s.status='applied';await writeStage(s);await rm(pending(project),{force:true});await completeContinuation(project,s);return s;
}
