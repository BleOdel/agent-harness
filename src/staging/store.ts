import {currentOperationId, checkpointSavedFile} from '../workflow/operations.ts';
import {evidenceHash} from '../evidence/admission.ts';
import {assertDeliveryAdmission} from '../evidence/delivery.ts';
/** Retained, verified candidates. Metadata lives outside every candidate mount. */
import {mkdir,mkdtemp,readdir,rename,rm,realpath,lstat,open} from 'node:fs/promises';
import path from 'node:path';
import {harnessDirectory,type RunRecord} from '../record/record.ts';
import {atomicWrite,readArtifact,digest} from '../planning/store.ts';
import {assertLiveBaseline,assertSnapshot,copySource,sourceFiles,type Snapshot,type Candidate} from '../workspace/candidate.ts';
import {assertAutomatedAcceptanceProof,requireStagingChecks,type AcceptanceResult} from '../acceptance/checks.ts';
import {caseKind} from '../acceptance/evidence-kind.ts';
import {assertExecutionPin,type ExecutionPin} from '../project/execution.ts';
import {syncDirectory} from '../workspace/atomic.ts';
import {OperatorError} from '../verbs/io.ts';
export interface Observation {id:string;passed:boolean;notes:string;}
export interface StageReview {environment:string;observations:Observation[];approved:boolean;}
export interface Stage {
 operationId?:string;
 version:1;id:string;project:string;task:string;workDigest:string;tasks:string[];created:string;
 baseline:Snapshot;candidate:Candidate;acceptance:AcceptanceResult;execution?:ExecutionPin;
 gates:readonly string[];review:NonNullable<RunRecord['review']>;usage?:RunRecord['usage'];
 status:'pending'|'applying'|'applied'|'rejected'|'discarded';
 manual:{id:string;instructions:string}[];
 operator?:StageReview&{at:string;binding:string};
 application?:{record:RunRecord;featuresBefore:string;featuresAfter:string};
}
export type StageInput=Pick<Stage,'id'|'task'|'workDigest'|'tasks'|'baseline'|'candidate'|'gates'|'review'|'execution'|'usage'>&{acceptance:Omit<AcceptanceResult,'summaries'>&{summaries?:string[]}};
const root=(p:string)=>path.join(harnessDirectory(p),'staging');
export function stageDirectory(project:string,id:string):string{if(!/^r[1-9][0-9]*$/.test(id))throw new OperatorError('Invalid staged run ID.');return path.join(root(project),id);}
export const stageBinding=(s:Stage)=>digest(JSON.stringify({task:s.task,work:s.workDigest,baseline:s.baseline.digest,controls:s.baseline.controls,product:s.baseline.productDigest,candidate:s.candidate.digest,approval:s.acceptance.approvalDigest,execution:s.execution?.digest,manual:s.manual}));
export async function writeStage(s: Stage): Promise<void> {
  const operationId = currentOperationId(s.project);
  if (operationId) s.operationId = operationId;
  const file = path.join(stageDirectory(s.project, s.id), 'state.json');
  await atomicWrite(file, JSON.stringify(s, null, 2) + '\n');
  await checkpointSavedFile(file, 'stage', s.status === 'applied' ? 'complete' : s.status === 'pending' ? 'approval' : 'attention');
}
export async function saveStage(project:string,input:StageInput):Promise<Stage>{
 project=await realpath(project);const dest=stageDirectory(project,input.id);
 await assertSnapshot(input.candidate);await assertLiveBaseline(project,input.baseline);
 await assertAutomatedAcceptanceProof(project,input.candidate,input.tasks,input.acceptance);
 await assertDeliveryAdmission(project,input.candidate,input.tasks,input.acceptance,{route:'staged',review:input.review});
 const approval=await requireStagingChecks(project,input.tasks);
 await mkdir(root(project),{recursive:true,mode:0o700});const pending=await mkdtemp(path.join(root(project),'.pending-'));
 try{
  await copySource(input.candidate.directory,path.join(pending,'source'),input.candidate.exclusions);
  await copySource(input.baseline.directory,path.join(pending,'baseline'),input.baseline.exclusions);
  await assertSnapshot({...input.candidate,directory:path.join(pending,'source')});
  await assertSnapshot({...input.baseline,directory:path.join(pending,'baseline')});
  const s:Stage={...input,acceptance:{...input.acceptance,summaries:input.acceptance.summaries??[]},version:1,project,created:new Date().toISOString(),status:'pending',
   candidate:{...input.candidate,directory:path.join(dest,'source')},baseline:{...input.baseline,directory:path.join(dest,'baseline')},
   manual:approval.manifest.cases.filter(c=>caseKind(c)==='manual'&&(c.tasks.includes('*')||c.tasks.some(t=>input.tasks.includes(t)))).map(c=>({id:c.id,instructions:c.manual!.instructions}))};
  const acceptanceBytes=await readArtifact(path.dirname(input.acceptance.evidencePath),path.basename(input.acceptance.evidencePath),16*1024*1024);
  const reviewBytes=await readArtifact(path.dirname(input.review.evidencePath!),path.basename(input.review.evidencePath!));
  if(acceptanceBytes===undefined||reviewBytes===undefined)throw new OperatorError('Evidence disappeared while staging.');
  s.acceptance.evidenceDigest=evidenceHash(acceptanceBytes);
  s.review={...s.review,evidenceDigest:evidenceHash(reviewBytes)};
  await assertDeliveryAdmission(project,input.candidate,input.tasks,s.acceptance,{route:'staged',review:s.review});
  for(const name of ['source','baseline']){const directories=new Set([path.join(pending,name)]);for(const file of Object.keys(await sourceFiles(path.join(pending,name),'',input.baseline.exclusions))){const target=path.join(pending,name,file),handle=await open(target,'r');try{await handle.sync();}finally{await handle.close();}let dir=path.dirname(target);while(dir.startsWith(path.join(pending,name))){directories.add(dir);dir=path.dirname(dir);}}for(const dir of [...directories].sort((a,b)=>b.length-a.length))await syncDirectory(dir);}
  const operationId = currentOperationId(project);
  if (operationId) s.operationId = operationId;
  await atomicWrite(path.join(pending,'state.json'),JSON.stringify(s,null,2)+'\n');
  await syncDirectory(pending);await rename(pending,dest);await syncDirectory(root(project));
  await checkpointSavedFile(path.join(dest,'state.json'), 'stage', 'approval');
  return s;
 }finally{await rm(pending,{recursive:true,force:true});}
}
export async function readStage(project:string,id:string):Promise<Stage>{
 project=await realpath(project);const dir=stageDirectory(project,id),stat=await lstat(dir);
 if(!stat.isDirectory()||stat.isSymbolicLink())throw new OperatorError('Invalid staging directory.');
 const raw=await readArtifact(dir,'state.json',8*1024*1024),s=JSON.parse(raw??'null') as Stage;
 if(!s||s.version!==1||s.id!==id||s.project!==project||typeof s.task!=='string'||!s.task||!Array.isArray(s.tasks)||!s.tasks.includes(s.task)||!s.baseline||!s.candidate||!s.acceptance||!['pending','applying','applied','rejected','discarded'].includes(s.status)||!Array.isArray(s.manual)||s.candidate.directory!==path.join(dir,'source')||s.baseline.directory!==path.join(dir,'baseline')||!Array.isArray(s.candidate.changes)||s.review?.verdict!=='pass')throw new OperatorError('Invalid staged candidate metadata.');
 for(const name of ['source','baseline'])if((await lstat(path.join(dir,name))).isSymbolicLink())throw new OperatorError('Staged source cannot be a symlink.');
 return s;
}
export async function listStages(p:string):Promise<Stage[]>{const ids=await readdir(root(p)).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return [];throw e;});return Promise.all(ids.filter(id=>/^r[1-9][0-9]*$/.test(id)).sort((a,b)=>Number(b.slice(1))-Number(a.slice(1))).map(id=>readStage(p,id)));}
export async function pendingStage(p:string,task?:string):Promise<Stage|undefined>{return (await listStages(p)).find(s=>['pending','applying'].includes(s.status)&&(!task||s.task===task));}
export async function assertStageCurrent(project:string,s:Stage,partialApplication=false):Promise<void>{
 await assertSnapshot(s.candidate,partialApplication);await assertSnapshot(s.baseline,partialApplication);
 for(const snapshot of [s.baseline,s.candidate]){
  const files=await sourceFiles(snapshot.directory,'',snapshot.exclusions,snapshot.identityVersion??1);
  if(JSON.stringify(Object.entries(files).sort())!==JSON.stringify(Object.entries(snapshot.files).sort()))throw new OperatorError('Staged file manifest changed.');
 }
 const changes=[...new Set([...Object.keys(s.baseline.files),...Object.keys(s.candidate.files)])].filter(f=>s.baseline.files[f]!==s.candidate.files[f]).sort().map(file=>({file,kind:s.candidate.files[file]===undefined?'deleted':s.baseline.files[file]===undefined?'added':'modified',symlink:false}));
 if(JSON.stringify(changes)!==JSON.stringify(s.candidate.changes))throw new OperatorError('Staged change set does not match frozen source.');
 if(s.candidate.executionDigest){if(!s.execution)throw new OperatorError('Missing staged execution identity.');assertExecutionPin(s.execution);if(s.execution.digest!==s.candidate.executionDigest)throw new OperatorError('Staged execution identity changed.');}
 if(!partialApplication)await assertLiveBaseline(project,s.baseline);
 await assertAutomatedAcceptanceProof(project,s.candidate,s.tasks,s.acceptance,partialApplication);
 const a=await requireStagingChecks(project,s.tasks),manual=a.manifest.cases.filter(c=>caseKind(c)==='manual'&&(c.tasks.includes('*')||c.tasks.some(t=>s.tasks.includes(t)))).map(c=>({id:c.id,instructions:c.manual!.instructions}));
 if(JSON.stringify(manual)!==JSON.stringify(s.manual))throw new OperatorError('Staged manual requirements changed.');
 await assertDeliveryAdmission(project,s.candidate,s.tasks,s.acceptance,{route:'staged',review:s.review,legacyRecovery:partialApplication});
}
export async function recordStageReview(project:string,s:Stage,result:StageReview):Promise<void>{
 await assertStageCurrent(project,s);
 if(s.status!=='pending')throw new OperatorError('Only a pending candidate can be reviewed.');
 if(typeof result.environment!=='string'||!result.environment.trim()||result.environment.length>4000)throw new OperatorError('Describe the review environment.');
 if(typeof result.approved!=='boolean'||!Array.isArray(result.observations)||result.observations.length!==s.manual.length||s.manual.some(c=>result.observations.filter(o=>o.id===c.id).length!==1)||result.observations.some(o=>typeof o.passed!=='boolean'||typeof o.notes!=='string'||!o.notes.trim()||o.notes.length>8000))throw new OperatorError('Record each manual observation and its result.');
 const approval=await requireStagingChecks(project,s.tasks);
 if(s.manual.length&&approval.manifest.cases.some(c=>c.browser&&(c.tasks.includes('*')||c.tasks.some(t=>s.tasks.includes(t))))){
  const receipt=await readArtifact(stageDirectory(project,s.id),'preview-observed.json');
  if(!receipt||JSON.parse(receipt).binding!==stageBinding(s))throw new OperatorError('Preview this exact candidate before recording browser observations.');
 }
 s.operator={...result,at:new Date().toISOString(),binding:stageBinding(s)};await writeStage(s);
}
export async function assertStageReview(s:Stage,legacyRecovery=false):Promise<void>{
 await assertDeliveryAdmission(s.project,s.candidate,s.tasks,s.acceptance,{
  route:'staged',review:s.review,legacyRecovery:legacyRecovery||['applying','applied'].includes(s.status),
  human:{expectedBinding:stageBinding(s),...(s.operator?{recorded:s.operator}:{})},
 });
}
