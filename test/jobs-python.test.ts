import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { init } from '../src/verbs/init.ts';
import { createJob } from '../src/jobs/state.ts';
import { runJob } from '../src/jobs/controller.ts';
import { artifactBytes, listArtifacts } from '../src/artifacts/store.ts';
import { withWriter } from '../src/workspace/writer-lock.ts';
import { loadConfig } from '../src/config.ts';
import { verify } from '../src/verbs/verify.ts';
const options={skip:process.env.HARNESS_PYTHON_IMAGE_ID&&process.env.HARNESS_DOCKER?false:'configure Python Docker job runner'};
test('Python job uses fresh installed package; verify retains a reproducible wheel with diagnostic provenance',options,async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'jobs-python-'))),project=path.join(root,'analysis');await mkdir(project);
 const previous=process.env.HARNESS_IMAGE_ID;process.env.HARNESS_IMAGE_ID=process.env.HARNESS_PYTHON_IMAGE_ID!;
 try{
  await init(project,['--python']);await writeFile(path.join(project,'job.py'),`import json,os,analysis\nassert '/.venv/' in analysis.__file__\nwith open(os.environ['HARNESS_JOB_OUTPUT']+'/report.json','w') as f: json.dump({'words':3},f)\n`);
  const j=await withWriter(project,'test',()=>createJob(project,{version:1,title:'Python analysis',command:['python','job.py'],outputs:['report.json'],limits:{timeoutSeconds:20,totalSeconds:20,maxAttempts:1}}));
  const result=await runJob(project,j.id,()=>{},loadConfig({...process.env,HARNESS_PROJECT:project}));assert.equal(result.status,'succeeded',JSON.stringify(result.events));
  let artifacts=await listArtifacts(project);const report=artifacts.find(a=>a.name==='report.json')!;assert.deepEqual(JSON.parse((await artifactBytes(project,report.id)).toString()),{words:3});assert.equal(report.verification,'unverified');
  await verify(project,['--retain']);artifacts=await listArtifacts(project);const wheel=artifacts.find(a=>a.name.endsWith('.whl'))!;assert.ok(wheel);assert.equal(wheel.verification,'diagnostics-passed');assert.equal((await artifactBytes(project,wheel.id)).subarray(0,2).toString(),'PK');
  const source=await readFile(path.join(project,'job.py'),'utf8');assert.match(source,/analysis/);
 }finally{if(previous===undefined)delete process.env.HARNESS_IMAGE_ID;else process.env.HARNESS_IMAGE_ID=previous;await rm(root,{recursive:true,force:true});}
});
