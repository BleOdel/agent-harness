import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { init } from '../src/verbs/init.ts';
import { approveMl, assertNoProtectedSource, loadCsv, mlDirectory, readMl } from '../src/ml/store.ts';
import { checkedPredictions } from '../src/ml/evaluation.ts';
import { type LinearModel } from '../src/ml/schema.ts';
import { csv, spec } from './ml-fixture.ts';
test('ML approval freezes external data, catches known source copies and refuses changed data or preview',async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'ml-store-'))),project=path.join(root,'model');await mkdir(project);
 try{
  await init(project,['--python']);const file=path.join(root,'data.csv');await writeFile(file,csv());
  await writeFile(path.join(project,'data.csv'),csv());await assert.rejects(approveMl(project,file,spec),/copied/);await assert.rejects(loadCsv(project,path.join(project,'data.csv'),'target'),/outside/);await rm(path.join(project,'data.csv'));
  await assert.rejects(approveMl(project,file,spec,'0'.repeat(64)),/preview/);
  const a=await approveMl(project,file,spec),data=await readMl(project,a.id),dir=await mlDirectory(project,a.id);
  assert.equal(data.train.length,80);assert.equal(data.holdout.length,20);assert.ok(data.train.every(t=>data.holdout.every(h=>h.id!==t.id)));
  await rm(file);assert.deepEqual((await readMl(project,a.id)).train,data.train);
  await writeFile(path.join(project,'leaked.json'),JSON.stringify(data.holdout.slice(0,1)));await assert.rejects(assertNoProtectedSource(project,data),/holdout/);await rm(path.join(project,'leaked.json'));
  await writeFile(path.join(project,'leaked.csv'),'id,x,target\n'+data.holdout.slice(0,1).map(r=>`${r.id},${r.x[0]},${r.y}`).join('\n'));await assert.rejects(assertNoProtectedSource(project,data),/holdout/);await rm(path.join(project,'leaked.csv'));
  for(const name of ['train.json','holdout.json','approved.json']){
   const saved=await readFile(path.join(dir,name));const altered=JSON.parse(saved.toString());if(Array.isArray(altered))altered[0].y+=1;else altered.spec.maxRmse=100;
   await writeFile(path.join(dir,name),JSON.stringify(altered));await assert.rejects(readMl(project,a.id),/changed/);await writeFile(path.join(dir,name),saved);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
test('host rejects forged prediction metrics and values even when the inference report claims success',()=>{
 const model:LinearModel={version:1,kind:'linear-regression@1',approval:'a'.repeat(64),features:['x'],target:'target',preprocessing:{means:[0],scales:[1]},training:{seed:42,epochs:1,learningRate:0.05},completed:1,weights:[2],bias:3};
 assert.deepEqual(checkedPredictions({version:1,predictions:[5,7]},model,[[1],[2]]),[5,7]);
 assert.throws(()=>checkedPredictions({version:1,predictions:[5,7],rmse:0,passed:true},model,[[1],[2]]));
 assert.throws(()=>checkedPredictions({version:1,predictions:[5,8]},model,[[1],[2]]),/disagree/);
 assert.throws(()=>checkedPredictions({version:1,predictions:[null,7]},model,[[1],[2]]),/disagree/);
});
