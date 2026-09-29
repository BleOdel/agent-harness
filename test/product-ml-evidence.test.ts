import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {collectEvidence} from '../src/product/evidence/desktop.ts';import {mlChoices} from '../src/product/evidence/ml.ts';
import {fingerprint,splitDataset,assessPredictions,predict} from '../src/ml/schema.ts';import {recipeHash,modelContext} from '../src/ml/store.ts';
import {saveJson,putArtifact,sha256} from '../src/artifacts/store.ts';import {createJob,saveJob} from '../src/jobs/state.ts';import {TRAIN_COMMAND} from '../src/ml/recipe.ts';
import {draftProduct,approveProduct} from '../src/product/spec.ts';
const id='ml-11111111-1111-4111-8111-111111111111',source='a'.repeat(64),image='sha256:'+'b'.repeat(64);
async function fixture(fn:(f:any)=>Promise<void>){const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'ml-evidence-unit-'))),p=root+'/app';await mkdir(p);await writeFile(p+'/features.json',JSON.stringify([{id:'model',title:'Model',priority:'must',status:'done',criteria:['Evaluate'],dependsOn:[]} ]));
 try{
 const spec={version:1,title:'Synthetic regression fixture',target:'y',seed:42,epochs:10,learningRate:0.05,maxRmse:0.01,minImprovement:0.9,limits:{timeoutSeconds:60,totalSeconds:120,maxAttempts:2}};
 const data={version:1 as const,features:['x'],target:'y',rows:Array.from({length:20},(_,i)=>({id:'row'+i,x:[i],y:2*i+3}))},split=splitDataset(data,42);
 const body={version:1 as const,id,approvedAt:new Date().toISOString(),spec,schema:{features:['x'],target:'y'},dataset:{sourceHash:source,trainHash:fingerprint(split.train),holdoutHash:fingerprint(split.holdout),trainIds:split.train.map(r=>r.id),holdoutIds:split.holdout.map(r=>r.id)},preprocessing:split.preprocessing,baseline:split.baseline,recipe:await recipeHash()},a={...body,digest:fingerprint(body)};
 const dir=p+'-harness/ml/'+id;await mkdir(dir,{recursive:true});await saveJson(dir,'approved.json',a);await saveJson(dir,'train.json',split.train);await saveJson(dir,'holdout.json',split.holdout);
 const job=await createJob(p,{version:1,title:spec.title,command:TRAIN_COMMAND,outputs:['model.json'],checkpoint:{protocol:'json-step@1',total:10},limits:spec.limits,recipe:{id:'linear-regression',version:1,approvalId:id,approvalDigest:a.digest}});
 Object.assign(job,{status:'succeeded',attempts:1,reservedSeconds:60,source:{directory:p+'-harness/jobs/'+job.id+'/source',digest:source,files:{},exclusions:[]},image,profile:{},capabilities:{},environment:source,installPolicy:{}});
 job.identity=fingerprint({version:1,protocol:'json-step@1',spec:job.specDigest,source,profile:job.profile,capabilities:job.capabilities,environment:job.environment,policy:job.installPolicy});
 const model={...modelContext(a as any),version:1,kind:'linear-regression@1',completed:10,weights:[2*split.preprocessing.scales[0]!],bias:3+2*split.preprocessing.means[0]!};
 const artifact=await putArtifact(p,'model.json',Buffer.from(JSON.stringify(model)),{producer:job.id,input:source,environment:job.identity,verification:'unverified'});
 const cp=await putArtifact(p,'checkpoint.json',Buffer.from(JSON.stringify({version:1,protocol:'json-step@1',identity:job.identity,completed:10,total:10,payload:model})),{producer:job.id,input:source,environment:job.identity,verification:'unverified'});job.artifacts=[artifact.id];job.checkpoint=cp.id;job.completed=10;await saveJob(p,job,'succeeded','Fixture complete');
 const assessment=assessPredictions(split.holdout.map(r=>predict(model as any,r.x)),split.holdout.map(r=>r.y),a.baseline,spec);
 const report={version:1,approval:a.digest,modelHash:artifact.sha256,source,environment:job.identity,image,recipe:a.recipe,trainHash:a.dataset.trainHash,holdoutHash:a.dataset.holdoutHash,trainRows:16,holdoutRows:4,at:new Date().toISOString(),outcome:'passed',assessment};
 const evaluated=await putArtifact(p,'evaluated-model.json',Buffer.from(JSON.stringify(model)),{producer:id,input:a.dataset.trainHash,environment:job.identity,verification:'evaluation-passed',evaluation:{approval:a.digest,reportHash:fingerprint(report)}});
 const state={version:1,id,jobId:job.id,status:'passed',candidateHash:artifact.sha256,report:'evaluation-'+artifact.sha256+'.json',modelArtifact:evaluated.id};await saveJson(dir,state.report,report);await saveJson(dir,'state.json',state);
 const scope={version:1 as const,targets:[(await mlChoices(p))[0]!.target]};await fn({p,dir,a,job,model,report,state,scope,split,cp,artifact});
 }finally{await rm(root,{recursive:true,force:true});}}
test('CPU fixture: host recomputes selected quality, separates recovery and integration, and reveals no protected rows',async()=>fixture(async({p,scope})=>{
 const r=await collectEvidence(p,source,scope);assert.equal(r.records.length,4);assert.equal(r.records[0]!.outcome,'passed',r.records[0]!.detail);assert.equal(r.records[1]!.outcome,'passed');assert.equal(r.records[2]!.applicability,'missing');assert.equal(r.records[3]!.applicability,'missing');assert.equal(r.records[0]!.metrics![0]!.samples,4);assert.ok(!JSON.stringify(r).includes('row19'));
 const changed=await collectEvidence(p,'c'.repeat(64),scope);assert.deepEqual(changed.records[0],r.records[0]);assert.notDeepEqual(changed.records[3],r.records[3]);
 await approveProduct(p,await draftProduct(p,'ml','prototype',[],scope));
}));
for(const fault of ['score','split','checkpoint','producer','model','recipe','state','report-time'])test('CPU fixture refuses '+fault,async()=>fixture(async f=>{
 if(fault==='score'){f.report.assessment.rmse=123;await saveJson(f.dir,f.state.report,f.report);}
 if(fault==='split')await saveJson(f.dir,'holdout.json',[]);
 if(fault==='checkpoint')await rm(f.p+'-harness/artifacts/manifests/'+f.cp.id+'.json');
 if(fault==='producer'){f.artifact.producer=id;await saveJson(f.p+'-harness/artifacts/manifests',f.artifact.id+'.json',f.artifact);}
 if(fault==='model')await writeFile(f.p+'-harness/artifacts/blobs/'+f.artifact.sha256,'{}');
 if(fault==='recipe'){f.a.recipe='0'.repeat(64);const {digest,...body}=f.a;f.a.digest=fingerprint(body);await saveJson(f.dir,'approved.json',f.a);}
 if(fault==='state'){f.state.extra=true;await saveJson(f.dir,'state.json',f.state);}
 if(fault==='report-time'){f.report.at='invalid';await saveJson(f.dir,f.state.report,f.report);}
 const r=await collectEvidence(f.p,source,f.scope);assert.notEqual(r.records[0]!.outcome,'passed');
}));
test('CPU fixture: released/active workflow cannot reuse previous quality, and changed files invalidate read consistency',async()=>fixture(async f=>{
 const before=await collectEvidence(f.p,source,f.scope);f.state.status='training';await saveJson(f.dir,'state.json',f.state);await assert.rejects(before.assertUnchanged());assert.notEqual((await collectEvidence(f.p,source,f.scope)).records[0]!.outcome,'passed');
 f.state.status='released';await saveJson(f.dir,'state.json',f.state);assert.notEqual((await collectEvidence(f.p,source,f.scope)).records[0]!.outcome,'passed');
}));
import {beginRecoveryEvidence,updateRecoveryEvidence} from '../src/jobs/recovery-evidence.ts';
test('CPU fixture: recovery needs a stopped attempt, exact resumed checkpoint, advancement and evaluated final output',async()=>fixture(async f=>{
 const j=f.job,final=j.checkpoint,partial={...f.model,completed:4};const cp=await putArtifact(f.p,'checkpoint.json',Buffer.from(JSON.stringify({version:1,protocol:'json-step@1',identity:j.identity,completed:4,total:10,payload:partial})),{producer:j.id,input:source,environment:j.identity,verification:'unverified'});
 j.completed=0;delete j.checkpoint;j.status='running';await beginRecoveryEvidence(f.p,j);await updateRecoveryEvidence(f.p,j,true,false);j.completed=4;j.checkpoint=cp.id;j.status='cancelled';await updateRecoveryEvidence(f.p,j,false,true);
 j.attempts=2;j.reservedSeconds=120;j.status='running';await beginRecoveryEvidence(f.p,j);await updateRecoveryEvidence(f.p,j,true,false);j.completed=10;j.checkpoint=final;j.status='succeeded';await updateRecoveryEvidence(f.p,j,false,true);await saveJob(f.p,j,'succeeded','Recovered fixture');
 const r=await collectEvidence(f.p,source,f.scope);assert.equal(r.records[2]!.outcome,'passed',r.records[0]!.detail+' / '+r.records[2]!.detail);
 const filename=f.p+'-harness/jobs/'+j.id+'/recovery/attempt-2.json';const raw=JSON.parse(await (await import('node:fs/promises')).readFile(filename,'utf8'));raw.input=final;const {digest,...b}=raw;raw.digest=fingerprint(b);await writeFile(filename,JSON.stringify(raw));
 assert.notEqual((await collectEvidence(f.p,source,f.scope)).records[2]!.outcome,'passed');
}));
import {productSetup} from '../src/verbs/product.ts';import {readProduct} from '../src/product/spec.ts';
test('ML setup lets the operator select saved workflows and retain that selection without training',async()=>fixture(async f=>{
 const answers=['5','1','','1','y'],lines:string[]=[];await productSetup(f.p,{ask:async()=>answers.shift()!,write:s=>lines.push(s)});assert.deepEqual((await readProduct(f.p))?.evidence,f.scope);assert.ok(lines.some(l=>l.includes('Quality, checkpoints')));
 const keep=['5','1','','','y'];await productSetup(f.p,{ask:async()=>keep.shift()!,write:()=>{}});assert.deepEqual((await readProduct(f.p))?.evidence,f.scope);
 f.scope.targets[0].runtime='0'.repeat(64);await assert.rejects(approveProduct(f.p,await draftProduct(f.p,'ml','prototype',[],f.scope)),/changed during preview/);
}));
