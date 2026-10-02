import {pendingStage} from '../staging/store.ts';
import path from 'node:path';import {randomUUID} from 'node:crypto';
import {readFeatures,nextItems,unmetDependencies} from '../features.ts';
import {readApproval,requireStagingChecks} from '../acceptance/checks.ts';
import {prepareChecks} from '../acceptance/workflow.ts';
import {reviewGuidedDraft} from '../acceptance/guided.ts';
import {parseCheckLimits,defaultCheckLimits,withCheckBudget} from '../acceptance/budget.ts';
import {readArtifact,atomicWrite} from '../planning/store.ts';
import {harnessDirectory} from '../record/record.ts';
import {canonicalProject,withWriter} from '../workspace/writer-lock.ts';
import {driveContinuation,type ContinueState,type ContinueSnapshot} from '../workflow/controller.ts';
import {readContinuation,saveContinuation} from '../workflow/store.ts';
import {terminalDialogue,type Dialogue} from '../guide/dialogue.ts';
import {work} from './work.ts';import {OperatorError,say} from './io.ts';
export async function continuationSnapshot(project:string,taskId:string):Promise<ContinueSnapshot>{
 const f=await readFeatures(project),task=f?.ok?f.features.find(t=>t.id===taskId):undefined;
 if(!task)throw new OperatorError('The saved task no longer exists. Review the project requirements.');
 const staged=await pendingStage(project,taskId);if(staged)return {done:false,checks:'approved',stage:staged.id};
 if(task.status==='done')return {done:true,checks:'approved'};
 const waiting=unmetDependencies(task,f!.ok?f!.features:[]);
 if(task.status==='blocked'||waiting.length)return {done:false,checks:'blocked',reason:waiting.length?`Waiting for prerequisites: ${waiting.join(', ')}.`:'The task explicitly requests human input. Review its recorded reason before resuming.'};
 const approval=await readApproval(project);
 if(!approval?.manifest.cases.some(c=>c.tasks.includes('*')||c.tasks.includes(taskId))){
  return {done:false,checks:'missing'};
 }
 try{await requireStagingChecks(project,[taskId]);return {done:false,checks:'approved'};}
 catch(error){return {done:false,checks:'blocked',reason:`${(error as Error).message}\n${error instanceof OperatorError?error.remedy:''}`};}
}
async function totalCheckRequests(project:string):Promise<number>{
 const raw=await readArtifact(path.join(harnessDirectory(project),'acceptance'),'workflow.json',8*1024*1024);
 if(!raw)return 0;const runs=JSON.parse(raw).runs;
 if(!Array.isArray(runs)||runs.some(r=>!Number.isSafeInteger(r?.spend?.requests)||r.spend.requests<0))throw new OperatorError('Invalid saved request accounting.');
 return runs.reduce((n,r)=>n+r.spend.requests,0);
}
export async function continueCommand(project:string,args:readonly string[],dialogue?:Dialogue):Promise<void>{
 project=await canonicalProject(project);
 if(args.length===1&&args[0]==='status'){
  const s=await readContinuation(project);if(!s){say('No continuation saved. Start with harness continue.');return;}
  say(`${s.task}: ${s.status} (last recorded) · ${s.attempts}/${s.maxBuilds} build dispatches`);say(s.message);
  say(`Saved diagnosis and events: ${path.join(harnessDirectory(project),'continuation.json')}`);return;
 }
 const flags=[...args],renew=flags.includes('--renew');if(renew)flags.splice(flags.indexOf('--renew'),1);
 const taskArg=flags[0]&&!flags[0].startsWith('--')?flags.shift():undefined;
 const buildIndex=flags.indexOf('--max-builds'),maxBuilds=buildIndex>=0?Number(flags[buildIndex+1]):2;
 if(buildIndex>=0)flags.splice(buildIndex,2);
 if(!Number.isInteger(maxBuilds)||maxBuilds<1||maxBuilds>10)throw new OperatorError('--max-builds must be 1..10.');
 const limits=parseCheckLimits(flags),io=dialogue??(process.stdin.isTTY&&process.stdout.isTTY?terminalDialogue():{write:say,ask:async()=>{throw new OperatorError('Approval requires your review.','Run harness checks review in a terminal, then harness continue.');}});
 await withWriter(project,'continue',async()=>{
  const saved=await readContinuation(project),features=await readFeatures(project);
  if(!features?.ok)throw new OperatorError('Accept planned work items before continuing.','Use harness guide.');
  const task=taskArg??(saved&&saved.status!=='complete'?saved.task:nextItems(features.features)[0]?.id);
  if(!task){io.write('No eligible unfinished task. Review the completed project or blocked prerequisites.');return;}
  if(!features.features.some(f=>f.id===task))throw new OperatorError('Unknown task. Use harness look.');
  if(saved&&saved.task!==task&&saved.status!=='complete')throw new OperatorError(`Continuation is saved for ${saved.task}. Finish or resolve it before switching tasks.`);
  const reuse=saved?.task===task&&!renew;
  if(reuse&&(buildIndex>=0&&saved.maxBuilds!==maxBuilds||flags.length&&JSON.stringify(saved.checkLimits)!==JSON.stringify(limits)))throw new OperatorError('The saved allowance is unchanged. Use --renew to explicitly grant a new allowance.');
  if(saved&&(!reuse))await atomicWrite(path.join(harnessDirectory(project),`continuation-${randomUUID()}.json`),JSON.stringify(saved,null,2)+'\n');
  const state:ContinueState=reuse?saved:{version:1,task,status:'running',message:'Starting saved work.',updated:new Date().toISOString(),attempts:0,maxBuilds,recoveries:saved?.task===task?saved.recoveries:0,events:[],checkLimits:limits};
  const configured=state.checkLimits??defaultCheckLimits;
  io.write(`Continuing ${task}: up to ${configured.maxRequests} preparation requests in ${configured.maxSeconds}s, ${configured.requestSeconds}s per request; ${state.maxBuilds} build dispatches with the existing build/gate timeouts. Approval remains yours. This is not a dollar-cost cap.`);
  const output=await driveContinuation(state,{
   snapshot:()=>continuationSnapshot(project,task),save:s=>saveContinuation(project,s),write:io.write,
   prepare:async()=>{
    const total=await totalCheckRequests(project);
    if(state.checkRequestBase===undefined)state.checkRequestBase=total;
    if(state.checkDeadline===undefined)state.checkDeadline=Date.now()+configured.maxSeconds*1000;
    await saveContinuation(project,state);
    const spent=total-state.checkRequestBase;if(spent<0)throw new OperatorError('Request accounting moved backwards. Inspect the saved workflow.');
    const remaining=configured.maxRequests-spent,seconds=Math.floor((state.checkDeadline-Date.now())/1000);
    if(remaining<=0||seconds<configured.requestSeconds)return 'paused';
    return prepareChecks(project,io,{...configured,maxRequests:remaining,maxSeconds:seconds},task);
   },
   review:()=>withCheckBudget(configured,{requests:configured.maxRequests},async()=>{},io.write,()=>reviewGuidedDraft(project,io)),
   build:async()=>{if(await canonicalProject(process.env.HARNESS_PROJECT??process.cwd())!==project)throw new OperatorError('Configured project differs from the continuation project.');await work(["--stage",task]);},
  });
  io.write(`Saved progress: harness continue status. ${output.status==='paused'?'Grant a new allowance when ready: harness continue --renew.':output.status==='complete'?'Review the result in the dashboard.':'Decisions and diagnoses are saved; no log copying is required to retain them.'}`);
  if(output.status==='attention')process.exitCode=1;
 });
}
