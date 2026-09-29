/** Explicit opt-in real training. Report collection itself never launches a worker. */
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,realpath,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {init} from '../src/verbs/init.ts';import {loadConfig} from '../src/config.ts';import {approveMl} from '../src/ml/store.ts';import {trainMl} from '../src/ml/workflow.ts';
import {approveTorch,readTorchState} from '../src/torch/store.ts';import {trainTorch,evaluateTorch} from '../src/torch/workflow.ts';import {readTorchRuntime} from '../src/torch/runtime.ts';
import {requestCancel} from '../src/jobs/controller.ts';import {collectEvidence} from '../src/product/evidence/desktop.ts';import {mlChoices} from '../src/product/evidence/ml.ts';import {csv,spec} from './ml-fixture.ts';
import {validateMetal} from '../src/metal/verify.ts';
const source='a'.repeat(64);
async function inspect(project:string,id:string,recovered:boolean){const choices=await mlChoices(project),scope={version:1 as const,targets:[choices.find(c=>c.target.approval===id)!.target]},result=await collectEvidence(project,source,scope);
 assert.equal(result.records[0]!.outcome,'passed',result.records[0]!.detail);assert.equal(result.records[1]!.outcome,'passed',result.records[1]!.detail);assert.equal(result.records[2]!.outcome,recovered?'passed':'unknown',result.records[2]!.detail);assert.equal(result.records[3]!.applicability,'missing');
 const artifact=result.records[0]!.artifacts[0]!,manifest=project+'-harness/artifacts/manifests/'+artifact.id+'.json',before=await readFile(manifest,'utf8');
 try{const changed=JSON.parse(before);changed.producer='substituted';await writeFile(manifest,JSON.stringify(changed));assert.notEqual((await collectEvidence(project,source,scope)).records[0]!.outcome,'passed');}finally{await writeFile(manifest,before);}
 assert.equal((await collectEvidence(project,'b'.repeat(64),scope)).records[0]!.outcome,'passed');return result;
}
test('real CPU/PyTorch: held-out quality, interruption recovery, compactness and substituted model rejection',{skip:!process.env.HARNESS_VERIFY_PRODUCT_ML,timeout:420000},async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'product-ml-live-')));let success=false;const previousAgent=process.env.HARNESS_AGENT_DIR;await mkdir(root+'/agent');process.env.HARNESS_AGENT_DIR=root+'/agent';
 try{
  const project=root+'/cpu';await mkdir(project);await init(project,['--python']);await writeFile(root+'/data.csv',csv(10000));const a=await approveMl(project,root+'/data.csv',{...spec,epochs:500,limits:{timeoutSeconds:120,totalSeconds:360,maxAttempts:3}});let cancel:Promise<void>|undefined;
  const config=loadConfig({...process.env,HARNESS_PROJECT:project,HARNESS_IMAGE_ID:process.env.HARNESS_PYTHON_IMAGE_ID});
  const first=await trainMl(project,a.id,m=>{console.log('CPU: '+m);if(m.includes('Saved compatible checkpoint')&&!cancel)cancel=(async()=>{const {readMlState}=await import('../src/ml/store.ts');await requestCancel(project,(await readMlState(project,a.id)).jobId!);})();},config);await cancel;assert.equal(first.job.status,'cancelled');assert.ok(first.job.completed!<500);assert.equal((await trainMl(project,a.id,console.log,config)).evaluation?.outcome,'passed');await inspect(project,a.id,true);
  const runtime=await readTorchRuntime();
  for(const kind of ['classifier','kmeans'] as const){const p=root+'/'+kind;await mkdir(p);await init(p,['--python']);const file=root+'/'+kind+'.json';await writeFile(file,JSON.stringify({features:['signal','noise'],rows:Array.from({length:100},(_,i)=>({id:'r'+i,x:[i/25-2,Math.sin(i)],...(kind==='classifier'?{y:Number(i>=50)}:{})}))}));const a=await approveTorch(p,file,{version:1,title:'Product '+kind,kind,seed:42,steps:kind==='classifier'?2000:15,learningRate:0.01,batchSize:8,clusters:2,maxError:kind==='classifier'?0.15:2,limits:{timeoutSeconds:120,totalSeconds:360,maxAttempts:3}},runtime.image);
   let cancel:Promise<void>|undefined;const first=await trainTorch(p,a.id,m=>{console.log(kind+': '+m);if(kind==='classifier'&&m.includes('Saved compatible checkpoint')&&!cancel)cancel=(async()=>requestCancel(p,(await readTorchState(p,a.id)).jobId!))();});await cancel;
   if(kind==='classifier'){assert.equal(first.status,'cancelled');assert.ok(first.completed!<2000);assert.equal((await trainTorch(p,a.id,console.log)).status,'succeeded');}else assert.equal(first.status,'succeeded');
   assert.equal((await evaluateTorch(p,a.id)).passed,true);await inspect(p,a.id,kind==='classifier');
  }success=true;
 }finally{if(previousAgent===undefined)delete process.env.HARNESS_AGENT_DIR;else process.env.HARNESS_AGENT_DIR=previousAgent;if(success)await rm(root,{recursive:true,force:true});else console.log('Retained ML trial: '+root);}
});
test('real Metal: native interruption recovery and host quality aggregation',{skip:!process.env.HARNESS_VERIFY_PRODUCT_METAL,timeout:900000},async()=>{
 const r=await validateMetal(console.log);await inspect(r.continuous.project,r.continuous.id,false);await inspect(r.resumed.project,r.resumed.id,true);
});
