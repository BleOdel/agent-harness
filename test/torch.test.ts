import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTorchSpec,parseTorchData,splitTorchData,assessTorch,validateTorchCheckpoint} from '../src/torch/schema.ts';
const spec={version:1,title:'Classifier',kind:'classifier',steps:80,seed:42,learningRate:0.01,batchSize:8,clusters:2,maxError:0.2,limits:{timeoutSeconds:60,totalSeconds:240,maxAttempts:4}};
const rows=Array.from({length:40},(_,i)=>({id:`r${i}`,x:[i,i%3],y:i%2}));
test('PyTorch specifications reject unbounded work and unknown model code',()=>{
 assert.equal(parseTorchSpec(spec).kind,'classifier');
 for(const change of [{steps:10001},{kind:'custom'},{batchSize:0},{maxError:-1},{code:'exec'},{learningRate:NaN}])assert.throws(()=>parseTorchSpec({...spec,...change}));
});
test('split is stable, disjoint, normalized only on training and supports unlabeled rows',()=>{
 const data=parseTorchData({features:['a','b'],rows},'classifier'),split=splitTorchData(data,42);
 assert.deepEqual(split,splitTorchData(data,42));assert.equal(split.holdout.length,8);
 assert.equal(new Set([...split.train,...split.holdout].map(r=>r.id)).size,40);
 assert.equal(split.means[0],split.train.reduce((s,r)=>s+r.x[0]!,0)/32);
 assert.throws(()=>parseTorchData({features:['a','b'],rows:[...rows,rows[0]]},'classifier'));
 const unlabeled=rows.map(({y,...row})=>row);assert.equal(parseTorchData({features:['a','b'],rows:unlabeled},'kmeans').rows.length,40);
 assert.throws(()=>parseTorchData({features:['a','b'],rows:unlabeled},'classifier'));
});
test('quality is measured on held-out predictions, never training loss',()=>{
 assert.equal(assessTorch('classifier',[0,1],[0,1],0.1).passed,true);
 assert.equal(assessTorch('classifier',[1,0],[0,1],0.1).passed,false);
 assert.throws(()=>assessTorch('classifier',[0],[0,1],0.1));
 assert.throws(()=>assessTorch('kmeans',[NaN],[0],1));
});
test('incomplete optimizer or RNG checkpoints cannot claim complete recovery',()=>{
 assert.throws(()=>validateTorchCheckpoint({protocol:'torch-cpu@1',context:'x',completed:1,model:{}},'x',1,'classifier'));
});
import {validateTorchModel,predictTorch} from '../src/torch/schema.ts';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {approveTorch,readTorch,torchDirectory} from '../src/torch/store.ts';
import {torchRecipe,TORCH_COMMAND} from '../src/torch/recipe.ts';
import {parseJobSpec} from '../src/jobs/schema.ts';
test('model shapes and finite weights are checked before host inference',()=>{
 assert.throws(()=>validateTorchModel({version:1,kind:'classifier',context:'x',completed:10,weights:{},centers:null},2,2));
 const m={version:1,kind:'kmeans',context:'x',completed:10,weights:null,centers:[[0,0],[2,2]]};assert.deepEqual(validateTorchModel(m,2,2),m);assert.deepEqual(predictTorch(m,[{id:'a',x:[2,2]}],[0,0],[1,1]),[0]);assert.throws(()=>validateTorchModel({...m,centers:[[NaN,0],[2,2]]},2,2));
});
test('frozen data, helper identity and exact job recipe prevent resume drift',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'torch-store-')),project=root+'/project';await mkdir(project);await writeFile(project+'/pyproject.toml','[project]\nname="probe"\n');const file=root+'/data.json';await writeFile(file,JSON.stringify({features:['a','b'],rows}));
 try{const a=await approveTorch(project,file,spec,'sha256:'+'a'.repeat(64)),data=await readTorch(project,a.id);assert.equal(data.holdout.length,8);
 const job=parseJobSpec({version:1,title:a.spec.title,command:TORCH_COMMAND,outputs:['model.json'],recipe:{id:'torch-cpu',version:1,approvalId:a.id,approvalDigest:a.digest},checkpoint:{protocol:'json-step@1',total:a.spec.steps},limits:a.spec.limits});const recipe=await torchRecipe(project,job),work=root+'/work';await mkdir(work);await recipe.prepare(work);const prepared=JSON.parse(await readFile(work+'/.harness-torch-training.json','utf8'));assert.deepEqual(prepared.rows,data.train);assert.ok(!prepared.rows.some((r:any)=>data.holdout.some(h=>h.id===r.id)));
 await assert.rejects(torchRecipe(project,{...job,command:['python','project-code.py']}),/differs/);
 const d=await torchDirectory(project,a.id);await writeFile(d+'/holdout.json','[]');await assert.rejects(readTorch(project,a.id),/data changed/);
 }finally{await rm(root,{recursive:true,force:true});}
});
import {torchSetup} from '../src/guide/torch.ts';
test('guided PyTorch setup explains the budget and allows cancellation without approval',async()=>{
 const lines:string[]=[],answers=['0'];await torchSetup('/unused',{write:t=>lines.push(t),ask:async()=>answers.shift()!},async()=>({version:1,image:'sha256:'+'a'.repeat(64),docker:'docker',versions:{}}));
 assert.ok(lines.some(t=>t.includes('2 CPUs and 2 GiB')));assert.ok(lines.some(t=>t.includes('without labels')));assert.ok(!lines.some(t=>t.startsWith('Approved')));
});
