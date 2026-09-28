import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {createWorktree,listWorktrees,commitWorktree,mergeWorktree,removeWorktree,recoverWorktree,checkedGit} from '../src/worktrees/controller.ts';
import {approveChecks} from '../src/acceptance/checks.ts';
import {captureBaseline} from '../src/workspace/candidate.ts';
import {appendRun} from '../src/record/record.ts';
import {sha256} from '../src/artifacts/store.ts';
import {acquireWriter} from '../src/workspace/writer-lock.ts';
async function fixture(t:any){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'worktree-test-'))),project=path.join(root,'app');await mkdir(project);t.after(()=>rm(root,{recursive:true,force:true}));
 await checkedGit(project,['init','-b','main']);await checkedGit(project,['config','user.name','Harness test']);await checkedGit(project,['config','user.email','test@example.invalid']);
 await writeFile(path.join(project,'package.json'),JSON.stringify({name:'fixture',type:'module',scripts:{test:'node --test test/*.test.js'}}));
 await writeFile(path.join(project,'app.js'),'console.log("old");\n');
 await writeFile(path.join(project,'features.json'),JSON.stringify([{id:'story',title:'Story',priority:'must',status:'todo',criteria:['Prints story'],dependsOn:[]}]));
 await checkedGit(project,['add','.']);await checkedGit(project,['commit','-m','Fixture']);
 const file=path.join(root,'checks.json');await writeFile(file,JSON.stringify({version:1,cases:[{id:'story-output',tasks:['story'],steps:[{command:['node','app.js'],exitCode:0,stdout:'story\n'}]}]}));await approveChecks(project,file);
 return {root,project};
}
async function applied(checkout:string){
 await writeFile(path.join(checkout,'app.js'),'console.log("story");\n');
 const tasks=JSON.parse(await readFile(path.join(checkout,'features.json'),'utf8'));tasks[0].status='done';await writeFile(path.join(checkout,'features.json'),JSON.stringify(tasks));
 const root=checkout+'-harness';const snap=await captureBaseline(checkout,path.join(root,'test-snapshot'));
 const approval=JSON.parse(await readFile(path.join(root,'acceptance/approved.json'),'utf8'));
 const evidencePath=path.join(root,'acceptance/results/1234-abcd.json');await mkdir(path.dirname(evidencePath),{recursive:true});
 const proof={approvalDigest:approval.digest,candidateDigest:snap.digest,evidencePath};
 await writeFile(evidencePath,JSON.stringify({version:1,project:checkout,outcome:'passed',tasks:['story'],...proof}));
 await appendRun(checkout,{id:'r1',at:new Date().toISOString(),project:checkout,goal:'story',attempts:1,outcome:'applied',gates:['tests passed'],review:{verdict:'pass',findings:[]},changes:[],candidateDigest:snap.digest,acceptance:proof});
}
test('task checkout shares Git history, imports approved controls but no prior evidence, and leaves main unchanged',async t=>{
 const f=await fixture(t),head=await checkedGit(f.project,['rev-parse','HEAD']);const w=await createWorktree(f.project,'story');
 assert.equal(await checkedGit(w.checkout,['rev-parse','HEAD']),head);assert.equal(await checkedGit(w.checkout,['branch','--show-current']),w.branch);
 assert.equal(await readFile(path.join(f.project,'app.js'),'utf8'),'console.log("old");\n');
 assert.ok(await readFile(w.checkout+'-harness/acceptance/approved.json'));
 await assert.rejects(readFile(w.checkout+'-harness/record.jsonl'),{code:'ENOENT'});
 const snap=await captureBaseline(w.checkout,path.join(f.root,'copy'));assert.ok(!Object.keys(snap.files).includes('.git'));
 assert.equal((await listWorktrees(f.project)).length,1);
});
test('creation refuses dirty or detached roots, duplicate unfinished task work, and unsupported attributes',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.project,'new.txt'),'keep');await assert.rejects(()=>createWorktree(f.project,'story'),/clean/i);await rm(path.join(f.project,'new.txt'));
 await createWorktree(f.project,'story');await assert.rejects(()=>createWorktree(f.project,'story'),/already/i);
 const g=await fixture(t);await checkedGit(g.project,['checkout','--detach']);await assert.rejects(()=>createWorktree(g.project,'story'),/branch/i);
 const h=await fixture(t);await writeFile(path.join(h.project,'.gitattributes'),'*.js filter=custom\n');await checkedGit(h.project,['add','.gitattributes']);await checkedGit(h.project,['commit','-m','Attributes']);await assert.rejects(()=>createWorktree(h.project,'story'),/attributes/i);
});
test('commit accepts only exact verified source and does not execute repository hooks',async t=>{
 const f=await fixture(t),w=await createWorktree(f.project,'story');await assert.rejects(()=>commitWorktree(f.project,w.id),/applied/i);await applied(w.checkout);
 await writeFile(path.join(w.checkout,'app.js'),'unverified');await assert.rejects(()=>commitWorktree(f.project,w.id),/verified|evidence|candidate/i);
 await writeFile(path.join(w.checkout,'app.js'),'console.log("story");\n');
 const hook=path.join(f.project,'.git/hooks/pre-commit');await writeFile(hook,'#!/bin/sh\nexit 19\n',{mode:0o755});
 const saved=await commitWorktree(f.project,w.id);assert.ok(saved.tip);assert.equal(await checkedGit(w.checkout,['status','--porcelain']), '');
 assert.equal(await readFile(path.join(f.project,'app.js'),'utf8'),'console.log("old");\n');
});
test('merge checks combined source in an isolated checkout before advancing main; cleanup preserves branch history',async t=>{
 const f=await fixture(t),w=await createWorktree(f.project,'story');await applied(w.checkout);await commitWorktree(f.project,w.id);
 await writeFile(path.join(f.project,'parallel.txt'),'other task');await checkedGit(f.project,['add','parallel.txt']);await checkedGit(f.project,['commit','-m','Other task']);
 let calls=0;const merged=await mergeWorktree(f.project,w.id,async checkout=>{calls++;assert.equal(await readFile(path.join(checkout,'parallel.txt'),'utf8'),'other task');assert.equal(await readFile(path.join(checkout,'app.js'),'utf8'),'console.log("story");\n');assert.equal(await readFile(path.join(f.project,'app.js'),'utf8'),'console.log("old");\n');});
 assert.equal(calls,1);assert.equal(merged.status,'merged');assert.equal(await readFile(path.join(f.project,'app.js'),'utf8'),'console.log("story");\n');
 await removeWorktree(f.project,w.id);assert.equal((await listWorktrees(f.project))[0]?.status,'removed');assert.ok(await checkedGit(f.project,['rev-parse',w.branch]));
});
test('failed verification and merge conflicts leave main unchanged and retain task work',async t=>{
 const f=await fixture(t),w=await createWorktree(f.project,'story');await applied(w.checkout);await commitWorktree(f.project,w.id);const head=await checkedGit(f.project,['rev-parse','HEAD']);
 await assert.rejects(()=>mergeWorktree(f.project,w.id,async()=>{throw Error('Observed failure');}),/Observed failure/);assert.equal(await checkedGit(f.project,['rev-parse','HEAD']),head);
 await assert.rejects(()=>removeWorktree(f.project,w.id),/merged|unfinished/i);
 await writeFile(path.join(f.project,'app.js'),'conflicting change\n');await checkedGit(f.project,['add','app.js']);await checkedGit(f.project,['commit','-m','Conflicting']);
 await assert.rejects(()=>mergeWorktree(f.project,w.id,async()=>assert.fail('Must not verify conflicts')),/conflict/i);
 assert.equal(await readFile(path.join(w.checkout,'app.js'),'utf8'),'console.log("story");\n');
});
test('changed approvals and active branch writers block host operations',async t=>{
 const f=await fixture(t),w=await createWorktree(f.project,'story');await applied(w.checkout);
 const lease=await acquireWriter(w.checkout,'active builder');try{await assert.rejects(()=>commitWorktree(f.project,w.id),/locked/);}finally{await lease.release();}
 const p=f.project+'-harness/acceptance/approved.json';const a=JSON.parse(await readFile(p,'utf8'));a.manifest.cases[0].steps[0].stdout='other';a.digest=sha256(JSON.stringify(a.manifest));await writeFile(p,JSON.stringify(a));
 await assert.rejects(()=>commitWorktree(f.project,w.id),/approval|controls/i);
});
test('changed source during integration verification prevents merge',async t=>{
 const f=await fixture(t),w=await createWorktree(f.project,'story');await applied(w.checkout);await commitWorktree(f.project,w.id);const head=await checkedGit(f.project,['rev-parse','HEAD']);
 await assert.rejects(()=>mergeWorktree(f.project,w.id,async checkout=>{await writeFile(path.join(checkout,'app.js'),'tampered');}),/changed/i);
 assert.equal(await checkedGit(f.project,['rev-parse','HEAD']),head);
});

test('verified integration resumes after interruption before and after fast-forward',async t=>{
 for(const phase of ['verified','merged'] as const){
  const f=await fixture(t),w=await createWorktree(f.project,'story');await applied(w.checkout);await commitWorktree(f.project,w.id);
  await assert.rejects(()=>mergeWorktree(f.project,w.id,async()=>{},async p=>{if(p===phase)throw Error('Interrupted controller');}),/Interrupted/);
  const saved=(await listWorktrees(f.project))[0]!;assert.equal(saved.status,'verified');
  const recovered=await recoverWorktree(f.project,w.id);assert.equal(recovered.status,'merged');assert.equal(await checkedGit(f.project,['rev-parse','HEAD']),saved.mergeCommit);
  assert.equal((await recoverWorktree(f.project,w.id)).status,'merged');
 }
});
test('cleanup refuses ignored files and extra unmerged commits; those bytes remain',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.project,'.gitignore'),'unsaved.txt\n');await checkedGit(f.project,['add','.gitignore']);await checkedGit(f.project,['commit','-m','Ignore local notes']);
 const w=await createWorktree(f.project,'story');await applied(w.checkout);await commitWorktree(f.project,w.id);await mergeWorktree(f.project,w.id,async()=>{});
 await writeFile(path.join(w.checkout,'unsaved.txt'),'important');await assert.rejects(()=>removeWorktree(f.project,w.id),/clean/i);assert.equal(await readFile(path.join(w.checkout,'unsaved.txt'),'utf8'),'important');
 await rm(path.join(w.checkout,'unsaved.txt'));await writeFile(path.join(w.checkout,'app.js'),'later work');await checkedGit(w.checkout,['add','app.js']);await checkedGit(w.checkout,['commit','-m','Unmerged work']);
 await assert.rejects(()=>removeWorktree(f.project,w.id),/unfinished/i);
 assert.equal(await readFile(path.join(w.checkout,'app.js'),'utf8'),'later work');
});
test('excluded files are not silently included in a verified task commit',async t=>{
 const f=await fixture(t),w=await createWorktree(f.project,'story');await applied(w.checkout);await writeFile(path.join(w.checkout,'.env'),'PRIVATE=value');
 await assert.rejects(()=>commitWorktree(f.project,w.id),/excluded/i);
 assert.equal(await checkedGit(w.checkout,['diff','--cached','--name-only']),'');
});
test('switching the target branch while verification runs stops integration',async t=>{
 const f=await fixture(t),w=await createWorktree(f.project,'story');await applied(w.checkout);await commitWorktree(f.project,w.id);
 await assert.rejects(()=>mergeWorktree(f.project,w.id,async()=>{await checkedGit(f.project,['checkout','-b','other']);}),/Target branch changed/);
 assert.equal(await readFile(path.join(f.project,'app.js'),'utf8'),'console.log("old");\n');
});

test('an ignored attributes file cannot activate host filters',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.project,'.gitignore'),'.gitattributes\n');await checkedGit(f.project,['add','.gitignore']);await checkedGit(f.project,['commit','-m','Ignore attributes']);
 await writeFile(path.join(f.project,'.gitattributes'),'*.js filter=custom\n');await assert.rejects(()=>createWorktree(f.project,'story'),/attributes/i);
});
test('creation recovery reuses the owned checkout and refuses changed source',async t=>{
 const f=await fixture(t),w=await createWorktree(f.project,'story'),state=path.join(path.dirname(w.checkout),'state.json');
 await writeFile(state,JSON.stringify({...w,status:'creating'}));await rm(w.checkout+'-harness',{recursive:true});
 assert.equal((await recoverWorktree(f.project,w.id)).status,'ready');assert.ok(await readFile(w.checkout+'-harness/acceptance/approved.json'));
 await writeFile(state,JSON.stringify({...w,status:'creating'}));await writeFile(path.join(w.checkout,'app.js'),'keep my unfinished edit');
 await assert.rejects(()=>recoverWorktree(f.project,w.id),/clean/);assert.equal(await readFile(path.join(w.checkout,'app.js'),'utf8'),'keep my unfinished edit');
});

test('integration cannot silently drop previously completed task coverage',async t=>{
 const f=await fixture(t),featuresFile=path.join(f.project,'features.json');const tasks=JSON.parse(await readFile(featuresFile,'utf8'));tasks.push({id:'existing',title:'Existing',priority:'must',status:'done',criteria:['Existing behaviour'],dependsOn:[]});
 await writeFile(featuresFile,JSON.stringify(tasks));await checkedGit(f.project,['add','features.json']);await checkedGit(f.project,['commit','-m','Existing completed task']);
 const w=await createWorktree(f.project,'story');await applied(w.checkout);
 const changed=JSON.parse(await readFile(path.join(w.checkout,'features.json'),'utf8'));changed[1].status='todo';await writeFile(path.join(w.checkout,'features.json'),JSON.stringify(changed));
 await commitWorktree(f.project,w.id);await assert.rejects(()=>mergeWorktree(f.project,w.id,async()=>assert.fail('Coverage regression must stop before verification')),/regress completion status/);
 assert.equal(JSON.parse(await readFile(featuresFile,'utf8'))[1].status,'done');
});
