/** Score only an inert numeric model; project code and dependency startup hooks are absent. */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { artifactBytes, listArtifacts, putArtifact, readJson, saveJson, exportArtifact } from '../artifacts/store.ts';
import { loadConfig, type Config } from '../config.ts';
import { buildVerificationArguments } from '../containment/sandbox.ts';
import { runContained } from '../containment/process.ts';
import { executionLayout } from '../project/execution.ts';
import { readJob } from '../jobs/state.ts';
import { withWriter } from '../workspace/writer-lock.ts';
import { OperatorError } from '../verbs/io.ts';
import { assessPredictions, fingerprint, hash, object, predict, validateModel, type Assessment, type LinearModel } from './schema.ts';
import { mlDirectory, modelContext, readMl, readMlState, recipeHash, resources, saveMlState } from './store.ts';
export interface Evaluation {version:1;approval:string;modelHash:string;source:string;environment:string;image:string;recipe:string;trainHash:string;holdoutHash:string;trainRows:number;holdoutRows:number;at:string;outcome:'passed'|'failed';assessment?:Assessment;reason?:string;retryable?:boolean;}
export function checkedPredictions(raw:unknown,model:LinearModel,features:number[][]):number[]{
 const report=object(raw,['version','predictions']);
 if(report.version!==1||!Array.isArray(report.predictions)||report.predictions.length!==features.length)throw new OperatorError('Invalid or fabricated prediction report.');
 for(const [i,row]of features.entries()){
  const expected=predict(model,row),actual=report.predictions[i];
  if(typeof actual!=='number'||!Number.isFinite(actual)||Math.abs(actual-expected)>1e-9*Math.max(1,Math.abs(expected)))throw new OperatorError('Fresh Python predictions disagree with the host numeric model.');
 }
 return report.predictions as number[];
}
export async function evaluateMl(project:string,id:string,selected?:string,config:Config=loadConfig({...process.env,HARNESS_PROJECT:project})):Promise<Evaluation>{
 return withWriter(project,'ml evaluate',async()=>{
 const data=await readMl(project,id),a=data.approval,state=await readMlState(project,id);
 if(state.status==='released'||!state.jobId)throw new OperatorError('Train this approved ML workflow before evaluating it.');
 const job=await readJob(project,state.jobId);
 if(job.status!=='succeeded'||job.spec.recipe?.approvalDigest!==a.digest||job.image!==config.imageId||job.spec.recipe?.approvalId!==id||a.recipe!==await recipeHash())throw new OperatorError('Evaluation needs the completed training job, unchanged recipe/approval and original Python image.');
 const artifacts=await listArtifacts(project),artifact=artifacts.find(item=>selected?item.id===selected:job.artifacts.includes(item.id)&&item.name==='model.json');
 if(!artifact||artifact.producer!==job.id||artifact.input!==job.source?.digest||artifact.environment!==job.identity)throw new OperatorError('No model artifact matches this training job and its inputs.');
 const bytes=await artifactBytes(project,artifact.id),modelHash=hash(bytes);
 if(state.candidateHash&&state.candidateHash!==modelHash)throw new OperatorError('This holdout approval already evaluated a different model. Use a new protected evaluation dataset and approval; do not tune against this holdout.');
 if(state.report&&['passed','failed'].includes(state.status))return readEvaluation(project,id);
 state.candidateHash=modelHash;state.status='evaluating';await saveMlState(project,state);
 const report:Evaluation={version:1,approval:a.digest,modelHash,source:job.source!.digest,environment:job.identity!,image:job.image,recipe:a.recipe,trainHash:a.dataset.trainHash,holdoutHash:a.dataset.holdoutHash,trainRows:data.train.length,holdoutRows:data.holdout.length,at:new Date().toISOString(),outcome:'failed'};
 let temporary:string|undefined;
 try{
  const model=validateModel(JSON.parse(bytes.toString()),modelContext(a),a.spec.epochs);
  temporary=await realpath(await mkdtemp(path.join(os.tmpdir(),'harness-ml-evaluation-')));
  // Only predictors reach the fresh inference process. Labels remain in this controller.
  await writeFile(path.join(temporary,'input.json'),JSON.stringify({model,features:data.holdout.map(r=>r.x)}));
  const layout={...executionLayout(config,temporary,`harness-ml-evaluation-${path.basename(temporary)}`),purpose:'verification' as const,instrumentationDirectory:resources};
  const result=await runContained(layout,buildVerificationArguments(layout,'none',['/usr/local/bin/python3','-I','-S','/harness-instrumentation/predict.py']),{timeoutMs:config.gateTimeoutMs,maxOutputBytes:2*1024*1024}).catch(error=>{report.retryable=true;throw error;});
  if(result.code!==0||result.timedOut||result.outputLimited){report.retryable=true;throw new OperatorError(`Fresh model inference ${result.timedOut?'timed out':'failed'}: ${result.stderr.slice(-1000)}`);}
  const predictions=checkedPredictions(JSON.parse(result.stdout),model,data.holdout.map(r=>r.x));
  report.assessment=assessPredictions(predictions,data.holdout.map(r=>r.y),a.baseline,a.spec);
  report.outcome=report.assessment.passed?'passed':'failed';
  if(!report.assessment.passed)report.reason='Model did not meet both the approved RMSE ceiling and baseline improvement.';
 }catch(error){report.reason=(error as Error).message;}
 finally{if(temporary)await rm(temporary,{recursive:true,force:true});}
 // Concurrent operator edits cannot lend old scores to changed data or a new recipe.
 if((await readMl(project,id)).approval.digest!==a.digest||a.recipe!==await recipeHash())throw new OperatorError('Evaluation inputs changed; no model was approved.');
 const root=await mlDirectory(project,id),reportFile=`evaluation-${modelHash}.json`;
 await saveJson(root,reportFile,report);
 if(report.outcome==='passed'){
  const approved=await putArtifact(project,'evaluated-model.json',bytes,{producer:id,input:a.dataset.trainHash,environment:job.identity!,verification:'evaluation-passed',evaluation:{approval:a.digest,reportHash:fingerprint(report)}});
  state.modelArtifact=approved.id;
 }
 state.report=reportFile;state.status=report.retryable?'evaluating':report.outcome;if(report.reason)state.reason=report.reason;else delete state.reason;await saveMlState(project,state);return report;
 });
}
export async function readEvaluation(project:string,id:string):Promise<Evaluation>{
 const {approval}=await readMl(project,id),state=await readMlState(project,id);
 if(!state.report||!/^evaluation-[a-f0-9]{64}\.json$/u.test(state.report))throw new OperatorError('No saved model evaluation. Run harness ml train or evaluate.');
 const report=await readJson(await mlDirectory(project,id),state.report) as Evaluation;
 if(report.version!==1||report.approval!==approval.digest||report.modelHash!==state.candidateHash||report.trainHash!==approval.dataset.trainHash||report.holdoutHash!==approval.dataset.holdoutHash||!['passed','failed'].includes(report.outcome))throw new OperatorError('Saved evaluation does not match the approved data and model.');
 return report;
}
export async function exportModel(project:string,id:string,destination:string):Promise<void>{return withWriter(project,'ml export',async()=>{
 const report=await readEvaluation(project,id),state=await readMlState(project,id);
 if(report.outcome!=='passed'||state.status!=='passed'||!state.modelArtifact)throw new OperatorError('Only a model that passed its approved evaluation can be exported through this workflow.');
 const artifact=(await listArtifacts(project)).find(a=>a.id===state.modelArtifact);
 if(!artifact||artifact.sha256!==report.modelHash||artifact.verification!=='evaluation-passed'||artifact.evaluation?.approval!==report.approval||artifact.evaluation.reportHash!==fingerprint(report))throw new OperatorError('Evaluated model provenance changed.');
 await exportArtifact(project,artifact.id,destination);
});}
