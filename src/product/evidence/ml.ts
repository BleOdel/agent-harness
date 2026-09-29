/** Read-only model evidence. Protected rows are used for host arithmetic, never returned. */
import {isDeepStrictEqual} from 'node:util';
import {fingerprint,parseMlSpec,splitDataset,validateModel,predict,assessPredictions,type Row} from '../../ml/schema.ts';
import {recipeHash as cpuRecipe,modelContext,type MlApproval} from '../../ml/store.ts';
import {recipeHash as torchRecipe,type TorchApproval} from '../../torch/store.ts';
import {parseTorchSpec,parseTorchData,splitTorchData} from '../../torch/schema.ts';
import {parseMetalSpec,type MetalSpec} from '../../metal/schema.ts';import {metalProtocol,type MetalRuntime} from '../../metal/runtime.ts';import type {MetalApproval} from '../../metal/store.ts';
import {EvidenceReader} from './reader.ts';import {object,hash,uuidId,timestamp,type EvidenceTarget,type EvidenceRecord} from './schema.ts';
import {mlJob,jobModel,jobCheckpoint,recoveryEvidence,domainCheckpoint} from './ml-job.ts';
import {torchQuality} from './ml-torch.ts';import {metalQuality} from './ml-metal.ts';
export type MlProvider='cpu-regression'|'torch-cpu'|'metal-regression';
export const folders={'cpu-regression':'ml','torch-cpu':'torch','metal-regression':'metal'} as const;
export const same=(a:unknown,b:unknown,message:string)=>{if(!isDeepStrictEqual(a,b))throw Error(message);};
export const requireHash=(v:unknown)=>{if(!hash(v))throw Error('Invalid ML identity.');return v;};
export const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=1e12;
export interface MlData {a:MlApproval|TorchApproval|MetalApproval;train:Row[];holdout:Row[];state:any;folder:string;runtime:string;}
export async function mlData(reader:EvidenceReader,provider:MlProvider,id:string):Promise<MlData>{
 const folder=folders[provider];if(!uuidId(id,folder))throw Error('Invalid ML selection.');const dir=folder+'/'+id;
 const keys=provider==='cpu-regression'?['version','id','approvedAt','spec','schema','dataset','preprocessing','baseline','recipe','digest']:provider==='torch-cpu'?['version','id','spec','features','means','scales','trainHash','holdoutHash','sourceHash','recipe','image','digest']:['version','id','at','spec','runtime','sourceHash','trainHash','holdoutHash','features','preprocessing','baseline','digest'];
 const a=object(await reader.json(dir+'/approved.json'),keys) as any,{digest,...body}=a;
 if(a.version!==1||a.id!==id||!hash(digest)||digest!==fingerprint(body))throw Error('ML approval identity changed.');
 const state=object(await reader.json(dir+'/state.json'),provider==='cpu-regression'?['version','id','jobId','candidateHash','report','modelArtifact','status','reason']:provider==='torch-cpu'?['id','status','jobId','candidateHash','report','artifact']:['version','id','status','attempts','controllerPid','checkpoint','checkpointHash','evaluatedHash','assessment','artifact','message']) as any;
 const statuses=provider==='cpu-regression'?['approved','training','ready','evaluating','passed','failed','released']:provider==='torch-cpu'?['approved','training','passed','failed','released']:['approved','running','paused','trained','passed','failed','released'];
 if(state.id!==id||(provider!=='torch-cpu'&&state.version!==1)||!statuses.includes(state.status))throw Error('Invalid retained ML state.');
 for(const key of ['candidateHash','checkpointHash','evaluatedHash'])if(state[key]!==undefined)requireHash(state[key]);
 for(const key of ['artifact','modelArtifact'])if(state[key]!==undefined&&!uuidId(state[key],'artifact'))throw Error('Invalid evaluated model reference.');
 if(state.jobId!==undefined&&!uuidId(state.jobId,'job'))throw Error('Invalid training job reference.');
 const train=await reader.json(dir+'/train.json'),holdout=await reader.json(dir+'/holdout.json');if(!Array.isArray(train)||!Array.isArray(holdout))throw Error('Missing protected split.');
 let runtime:string;
 if(provider==='torch-cpu'){
  parseTorchSpec(a.spec);requireHash(a.recipe);requireHash(a.sourceHash);if(!/^sha256:[a-f0-9]{64}$/u.test(a.image))throw Error('Invalid PyTorch image.');
  const data=parseTorchData({features:a.features,rows:[...train,...holdout]},a.spec.kind),split=splitTorchData(data,a.spec.seed);
  same(train,split.train,'Training split membership changed.');same(holdout,split.holdout,'Holdout split membership changed.');same(a.means,split.means,'Training preprocessing changed.');same(a.scales,split.scales,'Training preprocessing changed.');
  if(a.spec.kind==='classifier'&&[train,holdout].some(rows=>new Set(rows.map(r=>r.y)).size!==2))throw Error('A classifier split lacks both classes.');
  if(fingerprint(train)!==a.trainHash||fingerprint(holdout)!==a.holdoutHash)throw Error('Protected split bytes changed.');runtime=fingerprint({image:a.image,recipe:a.recipe});
 }else{
  if(provider==='cpu-regression'){parseMlSpec(a.spec);if(!timestamp(a.approvedAt))throw Error('Invalid approval timestamp.');object(a.schema,['features','target']);object(a.dataset,['sourceHash','trainHash','holdoutHash','trainIds','holdoutIds']);if(a.schema.target!==a.spec.target)throw Error('Target changed.');requireHash(a.recipe);}else{parseMetalSpec(a.spec);if(!timestamp(a.at))throw Error('Invalid approval timestamp.');metalRuntime(a.runtime);}
  const features=provider==='cpu-regression'?a.schema.features:a.features,rows=[...train,...holdout],ids=new Set(),xs=new Set();
  if(!Array.isArray(features)||features.length<1||features.length>16||features.some(f=>typeof f!=='string'||!/^\w{1,64}$/u.test(f))||new Set(features).size!==features.length||rows.length<20||rows.length>(provider==='cpu-regression'?10000:2000))throw Error('Invalid regression schema.');
  for(const raw of rows){const r=object(raw,['id','x','y']);if(typeof r.id!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/u.test(r.id)||ids.has(r.id)||!Array.isArray(r.x)||r.x.length!==features.length||r.x.some(v=>!finite(v)||Math.abs(v)>1e6)||!finite(r.y)||Math.abs(r.y)>1e6||xs.has(fingerprint(r.x)))throw Error('Invalid or overlapping regression rows.');ids.add(r.id);xs.add(fingerprint(r.x));}
  const split=splitDataset({version:1,features,target:a.spec.target,rows},a.spec.seed);
  same(train,split.train,'Training split membership changed.');same(holdout,split.holdout,'Holdout split membership changed.');same(a.preprocessing,split.preprocessing,'Training preprocessing changed.');same(a.baseline,split.baseline,'Training baseline changed.');
  const data=provider==='cpu-regression'?a.dataset:a;for(const key of ['sourceHash','trainHash','holdoutHash'])requireHash(data[key]);if(fingerprint(train)!==data.trainHash||fingerprint(holdout)!==data.holdoutHash)throw Error('Protected split bytes changed.');
  if(provider==='cpu-regression'){same(a.dataset.trainIds,train.map(r=>r.id),'Train membership changed.');same(a.dataset.holdoutIds,holdout.map(r=>r.id),'Holdout membership changed.');let image:string|null=null;if(state.jobId){const j=await reader.json('jobs/'+state.jobId+'/state.json') as any;if(j?.image!==undefined){if(typeof j.image!=='string'||!/^sha256:[a-f0-9]{64}$/u.test(j.image))throw Error('Invalid retained CPU image.');image=j.image;}}runtime=fingerprint({image,recipe:a.recipe});}
  else runtime=fingerprint(a.runtime);
 }
 return {a,train,holdout,state,folder:dir,runtime};
}
function metalRuntime(raw:unknown):asserts raw is MetalRuntime{
 const r=object(raw,['profile','protocol','host']);requireHash(r.protocol);if(typeof r.host!=='string'||!/^darwin\/arm64\/[-.\w]+$/u.test(r.host))throw Error('Invalid Metal host identity.');
 const p=object(r.profile,['version','tart','tartHash','networkHash','cloneHash','image','files','identities','protocol','cpu','memoryMiB','os','arch']);
 if(p.version!==1||p.cpu!==2||p.memoryMiB!==4096||p.arch!=='arm64'||typeof p.tart!=='string'||!p.tart.startsWith('/')||typeof p.image!=='string'||!/^harness-macos-[a-z0-9-]+$/u.test(p.image)||typeof p.os!=='string'||!p.os||p.os.length>80)throw Error('Invalid Metal runtime.');for(const k of ['tartHash','networkHash','cloneHash','protocol'])requireHash(p[k]);for(const k of ['files','identities']){const v=object(p[k],['disk.img','nvram.bin','config.json']);if(Object.keys(v).length!==3)throw Error('Incomplete native image identity.');Object.values(v).forEach(requireHash);}
}
export async function mlChoices(project:string){
 const reader=new EvidenceReader(project+'-harness'),choices:{title:string;target:EvidenceTarget}[]=[];
 for(const provider of Object.keys(folders) as MlProvider[])for(const id of await reader.names(folders[provider])){if(id.startsWith('.'))continue;if(!uuidId(id,folders[provider]))throw Error('Unexpected ML workflow directory.');const d=await mlData(reader,provider,id);if(d.state.status==='released')continue;
  // CPU approval predates runtime pinning: do not invent an image before a job captures it.
  if(provider==='cpu-regression'&&(!d.state.jobId||!(await reader.json('jobs/'+d.state.jobId+'/state.json') as any)?.image))continue;
  choices.push({title:d.a.spec.title,target:{provider,approval:id,approvalDigest:d.a.digest,runtime:d.runtime}});
 }await reader.assertUnchanged();return choices;
}
export function mlBase(target:EvidenceTarget,aspect:string):EvidenceRecord{return {...target,version:1,id:`ml:${target.provider}:${target.approval}:${aspect}`,required:true,subject:{kind:'unresolved'},applicability:'missing',outcome:'unknown',artifacts:[],detail:'No complete selected model evidence.',limitations:['Host arithmetic uses the protected holdout; rows and labels are not published.','Dataset suitability, leakage beyond known checks and broader generalization require human assessment.'],next:`harness ${folders[target.provider as MlProvider]} list`};}
export async function mlEvidence(reader:EvidenceReader,target:EvidenceTarget,source:string){
 const rows=['quality','checkpoint','recovery','integration'].map(k=>mlBase(target,k)),[quality,checkpoint,recovery,integration]=rows as [EvidenceRecord,EvidenceRecord,EvidenceRecord,EvidenceRecord];
 integration.subject={kind:'application',digest:source};integration.detail='Model quality does not prove this application uses the selected model correctly. No source-and-model integration evidence is retained.';integration.next='harness checks setup';
 recovery.detail='No demonstrated interruption-to-checkpoint-to-resumed-model chain. A complete checkpoint alone is not recovery evidence.';
 try{
  const provider=target.provider as MlProvider,d=await mlData(reader,provider,target.approval),a=d.a;
  const protocol=provider==='cpu-regression'?await cpuRecipe():provider==='torch-cpu'?await torchRecipe():await metalProtocol();
  if(a.digest!==target.approvalDigest||d.runtime!==target.runtime||(provider==='metal-regression'?(a as MetalApproval).runtime.protocol:(a as MlApproval|TorchApproval).recipe)!==protocol){for(const r of rows.slice(0,3)){r.applicability='stale';r.detail='Selected data approval, recipe or runtime changed. Review product setup.';r.next='harness product setup';}return rows;}
  if(d.state.status==='released'){quality.applicability='unavailable';quality.detail='Selected model workflow has been retired.';return rows;}
  if(!['passed','failed'].includes(d.state.status)){quality.applicability='current';quality.outcome='incomplete';quality.detail=`Selected workflow is ${d.state.status}; no completed evaluation can be adopted.`;return rows;}
  if(provider==='metal-regression')await metalQuality(reader,d,quality,checkpoint,recovery);
  else {
   const j=await mlJob(reader,d,provider);quality.producer=j.id;quality.at=j.events.at(-1)!.at;
   const model=await jobModel(reader,j),cp=await jobCheckpoint(reader,j,j.checkpoint!);if(domainCheckpoint(cp.bytes,d,j).completed!==j.completed)throw Error('Checkpoint is not complete.');quality.artifacts.push(ref(model));checkpoint.artifacts.push(ref(cp));
   if(provider==='cpu-regression')await cpuQuality(reader,d,j,model,cp,quality);else await torchQuality(reader,d,j,model,cp,quality);
   checkpoint.subject=quality.subject;checkpoint.applicability='current';checkpoint.outcome='passed';checkpoint.detail=provider==='cpu-regression'?'Complete numeric model checkpoint matches the evaluated model.':'Model, optimizer/scheduler, RNG and sampler checkpoint matches the evaluated model; structural compatibility is distinct from successful recovery.';
   await recoveryEvidence(reader,d,j,quality,checkpoint,recovery);
  }
  if(quality.lineage)integration.lineage=quality.lineage;integration.subject={kind:'application',digest:source};
 }catch(e){quality.applicability='invalid';quality.outcome='unknown';quality.detail='ML evidence is invalid: '+safeError(e);for(const r of [checkpoint,recovery]){r.applicability='invalid';r.outcome='unknown';r.detail='Model evidence validation failed; dependent claims cannot pass.';}}
 return rows;
}
// Native/parser failures may include raw JSON excerpts. Never echo protected input or arbitrary exception text.
function safeError(e:unknown){const m=e instanceof Error?e.message:'';return /^(?:Invalid|Missing|ML |Training|Holdout|Protected|Selected|Model|Checkpoint|Evaluat|Retained|Job|Native|Metal|PyTorch|Artifact|Recovery|Complete|Duplicate|Fresh|Report|Approved|Unknown|Incomplete|Unexpected|The |A classifier|Recipe)/u.test(m)&&m.length<250&&!/[\r\n{}\[\]]/u.test(m)?m:'Retained records are missing, malformed, incompatible or changed.';}
export const ref=(v:Awaited<ReturnType<EvidenceReader['artifact']>>)=>({id:v.artifact.id,name:v.artifact.name,sha256:v.artifact.sha256});
async function cpuQuality(reader:EvidenceReader,d:MlData,j:any,m:Awaited<ReturnType<EvidenceReader['artifact']>>,cp:Awaited<ReturnType<EvidenceReader['artifact']>>,q:EvidenceRecord){
 const a=d.a as MlApproval,s=d.state,model=validateModel(JSON.parse(m.bytes.toString()),modelContext(a),a.spec.epochs);
 same(JSON.parse(cp.bytes.toString()).payload,model,'Checkpoint differs from evaluated model.');
 if(s.candidateHash!==m.artifact.sha256||s.report!==`evaluation-${s.candidateHash}.json`)throw Error('Model candidate changed.');
 const report=object(await reader.json(d.folder+'/'+s.report),['version','approval','modelHash','source','environment','image','recipe','trainHash','holdoutHash','trainRows','holdoutRows','at','outcome','assessment','reason','retryable']) as any;
 if(report.version!==1||!timestamp(report.at)||report.approval!==a.digest||report.modelHash!==s.candidateHash||report.source!==j.source.digest||report.environment!==j.identity||report.image!==j.image||report.recipe!==a.recipe||report.trainHash!==a.dataset.trainHash||report.holdoutHash!==a.dataset.holdoutHash||report.trainRows!==d.train.length||report.holdoutRows!==d.holdout.length||report.retryable===true)throw Error('Evaluation identity or completion changed.');
 const score=assessPredictions(d.holdout.map(r=>predict(model,r.x)),d.holdout.map(r=>r.y),a.baseline,a.spec);same(report.assessment,score,'Evaluation score changed.');if(report.outcome!==(score.passed?'passed':'failed')||s.status!==report.outcome)throw Error('Evaluation outcome changed.');
 if(score.passed){const exported=await reader.artifact(s.modelArtifact);if(exported.artifact.producer!==a.id||exported.artifact.input!==a.dataset.trainHash||exported.artifact.environment!==j.identity||exported.artifact.name!=='evaluated-model.json'||exported.artifact.sha256!==m.artifact.sha256||exported.artifact.verification!=='evaluation-passed'||exported.artifact.evaluation?.approval!==a.digest||exported.artifact.evaluation.reportHash!==fingerprint(report))throw Error('Evaluated model provenance changed.');q.artifacts.push(ref(exported));}
 q.subject={kind:'model',digest:m.artifact.sha256};q.applicability='current';q.outcome=score.passed?'passed':'failed';q.at=report.at;q.metrics=regressionMetrics(score,a.spec,d.holdout.length);q.detail=`Holdout RMSE ${score.rmse} (ceiling ${a.spec.maxRmse}); baseline ${score.baselineRmse}; ${d.holdout.length} held-out rows. Host numeric comparison ${q.outcome}.`;q.lineage={model:m.artifact.sha256,train:a.dataset.trainHash,holdout:a.dataset.holdoutHash,preprocessing:fingerprint(a.preprocessing),recipe:a.recipe,trainingSource:j.source.digest};
}
export function regressionMetrics(score:ReturnType<typeof assessPredictions>,spec:{maxRmse:number;minImprovement:number},samples:number){return [{name:'rmse',value:score.rmse,unit:'target units',threshold:spec.maxRmse,comparison:'at-most' as const,baseline:score.baselineRmse,samples},{name:'relative-improvement',value:score.relativeImprovement,unit:'fraction',threshold:spec.minImprovement,comparison:'at-least' as const,samples}];}
