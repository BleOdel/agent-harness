/** One resumable controller; checkpoints and writer locks remain owned by existing check operations. */
import path from 'node:path';import {mkdir} from 'node:fs/promises';
import {CheckBudgetExceeded,withCheckBudget,ensureCheckBudget,defaultCheckLimits,validateCheckLimits,describeCheckSpend,type CheckLimits,type CheckSpend} from './budget.ts';
import {parseProposal} from './draft.ts';
import {assertServerRuntimes} from './server-runtime.ts';
import {assertRecipeStep} from './recipes/catalog.ts';
import {ScopeRepairBlocked,scopeDigest} from './scoped-review.ts';
import {readyCheckDraft,resumePreparation,repairSavedCheck,guidedSetup} from './guided.ts';
import {readArtifact,atomicWrite} from '../planning/store.ts';
import {canonicalProject,withWriter} from '../workspace/writer-lock.ts';
import {choose,type Dialogue} from '../guide/dialogue.ts';
import {readFeatures} from '../features.ts';
import {OperatorError} from '../verbs/io.ts';
export type WorkflowOutcome='ready'|'paused'|'blocked';
interface WorkflowRun {started:string;limits:CheckLimits;spend:CheckSpend;status:'running'|WorkflowOutcome;}
export interface WorkflowState {version:1;retried:string[];runs:WorkflowRun[];pendingRetry?:{key:string;scope:string;epoch:number};problem?:string;}
interface Services {snapshot:()=>Promise<{key:string;ready:boolean;retryCounts?:Record<string,number>}>;resume:()=>Promise<void>;repair:(scope:string)=>Promise<void>;save:()=>Promise<void>;write:(s:string)=>void;}
export async function driveCheckWorkflow(state:WorkflowState,services:Services):Promise<WorkflowOutcome>{
 for(let step=0;step<100;step++){
  const snapshot=await services.snapshot();
  if(snapshot.ready){delete state.problem;delete state.pendingRetry;return 'ready';}
  if(state.pendingRetry){
   const pending=state.pendingRetry;
   if(pending.key!==snapshot.key+':'+pending.scope){state.problem='Saved retry describes older preparation inputs.';await services.save();return 'blocked';}
   if((snapshot.retryCounts?.[pending.scope]??0)>=pending.epoch){if(!state.retried.includes(pending.key))state.retried.push(pending.key);delete state.pendingRetry;await services.save();}
  }
  try{
   ensureCheckBudget();
   if(state.pendingRetry){const pending=state.pendingRetry;await services.repair(pending.scope);if(!state.retried.includes(pending.key))state.retried.push(pending.key);delete state.pendingRetry;await services.save();}
   else await services.resume();
  }
  catch(error){
   state.problem=(error as Error).message;
   if(error instanceof CheckBudgetExceeded){await services.save();services.write(error.message);return 'paused';}
   if(error instanceof ScopeRepairBlocked){
    const current=await services.snapshot(),key=current.key+':'+error.scope;
    if(state.pendingRetry){if(!state.retried.includes(state.pendingRetry.key))state.retried.push(state.pendingRetry.key);delete state.pendingRetry;}
    if(!state.retried.includes(key)){
     try{ensureCheckBudget();}catch(budget){if(budget instanceof CheckBudgetExceeded){await services.save();services.write(budget.message);return 'paused';}throw budget;}
     state.pendingRetry={key,scope:error.scope,epoch:(current.retryCounts?.[error.scope]??0)+1};await services.save();services.write(`Retrying blocked check once: ${error.scope}. Completed reviews are retained.`);
     continue;
    }
   }
   await services.save();services.write(state.problem);if(error instanceof OperatorError&&error.remedy)services.write(error.remedy);return 'blocked';
  }
 }
 state.problem='Preparation made too many transitions without becoming ready.';await services.save();return 'blocked';
}
const directory=(project:string)=>project+'-harness/acceptance';
async function loadState(project:string):Promise<WorkflowState>{
 const raw=await readArtifact(directory(project),'workflow.json',8*1024*1024);
 if(!raw)return {version:1,retried:[],runs:[]};const s=JSON.parse(raw) as WorkflowState;
 if(!s||s.version!==1||!Array.isArray(s.retried)||s.retried.some(v=>typeof v!=='string')||!Array.isArray(s.runs))throw new OperatorError('Invalid saved preparation workflow.');
 for(const r of s.runs){
  if(!r||typeof r.started!=='string'||!['running','ready','paused','blocked'].includes(r.status)||!r.limits||!r.spend||!Number.isInteger(r.spend.requests)||r.spend.requests<0)throw new OperatorError('Invalid saved preparation allowance.');
  validateCheckLimits(r.limits);
  for(const value of [r.spend.reportedTokens,r.spend.reportedCostUsd,r.spend.unreported,r.spend.recorded])if(value!==undefined&&(!Number.isFinite(value)||value<0))throw new OperatorError('Invalid saved preparation usage.');
 }
 if(s.pendingRetry&&(typeof s.pendingRetry.key!=='string'||typeof s.pendingRetry.scope!=='string'||!Number.isInteger(s.pendingRetry.epoch)||s.pendingRetry.epoch<1))throw new OperatorError('Invalid saved preparation retry.');
 return s;
}
export async function prepareChecks(project:string,io:Dialogue,limits:CheckLimits=defaultCheckLimits):Promise<WorkflowOutcome>{
 validateCheckLimits(limits);project=await canonicalProject(project);
 return withWriter(project,'checks prepare',async()=>{
  const state=await loadState(project),run:WorkflowRun={started:new Date().toISOString(),limits,spend:{requests:0},status:'running'};
  state.runs.push(run);await mkdir(directory(project),{recursive:true,mode:0o700});
  const save=()=>atomicWrite(path.join(directory(project),'workflow.json'),JSON.stringify(state,null,2)+'\n');
  io.write(`Preparation allowance: ${limits.maxRequests} model requests, ${limits.maxSeconds}s total, ${limits.requestSeconds}s per request. Completed reviews are reused; approval remains separate.`);
  await save();await describeCheckProgress(project,io.write);
  const snapshot=async()=>{
   const raw=await readArtifact(directory(project),'review-progress.json',8*1024*1024)??await readArtifact(directory(project),'preparation.json',8*1024*1024);
   const record=raw?JSON.parse(raw):undefined;
   return {key:record?`${record.taskDigest}:${record.sourceDigest}`:'new',retryCounts:Object.fromEntries((record?.ledger?.entries??[]).map((e:{scope:string;retryCount?:number})=>[e.scope,e.retryCount??0])),ready:await readyCheckDraft(project)};
  };
  try{
   run.status=await withCheckBudget(limits,run.spend,save,io.write,()=>driveCheckWorkflow(state,{snapshot,save,write:io.write,repair:scope=>repairSavedCheck(project,io,scope),resume:async()=>{
    if(await resumePreparation(project,io,true))return;
    const features=await readFeatures(project);if(!features?.ok||!features.features.length)throw new OperatorError('Accept work items before preparing checks.','Use harness guide to plan and accept items first.');
    const index=await choose(io,'Prepare checks for which task?',features.features.map(t=>`${t.title} (${t.id})`));if(index<0)throw new OperatorError('Preparation cancelled.');
    await guidedSetup(project,features.features[index]!,io,undefined,undefined,undefined,false,true);
   }}));
  }catch(error){run.status='blocked';state.problem=(error as Error).message;throw error;}finally{await save();}
  io.write(run.status==='ready'?'Checks are ready for your approval. Next: harness checks review.':run.status==='paused'?'Resume with harness checks prepare; completed work is retained.':'Preparation needs attention. Details are saved; no automatic retry loop will run.');
  return run.status;
 });
}
async function describeCheckProgress(project:string,write:(s:string)=>void):Promise<void>{
 const raw=await readArtifact(directory(project),'review-progress.json',8*1024*1024);if(!raw)return;
 const record=JSON.parse(raw),features=await readFeatures(project),task=features?.ok?features.features.find(t=>t.id===record.taskId):undefined;
 if(!task||!record.proposal||!record.ledger)return;
 const p=parseProposal(record.proposal,task),scopes=['$contract',...p.manifest.cases.map(c=>c.id)];let reviewed=0,stale=0;
 for(const scope of scopes){
  const entry=record.ledger.entries?.find((e:{scope:string;digest:string})=>e.scope===scope&&e.digest===scopeDigest(task,p,scope));
  const check=p.manifest.cases.find(c=>c.id===scope);let current=true;
  if(check)try{assertServerRuntimes({version:1,cases:[check]});for(const step of check.steps)assertRecipeStep(step);}catch{current=false;stale++;}
  if(current&&entry?.review?.verdict==='pass')reviewed++;
 }
 write(`Saved check reviews for ${task.title}: ${reviewed}/${scopes.length} sections; ${stale} helper refreshes needed. Source and task freshness are verified before resuming.`);
}
export async function checkWorkflowStatus(project:string,write:(s:string)=>void):Promise<void>{
 project=await canonicalProject(project);await describeCheckProgress(project,write);const state=await loadState(project),last=state.runs.at(-1);
 if(!last){write('No bounded preparation run is recorded. Start or resume with harness checks prepare.');return;}
 write(`Last recorded preparation: ${last.status}; ${last.spend.requests}/${last.limits.maxRequests} requests.`);
 write(describeCheckSpend(last.spend));
 if(state.runs.length>1){
  const total:CheckSpend={requests:0,recorded:0};
  for(const {spend} of state.runs){total.requests+=spend.requests;total.recorded=(total.recorded??0)+(spend.recorded??0);total.unreported=(total.unreported??0)+(spend.unreported??0);if(spend.reportedTokens!==undefined)total.reportedTokens=(total.reportedTokens??0)+spend.reportedTokens;if(spend.reportedCostUsd!==undefined)total.reportedCostUsd=(total.reportedCostUsd??0)+spend.reportedCostUsd;}
  write(`All ${state.runs.length} bounded preparation runs: ${total.requests} requests. ${describeCheckSpend(total)}`);
 }
 if(state.problem)write(state.problem);write('Continue: harness checks prepare. Final approval: harness checks review.');
}
