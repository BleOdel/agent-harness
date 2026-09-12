import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setupJob } from '../src/verbs/job.ts';
import { guideJobs } from '../src/guide/jobs.ts';
import { listJobs } from '../src/jobs/state.ts';
test('guided jobs save once and offer resume/status without copying IDs or editing JSON',async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'jobs-guide-'))),project=path.join(root,'project');await mkdir(project);
 try{
  const answers=['Count','node count.mjs','result.json','4','30','2','y'],messages:string[]=[];
  await setupJob(project,{write:s=>messages.push(s),ask:async()=>answers.shift()!});const jobs=await listJobs(project);assert.equal(jobs.length,1);assert.equal(jobs[0]!.spec.checkpoint?.total,4);assert.ok(messages.some(m=>m.includes('Compute cost unknown')));
  const choices=['1','2','0'],calls:string[][]=[];await guideJobs(project,{write:s=>messages.push(s),ask:async()=>choices.shift()!},async(_project,args)=>{calls.push([...args]);return 0;});assert.deepEqual(calls,[['job','run',jobs[0]!.id]]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('an unknown job does not poison the job list',async()=>{
 const {readJob}=await import('../src/jobs/state.ts');const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'jobs-unknown-'))),project=path.join(root,'project');await mkdir(project);
 try{await assert.rejects(readJob(project,'job-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),/Unknown job/);assert.deepEqual(await listJobs(project),[]);}finally{await rm(root,{recursive:true,force:true});}
});
