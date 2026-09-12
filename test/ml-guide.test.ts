import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, realpath, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setupMl } from '../src/verbs/ml.ts';
import { guideMl } from '../src/guide/ml.ts';
import { init } from '../src/verbs/init.ts';
import { listMl, modelContext, readMlState, saveMlState } from '../src/ml/store.ts';
import { jobRecipe } from '../src/ml/recipe.ts';
import { trainingJob } from '../src/ml/workflow.ts';
import { csv } from './ml-fixture.ts';
test('guided ML previews the concrete data/threshold contract and continues a saved approval without copied IDs',async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'ml-guide-'))),project=path.join(root,'model');await mkdir(project);
 try{
  await init(project,['--python']);const file=path.join(root,'data.csv');await writeFile(file,csv());
  const answers=[file,'','Predict target','0.01','90','n','y'],messages:string[]=[];
  await setupMl(project,{write:s=>messages.push(s),ask:async()=>answers.shift()!});const approvals=await listMl(project);assert.equal(approvals.length,1);const a=approvals[0]!;
  assert.equal(a.spec.maxRmse,0.01);assert.equal(a.spec.minImprovement,0.9);assert.ok(messages.some(m=>m.includes('fixed seeded 80/20 split')));assert.ok(messages.some(m=>m.includes('not publication')));
  const choices=['1','2','0'],calls:string[][]=[];await guideMl(project,{write:s=>messages.push(s),ask:async()=>choices.shift()!},async(_project,args)=>{calls.push([...args]);return 0;});assert.deepEqual(calls,[['ml','train',a.id]]);
  const job=await trainingJob(project,a.id),recipe=(await jobRecipe(project,job.spec))!;
  const payload={version:1 as const,kind:'linear-regression@1' as const,...modelContext(a),completed:1,weights:[0],bias:0},point={version:1 as const,protocol:'json-step@1' as const,identity:'a'.repeat(64),completed:1,total:200,payload};
  const work=path.join(root,'prepared');await mkdir(work);const victim=path.join(root,'outside.txt');await writeFile(victim,'unchanged');await symlink(victim,path.join(work,'.harness-ml-training.json'));
  await assert.rejects(recipe.prepare(work),/link/);assert.equal(await readFile(victim,'utf8'),'unchanged');await rm(path.join(work,'.harness-ml-training.json'));
  await recipe.prepare(work);const injected=JSON.parse(await readFile(path.join(work,'.harness-ml-training.json'),'utf8'));assert.equal(injected.rows.length,80);assert.ok(injected.rows.every((r:{id:string})=>!a.dataset.holdoutIds.includes(r.id)));
  recipe.validate(point);assert.throws(()=>recipe.validate({...point,payload:{...payload,preprocessing:{means:[0],scales:[1]}}}),/preprocessing/);assert.throws(()=>recipe.validate({...point,payload:{...payload,completed:2}}),/epoch/);
  await assert.rejects(jobRecipe(project,{...job.spec,command:['python','arbitrary.py']}),/approved command/);
  await saveMlState(project,{...await readMlState(project,a.id),status:'released'});await assert.rejects(jobRecipe(project,job.spec),/retired/);
 }finally{await rm(root,{recursive:true,force:true});}
});
