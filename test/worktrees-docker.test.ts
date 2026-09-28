import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {applyConfigFile} from '../src/config.ts';
import {approveChecks} from '../src/acceptance/checks.ts';
import {appendRun} from '../src/record/record.ts';
import {createWorktree,commitWorktree,mergeWorktree,verifyCombined,checkedGit} from '../src/worktrees/controller.ts';
test('Docker integration checks the combined branch and refuses a regression missed by project tests',{skip:process.env.HARNESS_VERIFY_WORKTREES!=='1'},async()=>{
 applyConfigFile();const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'worktree-docker-'))),project=path.join(root,'app');await mkdir(path.join(project,'test'),{recursive:true});
 try{
  await checkedGit(project,['init','-b','main']);await checkedGit(project,['config','user.name','Harness fixture']);await checkedGit(project,['config','user.email','test@example.invalid']);
  await writeFile(path.join(project,'package.json'),JSON.stringify({name:'worktree-fixture',version:'1.0.0',type:'module',scripts:{test:'node --test test/*.test.js'}}));
  await writeFile(path.join(project,'features.json'),JSON.stringify([{id:'story',title:'Story',priority:'must',status:'todo',criteria:['Prints story'],dependsOn:[]}]));
  await writeFile(path.join(project,'test/app.test.js'),'import test from "node:test";import assert from "node:assert/strict";import fs from "node:fs";test("entry exists",()=>assert.ok(fs.readFileSync("app.js","utf8").length>0));\n');
  await writeFile(path.join(project,'app.js'),'console.log("old");\n');await writeFile(path.join(project,'message.txt'),'story');
  await checkedGit(project,['add','.']);await checkedGit(project,['commit','-m','Fixture']);
  const file=path.join(root,'checks.json');await writeFile(file,JSON.stringify({version:1,cases:[{id:'output',tasks:['story'],steps:[{command:['node','app.js'],exitCode:0,stdout:'story\n'}]}]}));await approveChecks(project,file);
  const w=await createWorktree(project,'story');
  await writeFile(path.join(w.checkout,'app.js'),'import fs from "node:fs";console.log(fs.readFileSync("message.txt","utf8"));\n');
  const tasks=JSON.parse(await readFile(path.join(w.checkout,'features.json'),'utf8'));tasks[0].status='done';await writeFile(path.join(w.checkout,'features.json'),JSON.stringify(tasks));
  await verifyCombined(w.checkout);
  const evidenceRoot=w.checkout+'-harness/acceptance/results',files=await readdir(evidenceRoot),e=JSON.parse(await readFile(path.join(evidenceRoot,files[0]!),'utf8'));
  // Simulate the earlier read-only review in this deterministic fixture; no provider request.
  await appendRun(w.checkout,{id:'r1',at:new Date().toISOString(),project:w.checkout,goal:'story',attempts:1,outcome:'applied',gates:['real Docker diagnostics passed'],review:{verdict:'pass',findings:[]},changes:[],candidateDigest:e.candidateDigest,acceptance:{approvalDigest:e.approvalDigest,candidateDigest:e.candidateDigest,evidencePath:e.evidencePath}});
  await commitWorktree(project,w.id);
  await writeFile(path.join(project,'message.txt'),'broken');await checkedGit(project,['add','message.txt']);await checkedGit(project,['commit','-m','Concurrent regression']);const before=await checkedGit(project,['rev-parse','HEAD']);
  await assert.rejects(()=>mergeWorktree(project,w.id),/output|stdout/i);
  assert.equal(await checkedGit(project,['rev-parse','HEAD']),before);assert.equal(await readFile(path.join(project,'app.js'),'utf8'),'console.log("old");\n');
  await writeFile(path.join(project,'message.txt'),'story');await checkedGit(project,['add','message.txt']);await checkedGit(project,['commit','-m','Correct concurrent input']);
  assert.equal((await mergeWorktree(project,w.id)).status,'merged');assert.equal(await checkedGit(project,['status','--porcelain']),'');
 }finally{await rm(root,{recursive:true,force:true});}
});
