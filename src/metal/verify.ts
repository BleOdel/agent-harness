import {mkdir,writeFile,readFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';import {spawn} from 'node:child_process';import assert from 'node:assert/strict';
import {nativeRoot} from '../native/provision.ts';import {listNativeRuns} from '../native/store.ts';import {readNativeSlot} from '../native/active.ts';
import {saveJson,sha256} from '../artifacts/store.ts';import {withWriter} from '../workspace/writer-lock.ts';
import {readMetalRuntime} from './runtime.ts';import {approveMetal,readMetalState,metalDirectory} from './store.ts';import {trainMetal,recoverMetal,evaluateMetal,type Engine} from './workflow.ts';import {runSegment,recoverSegment,candidatePath} from './engine.ts';
import {validateCheckpoint} from './schema.ts';import {assessPredictions} from '../ml/schema.ts';
export async function validateMetal(notify:(s:string)=>void=()=>{}){
 const runtime=await readMetalRuntime(false),root=nativeRoot+'/metal-validation/'+randomUUID();await mkdir(root,{recursive:true});
 const csv='id,x,y\n'+Array.from({length:40},(_,i)=>{const x=(i-20)/10;return `r${i},${x},${3+2*x}`;}).join('\n');await writeFile(root+'/data.csv',csv,{mode:0o600});
 const spec={version:1,title:'Metal recovery fixture',target:'y',seed:42,epochs:100,learningRate:0.05,maxRmse:0.002,minImprovement:0.99,checkpointEvery:100,limits:{timeoutSeconds:300,totalSeconds:1200,maxAttempts:4}};
 const engine:Engine={runtime:()=>readMetalRuntime(false),run:runSegment,recover:recoverSegment};
 const continuous=root+'/continuous',resumed=root+'/resumed';await mkdir(continuous);await mkdir(resumed);
 const a=await approveMetal(continuous,root+'/data.csv',spec,runtime);notify('Training 100 uninterrupted epochs on Metal.');await trainMetal(continuous,a.id,notify,false,engine);const complete=await readMetalState(continuous,a.id);const evaluation=await evaluateMetal(continuous,a.id);assert.ok(evaluation.passed,'GPU model failed independent holdout evaluation');
 const b=await approveMetal(resumed,root+'/data.csv',{...spec,checkpointEvery:50},runtime);notify('Saving a real 50-epoch GPU checkpoint.');await trainMetal(resumed,b.id,notify,true,engine);const checkpoint=(await readMetalState(resumed,b.id)).checkpoint!;
 notify('Interrupting the next VM segment to verify controller-crash recovery.');
 const script=`import {trainMetal} from ${JSON.stringify(new URL('./workflow.ts',import.meta.url).href)};import {readMetalRuntime} from ${JSON.stringify(new URL('./runtime.ts',import.meta.url).href)};import {runSegment,recoverSegment} from ${JSON.stringify(new URL('./engine.ts',import.meta.url).href)};await trainMetal(${JSON.stringify(resumed)},${JSON.stringify(b.id)},console.log,false,{runtime:()=>readMetalRuntime(false),run:runSegment,recover:recoverSegment});`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-2000);});const ended=new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.once('error',()=>resolve());});
 try{
  const deadline=Date.now()+90000;let active=false;
  while(Date.now()<deadline&&child.exitCode===null&&child.signalCode===null){const candidate=await candidatePath(resumed,b.id,2);const runs=await listNativeRuns(candidate);if(runs.some(r=>r.status==='running')){active=true;break;}await new Promise(r=>setTimeout(r,500));}
  assert.ok(active,'Interrupted fixture never started its VM: '+stderr);
 }finally{child.kill('SIGKILL');await ended;}
 await recoverMetal(resumed,b.id,engine);const recovered=await readMetalState(resumed,b.id);assert.equal(recovered.checkpointHash,sha256(JSON.stringify(checkpoint)));assert.equal(recovered.attempts[1]?.status,'interrupted');assert.equal(await readNativeSlot(nativeRoot),null);
 notify('Resuming from epoch 50 in a fresh VM.');await trainMetal(resumed,b.id,notify,false,engine);const done=await readMetalState(resumed,b.id);const result=await evaluateMetal(resumed,b.id);assert.ok(result.passed);
 const v=complete.checkpoint!.model,w=done.checkpoint!.model;for(const [i,weight]of v.weights.entries())assert.ok(Math.abs(weight-w.weights[i]!)<1e-5);assert.ok(Math.abs(v.bias-w.bias)<1e-5);
 assert.throws(()=>validateCheckpoint({...done.checkpoint,binding:a.digest},b,50,100),/checkpoint/);
 const dir=await metalDirectory(resumed,b.id),state=await readFile(dir+'/state.json','utf8');try{const corrupt=JSON.parse(state);corrupt.checkpoint.model.weights[0]+=1;await writeFile(dir+'/state.json',JSON.stringify(corrupt));await assert.rejects(readMetalState(resumed,b.id),/corrupt/);}finally{await writeFile(dir+'/state.json',state);}
 assert.equal(assessPredictions([0,0],[1,2],1.5,{maxRmse:0.001,minImprovement:0.9}).passed,false);assert.equal(await readNativeSlot(nativeRoot),null);
 const receipt={version:1,at:new Date().toISOString(),runtime:sha256(JSON.stringify(runtime)),device:done.checkpoint!.device,continuous:{project:continuous,id:a.id,rmse:evaluation.rmse},resumed:{project:resumed,id:b.id,rmse:result.rmse},observed:['Metal dispatches completed','holdout accuracy','checkpoint saved at epoch 50','active VM controller killed and owned resources recovered','resumed equals uninterrupted within 0.00001','corrupt and wrong-approval checkpoints rejected','failed quality rejected'],limitations:['fixed float32 numeric linear regression only','completed segment recovery; in-flight epochs rerun','no performance benchmark or exclusive GPU allocation']};
 await withWriter(nativeRoot,'Metal validation receipt',async()=>{assert.deepEqual(await readMetalRuntime(false),runtime);await saveJson(nativeRoot,'metal-boundary.json',receipt);});notify('Metal training and interruption recovery validated. Next: harness metal setup.');return receipt;
}
