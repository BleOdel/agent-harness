import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {buildVerificationArguments} from '../containment/sandbox.ts';import {runContained} from '../containment/process.ts';import {executionLayout} from '../project/execution.ts';
import {artifactBytes,listArtifacts,putArtifact,exportArtifact,sha256,releaseArtifacts} from '../artifacts/store.ts';
import {createJob,readJob,listJobs} from '../jobs/state.ts';
import {runJob,releaseJob} from '../jobs/controller.ts';
import {withWriter} from '../workspace/writer-lock.ts';
import {loadConfig} from '../config.ts';
import {readTorch,readTorchState,saveTorchState,recipeHash} from './store.ts';
import {TORCH_COMMAND} from './recipe.ts';
import {assessTorch,predictTorch,validateTorchCheckpoint,validateTorchModel} from './schema.ts';
export async function trainTorch(project:string,id:string,notify:(s:string)=>void=()=>{}){
 const jobId=await withWriter(project,'PyTorch training',async()=>{
  const {approval:a}=await readTorch(project,id),s=await readTorchState(project,id);if(['passed','failed','released'].includes(s.status))throw Error('This workflow is finished. Create a new approval for new training.');
  if(!s.jobId){const found=(await listJobs(project)).find(j=>j.spec.recipe?.approvalId===id);s.jobId=found?.id??(await createJob(project,{version:1,title:a.spec.title,command:TORCH_COMMAND,outputs:['model.json'],recipe:{id:'torch-cpu',version:1,approvalId:id,approvalDigest:a.digest},checkpoint:{protocol:'json-step@1',total:a.spec.steps},limits:a.spec.limits})).id;}
  s.status='training';await saveTorchState(project,s);return s.jobId;
 });
 const {approval:a}=await readTorch(project,id),j=await readJob(project,jobId);
 return j.status==='succeeded'?j:runJob(project,jobId,notify,{...loadConfig({...process.env,HARNESS_PROJECT:project}),imageId:a.image});
}
export async function evaluateTorch(project:string,id:string){return withWriter(project,'PyTorch evaluation',async()=>{
 const {approval:a,train,holdout}=await readTorch(project,id),s=await readTorchState(project,id);if(s.status==='released')throw Error('Workflow retired.');if(s.report&&(s.status==='failed'||s.artifact))return s.report;
 if(!s.jobId)throw Error('Train the model first.');const j=await readJob(project,s.jobId);if(a.recipe!==await recipeHash()||j.image!==a.image||j.spec.recipe?.approvalDigest!==a.digest)throw Error('Training recipe, image or approval changed.');if(j.status!=='succeeded'||j.completed!==a.spec.steps||!j.checkpoint)throw Error('Training must finish with a complete checkpoint before evaluation.');
 const checkpoint=JSON.parse((await artifactBytes(project,j.checkpoint)).toString());validateTorchCheckpoint(checkpoint.payload,a.digest,a.spec.steps,a.spec.kind);
 const f=(await listArtifacts(project)).find(f=>j.artifacts.includes(f.id)&&f.name==='model.json');if(!f)throw Error('Model output missing.');const bytes=await artifactBytes(project,f.id),candidate=sha256(bytes);if(s.candidateHash&&candidate!==s.candidateHash)throw Error('First evaluation candidate is frozen.');s.candidateHash=candidate;await saveTorchState(project,s);
 const m=validateTorchModel(JSON.parse(bytes.toString()),a.features.length,a.spec.clusters);if(m.context!==a.digest||m.completed!==a.spec.steps||m.kind!==a.spec.kind)throw Error('Model identity does not match the approval.');
 const values=predictTorch(m,holdout,a.means,a.scales);
 const temporary=await realpath(await mkdtemp(path.join(os.tmpdir(),'torch-evaluation-')));
 try{
  await writeFile(temporary+'/input.json',JSON.stringify({model:m,features:holdout.map(r=>r.x),means:a.means,scales:a.scales}));
  const config={...loadConfig({...process.env,HARNESS_PROJECT:project}),imageId:a.image},layout={...executionLayout(config,temporary,'harness-torch-evaluation-'+path.basename(temporary)),instrumentationDirectory:import.meta.dirname};
  const r=await runContained(layout,buildVerificationArguments(layout,'none',['/usr/local/bin/python3','-I','/harness-instrumentation/predict.py']),{timeoutMs:60000,maxOutputBytes:1024*1024});
  if(r.code!==0||r.timedOut||r.outputLimited)throw Error('Fresh PyTorch inference failed: '+r.stderr.slice(-1000));const predictions=JSON.parse(r.stdout).predictions;
  if(!Array.isArray(predictions)||predictions.length!==values.length||predictions.some((v,i)=>typeof v!=='number'||!Number.isFinite(v)||Math.abs(v-values[i]!)>(a.spec.kind==='classifier'?0:1e-4*Math.max(1,Math.abs(values[i]!)))))throw Error('Fresh PyTorch predictions disagree with independent host inference.');
 }finally{await rm(temporary,{recursive:true,force:true});}
 if((await readTorch(project,id)).approval.digest!==a.digest||await recipeHash()!==a.recipe)throw Error('Evaluation inputs changed.');
 const report=assessTorch(a.spec.kind,values,holdout.map(r=>r.y??0),a.spec.maxError);
 const majority=Number(train.filter(r=>r.y===1).length>train.length/2),baseline=a.spec.kind==='classifier'?holdout.filter(r=>r.y!==majority).length/holdout.length:holdout.reduce((s,r)=>s+r.x.reduce((v,x,i)=>v+((x-a.means[i]!)/a.scales[i]!)**2,0),0)/holdout.length;
 s.report={...report,baseline,passed:report.passed&&report.error<baseline,rows:holdout.length,candidateHash:candidate,limitation:a.spec.kind==='kmeans'?'Distance measures compactness, not useful semantic groups.':'Small binary numeric classifier; generalization depends on representative independent rows.'};s.status=s.report.passed?'training':'failed';await saveTorchState(project,s);
 if(s.report.passed){const output=Buffer.from(JSON.stringify({...m,features:a.features,means:a.means,scales:a.scales}));const artifact=await putArtifact(project,'torch-model.json',output,{producer:id,input:a.digest,environment:j.identity!,verification:'evaluation-passed',evaluation:{approval:a.digest,reportHash:sha256(JSON.stringify(s.report))}});s.artifact=artifact.id;s.status='passed';await saveTorchState(project,s);}return s.report;
 });}
export async function exportTorch(project:string,id:string,destination:string){return withWriter(project,'PyTorch export',async()=>{const {approval:a}=await readTorch(project,id),s=await readTorchState(project,id);if(s.status!=='passed'||!s.artifact||!s.report?.passed)throw Error('Only quality-passed models can be exported here.');const f=(await listArtifacts(project)).find(f=>f.id===s.artifact);if(!f||f.producer!==id||f.verification!=='evaluation-passed'||f.evaluation?.approval!==a.digest||f.evaluation.reportHash!==sha256(JSON.stringify(s.report)))throw Error('Evaluation provenance changed.');await exportArtifact(project,s.artifact,destination);});}
export async function releaseTorch(project:string,id:string){const job=await withWriter(project,'PyTorch retire',async()=>{const s=await readTorchState(project,id);if(s.jobId&&['preparing','running'].includes((await readJob(project,s.jobId)).status))throw Error('Cancel or recover active training first.');s.status='released';await saveTorchState(project,s);await releaseArtifacts(project,id,new Set());return s.jobId;});if(job)await releaseJob(project,job);}
