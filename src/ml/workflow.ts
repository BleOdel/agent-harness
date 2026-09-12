import { loadConfig, type Config } from '../config.ts';
import { createJob, listJobs, readJob, type Job } from '../jobs/state.ts';
import { recoverJob, releaseJob, requestCancel, runJob } from '../jobs/controller.ts';
import { releaseArtifacts } from '../artifacts/store.ts';
import { withWriter } from '../workspace/writer-lock.ts';
import { OperatorError } from '../verbs/io.ts';
import { evaluateMl, type Evaluation } from './evaluation.ts';
import { TRAIN_COMMAND } from './recipe.ts';
import { readMl, readMlState, saveMlState } from './store.ts';
export async function trainingJob(project:string,id:string):Promise<Job>{return withWriter(project,'ml prepare',async()=>{
 const {approval:a}=await readMl(project,id),state=await readMlState(project,id);
 if(state.status==='released')throw new OperatorError('This ML workflow is retired. Create a new approval to train.');
 if(state.jobId)return readJob(project,state.jobId);
 // Reconcile a crash between job creation and recording its link; never dispatch twice.
 const matching=(await listJobs(project)).filter(j=>j.spec.recipe?.approvalId===id);
 if(matching.length>1)throw new OperatorError('Multiple jobs refer to this ML approval. Inspect them before continuing.');
 const job=matching[0]??await createJob(project,{version:1,title:a.spec.title,command:TRAIN_COMMAND,outputs:['model.json'],checkpoint:{protocol:'json-step@1',total:a.spec.epochs},limits:a.spec.limits,recipe:{id:'linear-regression',version:1,approvalId:id,approvalDigest:a.digest}});
 state.jobId=job.id;state.status='training';await saveMlState(project,state);return job;
});}
export async function trainMl(project:string,id:string,notify:(message:string)=>void=()=>{},config:Config=loadConfig({...process.env,HARNESS_PROJECT:project})):Promise<{job:Job;evaluation?:Evaluation}>{return withWriter(project,'ml train',async()=>{
 let job=await trainingJob(project,id);if(job.status!=='succeeded')job=await runJob(project,job.id,notify,config);
 const state=await readMlState(project,id);
 if(job.status!=='succeeded'){state.status='training';state.reason=`Training ${job.status}; use the saved job checkpoint or recovery action.`;await saveMlState(project,state);return {job};}
 if(!state.candidateHash){state.status='ready';delete state.reason;await saveMlState(project,state);}
 notify('Training finished. Evaluating in a fresh Python process; holdout labels stay on the host.');
 return {job,evaluation:await evaluateMl(project,id,undefined,config)};
});}
export async function cancelMl(project:string,id:string):Promise<void>{const state=await readMlState(project,id);if(!state.jobId)throw new OperatorError('No training job has started.');await requestCancel(project,state.jobId);}
export async function recoverMl(project:string,id:string):Promise<void>{const state=await readMlState(project,id);if(!state.jobId)throw new OperatorError('No training job to recover.');await recoverJob(project,state.jobId);}
export async function releaseMl(project:string,id:string):Promise<void>{return withWriter(project,'ml release',async()=>{
 const state=await readMlState(project,id);
 const jobs=(await listJobs(project)).filter(j=>j.spec.recipe?.approvalId===id);
 if(jobs.some(j=>['running','preparing'].includes(j.status)))throw new OperatorError('Cancel or recover active training before retiring this ML workflow.');
 state.status='released';await saveMlState(project,state);
 for(const job of jobs)await releaseJob(project,job.id);
 await releaseArtifacts(project,id,new Set());
});}
