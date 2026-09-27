import {readFile} from 'node:fs/promises';
import {withWriter,writerPath,recoverWriter} from '../workspace/writer-lock.ts';import {putArtifact,exportArtifact,releaseArtifacts} from '../artifacts/store.ts';
import {fingerprint,predict,assessPredictions,type Row} from '../ml/schema.ts';
import {readMetal,readMetalState,saveMetalState,type MetalApproval,type Attempt,type MetalState} from './store.ts';
import {validateCheckpoint,type Checkpoint} from './schema.ts';import {readMetalRuntime,metalProtocol,type MetalRuntime} from './runtime.ts';import {runSegment,recoverSegment} from './engine.ts';
export interface Engine {runtime:()=>Promise<MetalRuntime>;run:(project:string,a:MetalApproval,rows:Row[],previous:Checkpoint|null,to:number,attempt:Attempt,notify:(s:string)=>void)=>Promise<unknown>;recover:(project:string,a:MetalApproval,attempt:Attempt)=>Promise<unknown|null>;}
const nativeEngine:Engine={runtime:readMetalRuntime,run:runSegment,recover:recoverSegment};
function promote(s:MetalState,a:MetalApproval,raw:unknown){const attempt=s.attempts.at(-1)!;const c=validateCheckpoint(raw,a,attempt.from,attempt.to,s.checkpoint?.device);s.checkpoint=c;s.checkpointHash=fingerprint(c);attempt.status='completed';s.status=c.model.completed===a.spec.epochs?'trained':'paused';s.message=`Saved epoch ${c.model.completed}/${a.spec.epochs} on ${c.device}.`;}
export async function trainMetal(project:string,id:string,notify:(s:string)=>void=()=>{},oneCheckpoint=false,engine:Engine=nativeEngine){return withWriter(project,'Metal training',async()=>{
 const {approval:a,train}=await readMetal(project,id);if(JSON.stringify(await engine.runtime())!==JSON.stringify(a.runtime))throw Error('Metal runtime changed. Approve a new workflow after validation.');
 const s=await readMetalState(project,id);if(s.status==='released')throw Error('This Metal workflow is retired.');if(s.status==='running')throw Error('Recover the interrupted Metal controller first: harness metal recover '+id);if(s.evaluatedHash)throw Error('This model has already been evaluated. Training settings and holdout are frozen.');if(s.status==='trained')return s;
 do{
  if(s.attempts.length>=a.spec.limits.maxAttempts||(s.attempts.length+1)*a.spec.limits.timeoutSeconds>a.spec.limits.totalSeconds)throw Error('Metal training budget exhausted. Existing checkpoints remain saved; approve a new budget explicitly.');
  const from=s.checkpoint?.model.completed??0,attempt:Attempt={index:s.attempts.length+1,from,to:Math.min(from+a.spec.checkpointEvery,a.spec.epochs),status:'running'};
  s.attempts.push(attempt);s.status='running';s.controllerPid=process.pid;s.message=`Training epochs ${from}–${attempt.to}.`;await saveMetalState(project,s);notify(s.message);
  try{const raw=await engine.run(project,a,train,s.checkpoint??null,attempt.to,attempt,notify);promote(s,a,raw);await saveMetalState(project,s);notify(s.message!);}
  catch(e){s.message=(e as Error).message;
   // A controller exception may leave an owned VM. Recovery decides whether resources and a completed result remain.
   try{const raw=await engine.recover(project,a,attempt);attempt.status='interrupted';s.status='paused';if(raw){try{promote(s,a,raw);}catch{/* Invalid child output cannot replace the prior checkpoint. */}}}catch{s.status='running';}
   await saveMetalState(project,s);throw e;
  }
 }while(!oneCheckpoint&&s.checkpoint!.model.completed<a.spec.epochs);return s;
});}
export async function recoverMetal(project:string,id:string,engine:Engine=nativeEngine){
 const s=await readMetalState(project,id);if(s.status!=='running')return s;
 const lock=await readFile(await writerPath(project),'utf8').then(s=>JSON.parse(s)).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return null;throw e;});
 if(lock){if(lock.pid!==s.controllerPid)throw Error('Another writer owns this project.');await recoverWriter(project,lock.token);}
 else if(s.controllerPid){try{process.kill(s.controllerPid,0);throw Error('Metal controller is still alive.');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}}
 return withWriter(project,'Metal recovery',async()=>{const {approval:a}=await readMetal(project,id),state=await readMetalState(project,id),attempt=state.attempts.at(-1)!;const raw=await engine.recover(project,a,attempt);attempt.status='interrupted';state.status='paused';state.message='Interrupted segment discarded. Resume from the last completed checkpoint.';if(raw){try{promote(state,a,raw);}catch(e){state.message='Rejected checkpoint: '+(e as Error).message;await saveMetalState(project,state);throw e;}}await saveMetalState(project,state);return state;});
}
export async function evaluateMetal(project:string,id:string){return withWriter(project,'Metal evaluation',async()=>{
 const {approval:a,holdout}=await readMetal(project,id),s=await readMetalState(project,id);if(!['trained','passed','failed'].includes(s.status)||!s.checkpoint)throw Error('Finish training before evaluating.');
 if(a.runtime.protocol!==await metalProtocol())throw Error('Metal training/evaluation protocol changed. Retain this model as unverified evidence; approve a new workflow.');
 const model=s.checkpoint.model,identity=fingerprint(model);if(s.evaluatedHash&&s.evaluatedHash!==identity)throw Error('Only the first completed model may see this holdout.');
 s.evaluatedHash=identity;await saveMetalState(project,s);
 const report=assessPredictions(holdout.map(r=>predict(model,r.x)),holdout.map(r=>r.y),a.baseline,a.spec);s.assessment=report;s.status=report.passed?'passed':'failed';s.message=`Holdout RMSE ${report.rmse}; baseline ${report.baselineRmse}; ${report.passed?'passed':'failed'}.`;
 if(report.passed&&!s.artifact){const artifact=await putArtifact(project,'metal-model.json',Buffer.from(JSON.stringify(model,null,2)+'\n'),{producer:a.id,input:a.digest,environment:fingerprint(a.runtime),verification:'evaluation-passed',evaluation:{approval:a.digest,reportHash:fingerprint(report)}});s.artifact=artifact.id;}
 await saveMetalState(project,s);return report;
});}
export async function exportMetal(project:string,id:string,destination:string){return withWriter(project,'Metal export',async()=>{const s=await readMetalState(project,id);if(s.status!=='passed'||!s.artifact)throw Error('Only a model that passed holdout evaluation may be exported.');await exportArtifact(project,s.artifact,destination);});}

export async function releaseMetal(project:string,id:string){return withWriter(project,'Metal retirement',async()=>{const s=await readMetalState(project,id);if(s.status==='running')throw Error('Recover the active Metal controller before retirement.');s.status='released';s.message='Retired. Approved data and checkpoint audit remain saved; training and export are disabled.';await saveMetalState(project,s);await releaseArtifacts(project,id,new Set());});}
