import {completeTorchCheckpoint} from './torch-checkpoint.ts';
import {parseJobSpec,validateCheckpoint} from '../../jobs/schema.ts';import type {Job} from '../../jobs/state.ts';
import {TRAIN_COMMAND} from '../../ml/recipe.ts';import {TORCH_COMMAND} from '../../torch/recipe.ts';
import {fingerprint,validateModel} from '../../ml/schema.ts';import {modelContext,type MlApproval} from '../../ml/store.ts';import type {TorchApproval} from '../../torch/store.ts';import {validateTorchCheckpoint} from '../../torch/schema.ts';
import {object,hash,uuidId,timestamp,type EvidenceRecord} from './schema.ts';import {same,ref,type MlData,type MlProvider} from './ml.ts';import {EvidenceReader} from './reader.ts';
export async function mlJob(reader:EvidenceReader,d:MlData,provider:MlProvider):Promise<Job>{
 const s=d.state,a=d.a as MlApproval|TorchApproval;if(!uuidId(s.jobId,'job'))throw Error('Missing training job.');
 const j=object(await reader.json('jobs/'+s.jobId+'/state.json'),['version','id','spec','specDigest','status','attempts','reservedSeconds','elapsedSeconds','events','profile','capabilities','image','docker','installPolicy','environment','source','identity','container','token','checkpoint','completed','artifacts','cost']) as unknown as Job;
 const spec=parseJobSpec(j.spec),total=provider==='cpu-regression'?(a as MlApproval).spec.epochs:(a as TorchApproval).spec.steps;
 if(j.version!==1||j.id!==s.jobId||j.status!=='succeeded'||j.container!==undefined||!Number.isInteger(j.attempts)||j.attempts<1||j.attempts>spec.limits.maxAttempts||j.completed!==total||!uuidId(j.checkpoint,'artifact')||!hash(j.source?.digest)||!hash(j.identity)||!hash(j.environment)||!/^sha256:[a-f0-9]{64}$/u.test(j.image??'')||j.specDigest!==fingerprint(spec)||!Number.isFinite(j.elapsedSeconds)||j.elapsedSeconds<0||j.reservedSeconds!==j.attempts*spec.limits.timeoutSeconds||j.reservedSeconds>spec.limits.totalSeconds)throw Error('Job is incomplete or its identity changed.');
 same(spec.recipe,{id:provider==='cpu-regression'?'linear-regression':'torch-cpu',version:1,approvalId:a.id,approvalDigest:a.digest},'Recipe selection changed.');same(spec.command,provider==='cpu-regression'?TRAIN_COMMAND:TORCH_COMMAND,'Training command changed.');same(spec.outputs,['model.json'],'Training outputs changed.');same(spec.checkpoint,{protocol:'json-step@1',total},'Checkpoint protocol changed.');same(spec.limits,a.spec.limits,'Approved job limits changed.');
 if(provider==='torch-cpu'&&j.image!==(a as TorchApproval).image)throw Error('PyTorch image changed.');
 if(!Array.isArray(j.artifacts)||j.artifacts.length>40||j.artifacts.some(v=>!uuidId(v,'artifact'))||new Set(j.artifacts).size!==j.artifacts.length||!Array.isArray(j.events)||j.events.length<1||j.events.length>512||j.events.some(e=>!timestamp(e.at)||typeof e.phase!=='string'||typeof e.message!=='string')||j.events.some((e,i)=>i>0&&e.at<j.events[i-1]!.at))throw Error('Invalid job history or artifacts.');
 const identity=fingerprint({version:1,protocol:spec.checkpoint!.protocol,spec:j.specDigest,source:j.source!.digest,profile:j.profile,capabilities:j.capabilities,environment:j.environment,policy:j.installPolicy});if(identity!==j.identity)throw Error('Job runtime identity changed.');return j;
}
export async function jobArtifact(reader:EvidenceReader,j:Job,id:string){const v=await reader.artifact(id),a=v.artifact;if(a.producer!==j.id||a.input!==j.source!.digest||a.environment!==j.identity)throw Error('Artifact training provenance changed.');return v;}
export async function jobModel(reader:EvidenceReader,j:Job){const values=[];for(const id of j.artifacts){const v=await jobArtifact(reader,j,id);if(v.artifact.name==='model.json')values.push(v);}if(values.length!==1)throw Error('Missing or ambiguous trained model.');return values[0]!;}
export async function jobCheckpoint(reader:EvidenceReader,j:Job,id:string){const cp=await jobArtifact(reader,j,id);if(cp.artifact.name!=='checkpoint.json')throw Error('Checkpoint artifact changed.');validateCheckpoint(cp.bytes,j.spec.checkpoint!,j.identity!);return cp;}
export function domainCheckpoint(bytes:Buffer,d:MlData,j:Job){const c=validateCheckpoint(bytes,j.spec.checkpoint!,j.identity!);if(d.folder.startsWith('ml/')){const m=validateModel(c.payload,modelContext(d.a as MlApproval),c.completed);if(m.completed!==c.completed)throw Error('Checkpoint progress differs from its model.');}else completeTorchCheckpoint(c.payload,d.a as TorchApproval,c.completed,d.train.length);return c;}
export async function recoveryEvidence(reader:EvidenceReader,d:MlData,j:Job,q:EvidenceRecord,checkpoint:EvidenceRecord,r:EvidenceRecord){
 r.subject=q.subject;if(q.lineage)r.lineage=q.lineage;r.producer=j.id;
 let previous:any,demonstrated=false;
 for(let i=1;i<=j.attempts;i++){
  const raw=await reader.json(`jobs/${j.id}/recovery/attempt-${i}.json`);if(!raw){r.detail='Historical job lacks structured attempt/checkpoint links. Run an explicitly bounded cancellation/recovery trial on a new approval; this report never retrains.';r.next='harness '+(d.folder.startsWith('ml/')?'ml':'torch')+' setup';return;}
  const v=object(raw,['version','job','attempt','source','spec','identity','image','at','from','input','to','output','status','launched','cleaned','digest']) as any,{digest,...body}=v;
  if(v.version!==1||v.job!==j.id||v.attempt!==i||v.source!==j.source!.digest||v.spec!==j.specDigest||v.identity!==j.identity||v.image!==j.image||!timestamp(v.at)||fingerprint(body)!==digest||v.cleaned!==true||typeof v.launched!=='boolean'||!['cancelled','timed-out','interrupted','failed','succeeded'].includes(v.status)||!Number.isInteger(v.from)||!Number.isInteger(v.to)||v.from<0||v.to<v.from||v.to>j.completed!||(i===1&&v.from!==0))throw Error('Recovery attempt identity or cleanup changed.');
  if(i===1&&v.input!==null)throw Error('Recovery first attempt unexpectedly resumes.');
  if(previous&&(v.input!==previous.output||v.from!==previous.to||previous.status==='succeeded'))throw Error('Recovery chain does not use the interrupted checkpoint.');
  for(const key of ['input','output'])if(v[key]!==null){if(!uuidId(v[key],'artifact'))throw Error('Invalid recovery checkpoint reference.');const cp=await jobCheckpoint(reader,j,v[key]),point=domainCheckpoint(cp.bytes,d,j);if(point.completed!==(key==='input'?v.from:v.to))throw Error('Recovery checkpoint progress changed.');r.artifacts.push(ref(cp));}
  if(v.output===null&&v.to!==0)throw Error('Recovery output checkpoint missing.');
  if(previous&&['cancelled','timed-out','interrupted'].includes(previous.status)&&previous.launched&&v.launched&&v.from>0&&v.from<j.completed!&&v.to>v.from)demonstrated=true;
  previous=v;
 }
 if(previous.status!=='succeeded'||previous.output!==j.checkpoint||previous.to!==j.completed||!previous.launched)throw Error('Recovery final model does not match completed training.');
 if(demonstrated){r.applicability='current';r.outcome=q.outcome==='passed'?'passed':'failed';r.detail='A stopped attempt retained a validated checkpoint; a fresh attempt resumed it, advanced training and produced this evaluated model. No uninterrupted-reference equivalence is claimed.';r.artifacts=[...new Map(r.artifacts.map(a=>[a.id,a])).values()];}
 else r.detail='Checkpoint is complete, but this selected model has no observed interruption followed by resumed progress. Normal training completion is not a recovery demonstration.';
 if(q.lineage)checkpoint.lineage=q.lineage;
}
