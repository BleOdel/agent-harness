import {currentOperationId,withOperationPhase} from '../workflow/operations.ts';
/** Host-owned application journal. Atomic file replacements are recoverable, not a filesystem transaction. */
import {randomUUID} from 'node:crypto';
import {lstat,open,readFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {assertProductCurrent} from '../product/spec.ts';
import {appendRunOnce,harnessDirectory,readRecord,type RunRecord} from '../record/record.ts';
import {atomicBytes,durableDirectory,syncDirectory} from './atomic.ts';
import {assertLiveBaseline,assertSnapshot,captureBaseline,sourceFiles,type Snapshot} from './candidate.ts';
import {assertChangesAreApplicable,type Change} from './changes.ts';
import {identityAt,identityMode,fileIdentity} from './file-identity.ts';
import {safePath} from './safe-path.ts';
import {canonicalProject,withWriter} from './writer-lock.ts';
import {digest} from '../team/schema.ts';
export interface ApplicationIntent {
 version:2;id:string;project:string;direction:'apply'|'undo';before:Snapshot;after:Snapshot;
 featuresBefore:string|null;featuresAfter:string|null;featuresMode:number;changes:Change[];record:RunRecord;
 effect?:{kind:'team';directory:string;runId:string}|{kind:'stage';id:string};
}
export interface ApplicationOptions {rollback?:boolean;checkpoint?:(point:string)=>void|Promise<void>;}
export interface ApplicationInput {source:string;expected:Snapshot;featuresAfter:string|null;record:RunRecord;direction?:'apply'|'undo';effect?:ApplicationIntent['effect'];validate?:()=>Promise<void>;}
export const applicationPath=(p:string)=>path.join(harnessDirectory(p),'application.json');
export const transactionPath=(p:string,id:string)=>path.join(harnessDirectory(p),'applications',id);
const json=async(file:string,value:unknown)=>atomicBytes(file,Buffer.from(JSON.stringify(value)+'\n'),0o600);
async function optional(file:string):Promise<Buffer|undefined>{try{const s=await lstat(file);if(!s.isFile()||s.nlink!==1)throw Error('Unsafe application file: '+file);return await readFile(file);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}}
export async function pendingApplication(project:string):Promise<{version:number;id:string;intentDigest:string;teamRunId?:string}|undefined>{const raw=await optional(applicationPath(project));return raw?JSON.parse(raw.toString()):undefined;}
export async function loadApplication(project:string):Promise<ApplicationIntent|undefined>{
 const p=await pendingApplication(project);if(!p)return undefined;if(p.version!==2)throw Error('Legacy application: use harness team recover <run-id> before starting new work.');
 if(!/^application-[a-f0-9-]+$/.test(p.id))throw Error('Invalid application identity.');
 const root=transactionPath(project,p.id),i=JSON.parse((await optional(path.join(root,'intent.json')))!.toString()) as ApplicationIntent;
 if(i.version!==2||i.id!==p.id||i.project!==project||digest(i)!==p.intentDigest||i.record.transactionId!==i.id||i.record.project!==project||!/^r[1-9][0-9]*$/.test(i.record.id)||i.before.directory!==path.join(root,'before')||i.after.directory!==path.join(root,'after'))throw Error('Application intent changed; manual recovery required.');
 await Promise.all([assertSnapshot(i.before),assertSnapshot(i.after)]);return i;
}
export async function beginApplication(project:string,input:ApplicationInput):Promise<ApplicationIntent>{
 project=await canonicalProject(project);
 if(await pendingApplication(project)||await optional(path.join(harnessDirectory(project),'staged-application.json')))throw Error('An application already requires recovery.');
 const history=await readRecord(project);if(history.malformed.length||history.runs.some(r=>r.id===input.record.id))throw Error('Application record identity is unavailable.');
 await assertLiveBaseline(project,input.expected);
 const id='application-'+randomUUID(),root=transactionPath(project,id);await durableDirectory(root,0o700);
 const before=await captureBaseline(project,path.join(root,'before'),input.expected.exclusions);
 if(before.digest!==input.expected.digest||before.controls!==input.expected.controls)throw Error('Live source changed while preparing application.');
 const after=await captureBaseline(input.source,path.join(root,'after'),input.expected.exclusions,input.record.execution?.digest);
 const changes:Change[]=[...new Set([...Object.keys(before.files),...Object.keys(after.files)])].filter(f=>before.files[f]!==after.files[f]).sort().map(file=>({file,symlink:false,kind:after.files[file]===undefined?'deleted':before.files[file]===undefined?'added':'modified'}));
 assertChangesAreApplicable(changes,after.directory);
 for(const file of new Set([...Object.keys(before.files),...Object.keys(after.files)])){
  const parts=file.split('/');parts.pop();while(parts.length){if(before.files[parts.join('/')]||after.files[parts.join('/')])throw Error('File/directory replacement requires manual application.');parts.pop();}
 }
 const featurePath=await safePath(project,'features.json'),features=(await optional(featurePath))?.toString()??null;
 const featureStat=await lstat(featurePath).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return undefined;throw e;});
 for(const file of [...changes.map(c=>c.file),'features.json']){
  await safePath(project,file);let parent=path.dirname(path.join(project,file));while(!await lstat(parent).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return undefined;throw e;}))parent=path.dirname(parent);
  if((await lstat(parent)).dev!==(await lstat(root)).dev)throw Error('Application journal and destination must share a filesystem.');
 }
 const operationId=currentOperationId(project);
 const record={...input.record,...(operationId?{operationId}:{}),project,changes,transactionId:id,baselineDigest:before.digest,candidateDigest:after.digest};
 const i:ApplicationIntent={version:2,id,project,direction:input.direction??'apply',before,after,featuresBefore:features,featuresAfter:input.featuresAfter,featuresMode:featureStat?featureStat.mode&0o777:0o644,changes,record,...(input.effect?{effect:input.effect}:{})};
 for(const snapshot of [before,after]){
  const dirs=new Set([root,snapshot.directory]);for(const file of Object.keys(snapshot.files)){const h=await open(path.join(snapshot.directory,file),'r');try{await h.sync();}finally{await h.close();}let p=path.dirname(path.join(snapshot.directory,file));while(p.startsWith(snapshot.directory)){dirs.add(p);p=path.dirname(p);}}
  for(const d of [...dirs].sort((a,b)=>b.length-a.length))await syncDirectory(d);
 }
 await json(path.join(root,'CHANGES.json'),{identityVersion:2,project,changes,before:before.files,after:after.files});
 await json(path.join(root,'intent.json'),i);await assertLiveBaseline(project,input.expected);await input.validate?.();
 await json(applicationPath(project),{version:2,id,intentDigest:digest(i),...(i.effect?.kind==='team'?{teamRunId:i.effect.runId}:{})});return i;
}
async function assertRoot(i:ApplicationIntent){if(await canonicalProject(i.project)!==i.project||!(await lstat(i.project)).isDirectory())throw Error('Project root changed during application.');}
async function inspectLive(i:ApplicationIntent){
 await assertRoot(i);
 const live=await sourceFiles(i.project,'',i.before.exclusions);for(const file of new Set([...Object.keys(live),...Object.keys(i.before.files),...Object.keys(i.after.files)]))if(live[file]!==i.before.files[file]&&live[file]!==i.after.files[file])throw Error('External change at '+file+'; fingerprints disagree; recovery retained the originals.');
 const f=(await optional(await safePath(i.project,'features.json')))?.toString()??null;if(f!==i.featuresBefore&&f!==i.featuresAfter)throw Error('External change at features.json; recovery retained the originals.');
 if(f!==null&&(await lstat(path.join(i.project,'features.json'))).mode%0o1000!==i.featuresMode)throw Error('External change at features.json mode.');
}
async function writeSource(i:ApplicationIntent,file:string,rollback:boolean,checkpoint:NonNullable<ApplicationOptions['checkpoint']>){
 await assertRoot(i);
 const desired=rollback?i.before:i.after,live=await safePath(i.project,file),current=await identityAt(live);
 if(current!==i.before.files[file]&&current!==i.after.files[file])throw Error('External change at '+file+'; refusing overwrite.');
 if(current===desired.files[file])return;
 const unchanged=async()=>{await checkpoint('prepared:'+file);await assertRoot(i);await safePath(i.project,file);if(await identityAt(live)!==current)throw Error('External change at '+file+'; refusing replacement.');};
 if(desired.files[file]===undefined){await unchanged();await unlink(live);await syncDirectory(path.dirname(live));return;}
 const source=await safePath(desired.directory,file),bytes=await readFile(source),mode=identityMode(desired.files[file]!);
 if(fileIdentity(bytes,(await lstat(source)).mode)!==desired.files[file])throw Error('Application snapshot changed at '+file);
 await atomicBytes(live,bytes,mode,transactionPath(i.project,i.id),unchanged);
}
async function writeFeatures(i:ApplicationIntent,rollback:boolean,checkpoint:NonNullable<ApplicationOptions['checkpoint']>){
 const file=await safePath(i.project,'features.json'),current=(await optional(file))?.toString()??null,desired=rollback?i.featuresBefore:i.featuresAfter;
 if(current!==i.featuresBefore&&current!==i.featuresAfter)throw Error('External change at features.json; refusing overwrite.');if(current===desired)return;
 const unchanged=async()=>{await checkpoint('prepared:features.json');await assertRoot(i);await safePath(i.project,'features.json');if(((await optional(file))?.toString()??null)!==current)throw Error('External feature change at features.json; refusing replacement.');if(current!==null&&(await lstat(file)).mode%0o1000!==i.featuresMode)throw Error('External change at features.json mode.');};
 if(desired===null){await unchanged();await unlink(file);await syncDirectory(path.dirname(file));}else await atomicBytes(file,Buffer.from(desired),i.featuresMode,transactionPath(i.project,i.id),unchanged);
}
async function started(i:ApplicationIntent){
 if(i.effect?.kind==='team'){const {readState,appendEvent}=await import('../team/state.ts');const s=await readState(i.effect.directory);if(s.application?.transactionId!==i.id)await appendEvent(i.effect.directory,{type:'application-started',transactionId:i.id,intentDigest:digest(i),direction:i.direction});}
 if(i.effect?.kind==='stage'){const {readStage,writeStage}=await import('../staging/store.ts');const s=await readStage(i.project,i.effect.id);if(!['pending','applying','applied'].includes(s.status))throw Error('Stage changed during application.');s.application={record:i.record,featuresBefore:i.featuresBefore!,featuresAfter:i.featuresAfter!};if(s.status!=='applied')s.status='applying';await writeStage(s);}
}
async function completed(i:ApplicationIntent,rollback:boolean){
 if(i.effect?.kind==='team'){const {readState,appendEvent}=await import('../team/state.ts');const s=await readState(i.effect.directory);if(rollback){if(s.status==='applying')await appendEvent(i.effect.directory,{type:'application-rolled-back',transactionId:i.id,direction:i.direction});}else if(s.status==='applying')await appendEvent(i.effect.directory,{type:'application-completed',transactionId:i.id,direction:i.direction,recordId:i.record.id});}
 if(i.effect?.kind==='stage'){const {readStage,writeStage}=await import('../staging/store.ts');const s=await readStage(i.project,i.effect.id);s.status=rollback?'pending':'applied';if(rollback)delete s.application;await writeStage(s);if(!rollback){const {completeContinuation}=await import('../staging/apply.ts');await completeContinuation(i.project,s);}}
}
export async function finishApplication(i:ApplicationIntent,options:ApplicationOptions={}):Promise<RunRecord|undefined>{
 const checkpoint=options.checkpoint??(()=>{}),root=transactionPath(i.project,i.id);
 await checkpoint('intent');await assertSnapshot(i.before);await assertSnapshot(i.after);
 const continuingRollback=options.rollback||!!await optional(path.join(root,'rollback.json'));
 if(!continuingRollback&&(await assertProductCurrent(i.project))?.digest!==i.before.productDigest)throw Error('Product specification changed since application began; restore it or roll back.');
 await inspectLive(i);
 if(!continuingRollback){
  if(i.effect?.kind==='stage'){const {readStage,assertStageCurrent,assertStageReview}=await import('../staging/store.ts');const stage=await readStage(i.project,i.effect.id);await assertStageCurrent(i.project,stage,true);await assertStageReview(stage,true);if(stage.execution){const {assertExecutionCompatible}=await import('../project/execution.ts'),{loadConfig}=await import('../config.ts'),{projectTestCommand}=await import('../project/profile.ts');await assertExecutionCompatible(stage.execution,i.project,loadConfig(),await projectTestCommand(i.project,process.env.HARNESS_TEST_COMMAND));}}
  else if(i.direction==='apply'&&i.record.acceptance){
   if(!i.effect){const {assertDeliveryAdmission}=await import('../evidence/delivery.ts');await assertDeliveryAdmission(i.project,i.after,i.record.taskIds??[i.record.goal],i.record.acceptance,{route:'ordinary',review:i.record.review});}
   else {const {assertAcceptanceProof}=await import('../acceptance/checks.ts');await assertAcceptanceProof(i.project,i.after,i.record.taskIds??[i.record.goal],i.record.acceptance);}
  }
 }
 const history=await readRecord(i.project);if(history.malformed.length)throw Error('Malformed history requires repair before recovery.');
 const committed=history.runs.find(r=>r.id===i.record.id);if(committed&&digest(committed)!==digest(i.record))throw Error('Application record identity conflicts with history.');
 if(options.rollback&&committed)throw Error('Application record is committed; finish recovery, then undo.');
 const decision=path.join(root,'rollback.json');if(options.rollback&&!await optional(decision))await json(decision,{rollback:true});const rollback=!!await optional(decision);
 if(rollback&&committed)throw Error('Committed application cannot roll back.');await started(i);
 // Invalidating task status first on undo is conservative during interruption.
 const featuresFirst=i.direction==='undo'?!rollback:rollback;if(featuresFirst)await writeFeatures(i,rollback,checkpoint);
 const completedFiles:string[]=[];for(const c of i.changes){await writeSource(i,c.file,rollback,checkpoint);await checkpoint('replaced:'+c.file);completedFiles.push(c.file);await json(path.join(root,'progress.json'),{version:2,files:completedFiles,rollback});await checkpoint('write:'+c.file);}
 await checkpoint('sources');await assertSnapshot({...(rollback?i.before:i.after),directory:i.project});
 if(!featuresFirst)await writeFeatures(i,rollback,checkpoint);await checkpoint('features');
 if(!rollback){await appendRunOnce(i.project,i.record);await checkpoint('record');}await completed(i,rollback);await checkpoint('event');
 await json(path.join(root,'complete.json'),{rollback});await checkpoint('complete');await unlink(applicationPath(i.project));await syncDirectory(harnessDirectory(i.project));return rollback?undefined:i.record;
}
export async function recoverPendingApplication(project:string,options:ApplicationOptions={}):Promise<RunRecord|undefined>{
 project=await canonicalProject(project);return withWriter(project,'application recovery',async()=>{const i=await loadApplication(project);if(i)return withOperationPhase(project,'recovering',i.id,()=>finishApplication(i,options));return undefined;},true);
}
