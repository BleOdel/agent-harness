import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {applyConfigFile} from '../src/config.ts';import {init} from '../src/verbs/init.ts';import {approveTorch,readTorch,readTorchState,torchDirectory} from '../src/torch/store.ts';import {trainTorch,evaluateTorch,exportTorch,releaseTorch} from '../src/torch/workflow.ts';import {requestCancel} from '../src/jobs/controller.ts';import {artifactBytes} from '../src/artifacts/store.ts';import {readJob} from '../src/jobs/state.ts';
const enabled=!!process.env.HARNESS_TORCH_TEST_IMAGE;
const settings={version:1,title:'CPU classifier',kind:'classifier',seed:42,steps:100,learningRate:0.01,batchSize:8,clusters:2,maxError:0.15,limits:{timeoutSeconds:300,totalSeconds:1200,maxAttempts:4}};
async function fixture(action:(project:string,file:string,root:string)=>Promise<void>){applyConfigFile();const root=await mkdtemp(path.join(os.tmpdir(),'harness-torch-test-')),project=path.join(root,'model');await mkdir(project);try{await init(project,['--python']);const file=path.join(root,'data.json');await writeFile(file,JSON.stringify({features:['signal','noise'],rows:Array.from({length:100},(_,i)=>({id:`r${i}`,x:[i/25-2,Math.sin(i)],y:Number(i>=50)}))}));await action(project,file,root);}finally{await rm(root,{recursive:true,force:true});}}
test('PyTorch Docker: train, withheld evaluation, export, retirement and data identity',{skip:!enabled},async()=>fixture(async(project,file,root)=>{
 const a=await approveTorch(project,file,settings,process.env.HARNESS_TORCH_TEST_IMAGE!),j=await trainTorch(project,a.id);assert.equal(j.status,'succeeded',JSON.stringify(j.events));
 const result=await evaluateTorch(project,a.id);assert.equal(result.passed,true,JSON.stringify(result));assert.ok(result.error<0.15);
 await exportTorch(project,a.id,path.join(root,'model.json'));assert.equal(JSON.parse(await readFile(path.join(root,'model.json'),'utf8')).kind,'classifier');await assert.rejects(exportTorch(project,a.id,path.join(root,'model.json')));
 await releaseTorch(project,a.id);await assert.rejects(trainTorch(project,a.id),/finished/);
 const poor=await approveTorch(project,file,{...settings,steps:1,maxError:0},process.env.HARNESS_TORCH_TEST_IMAGE!);assert.equal((await trainTorch(project,poor.id)).status,'succeeded');assert.equal((await evaluateTorch(project,poor.id)).passed,false);await assert.rejects(exportTorch(project,poor.id,path.join(root,'bad.json')),/quality-passed/);
 const raw=JSON.parse(await readFile(file,'utf8'));raw.rows=raw.rows.map(({y,...r}:any)=>r);await writeFile(file,JSON.stringify(raw));const k=await approveTorch(project,file,{...settings,kind:'kmeans',steps:15,maxError:2},process.env.HARNESS_TORCH_TEST_IMAGE!);assert.equal((await trainTorch(project,k.id)).status,'succeeded');const kr=await evaluateTorch(project,k.id);assert.equal(kr.passed,true,JSON.stringify(kr));assert.equal(kr.metric,'mean-squared-distance');
}));
test('PyTorch Docker: cancellation restores full state; changed holdout is refused',{skip:!enabled},async()=>fixture(async(project,file)=>{
 const a=await approveTorch(project,file,{...settings,steps:2000},process.env.HARNESS_TORCH_TEST_IMAGE!);let cancellation:Promise<void>|undefined;
 const first=await trainTorch(project,a.id,message=>{if(message.includes('Saved compatible checkpoint')&&!cancellation)cancellation=(async()=>{const s=await readTorchState(project,a.id);await requestCancel(project,s.jobId!);})();});await cancellation;assert.equal(first.status,'cancelled',JSON.stringify(first.events));assert.ok(first.completed!>0&&first.completed!<2000);assert.ok(first.checkpoint);
 const cp=JSON.parse((await artifactBytes(project,first.checkpoint!)).toString());assert.ok(cp.payload.optimizer);assert.ok(cp.payload.scheduler);assert.equal(cp.payload.losses.length,first.completed);assert.equal(cp.payload.torchRng.length,5056);
 const dir=await torchDirectory(project,a.id),original=await readFile(dir+'/holdout.json');await writeFile(dir+'/holdout.json','[]');await assert.rejects(trainTorch(project,a.id),/data changed/);await writeFile(dir+'/holdout.json',original);
 const resumed=await trainTorch(project,a.id);assert.equal(resumed.status,'succeeded',JSON.stringify(resumed.events));assert.equal(resumed.attempts,2);assert.equal(resumed.completed,2000);
 assert.equal((await readJob(project,resumed.id)).container,undefined);assert.equal((await readTorch(project,a.id)).holdout.length,20);
}));
import {spawn} from 'node:child_process';import {writerPath,recoverWriter} from '../src/workspace/writer-lock.ts';import {recoverJob} from '../src/jobs/controller.ts';
test('PyTorch Docker: killed controller recovers owned resources and continues saved training',{skip:!enabled},async()=>fixture(async(project,file)=>{
 const a=await approveTorch(project,file,{...settings,steps:2000},process.env.HARNESS_TORCH_TEST_IMAGE!);
 const child=spawn(process.execPath,[path.resolve('src/cli.ts'),'torch','train',a.id],{env:{...process.env,HARNESS_PROJECT:project},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',v=>{output+=v});child.stderr.on('data',v=>{output+=v});const exited=new Promise(resolve=>child.once('exit',resolve));let saved:string|undefined;
 try{
  const deadline=Date.now()+90000;while(Date.now()<deadline){const s=await readTorchState(project,a.id);if(s.jobId){const j=await readJob(project,s.jobId);if(j.status==='running'&&j.checkpoint){saved=j.id;break;}}if(child.exitCode!==null)throw Error(output);await new Promise(r=>setTimeout(r,50));}
  assert.ok(saved,'No retained checkpoint before deadline: '+output);child.kill('SIGKILL');await exited;
  const owner=JSON.parse(await readFile(await writerPath(project),'utf8'));await recoverWriter(project,owner.token);const recovered=await recoverJob(project,saved!);assert.equal(recovered.status,'interrupted');assert.ok(recovered.checkpoint);assert.equal(recovered.container,undefined);
  const resumed=await trainTorch(project,a.id);assert.equal(resumed.status,'succeeded',JSON.stringify(resumed.events));assert.equal(resumed.attempts,2);assert.equal(resumed.completed,2000);
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
}));
