import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,chmod,stat,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {captureBaseline,captureCandidate,copySource,assertLiveBaseline,assertSnapshot} from '../src/workspace/candidate.ts';
import {collectChanges} from '../src/workspace/changes.ts';
import {applyChanges,snapshotForRecovery} from '../src/workspace/sandbox-lifecycle.ts';
import {appendRun,recoveryPath,readRecord} from '../src/record/record.ts';
import {undo} from '../src/verbs/undo.ts';
const mode=async(p:string)=>(await stat(p)).mode&0o777;
async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),'mode-identity-'));const project=root+'/project';await mkdir(project);await writeFile(project+'/run.sh','#!/bin/sh\nexit 0\n',{mode:0o644});return {root,project,close:()=>rm(root,{recursive:true,force:true})};}

test('F06 mode-only changes are verified, applied, undone and redone',async()=>{
 const f=await fixture();try{
  const baseline=await captureBaseline(f.project,f.root+'/baseline');await copySource(f.project,f.root+'/worker');await chmod(f.root+'/worker/run.sh',0o755);
  const candidate=await captureCandidate(baseline,f.root+'/worker',f.root+'/candidate');assert.notEqual(candidate.digest,baseline.digest);assert.equal(candidate.changes.length,1);assert.equal((await collectChanges(f.project,f.root+'/worker')).length,1);
  await snapshotForRecovery(f.project,candidate.directory,candidate.changes,recoveryPath(f.project,'r1'));await applyChanges(f.project,candidate.directory,candidate.changes);
  assert.equal(await mode(f.project+'/run.sh'),0o755);
  const {run}=await import('../src/run.ts');assert.equal((await run(f.project+'/run.sh',[],{timeoutMs:5000})).code,0);
  const {renderDiff}=await import('../src/review/diff.ts');assert.match(await renderDiff(baseline.directory,candidate.directory,candidate.changes),/executable mode: 644 -> 755/);
  await appendRun(f.project,{id:'r1',at:new Date().toISOString(),project:f.project,goal:'script',attempts:1,outcome:'applied',gates:[],changes:candidate.changes});
  await undo(f.project,['r1']);assert.equal(await mode(f.project+'/run.sh'),0o644);
  await undo(f.project,['r2']);assert.equal(await mode(f.project+'/run.sh'),0o755);assert.equal((await readRecord(f.project)).runs.length,3);
 }finally{await f.close();}
});
test('mode drift invalidates frozen and live identity, while irrelevant permission bits do not',async()=>{
 const f=await fixture();try{
  const before=await captureBaseline(f.project,f.root+'/before');await chmod(f.project+'/run.sh',0o600);await assertLiveBaseline(f.project,before);
  await chmod(f.project+'/run.sh',0o700);await assert.rejects(assertLiveBaseline(f.project,before),/changed/);
  await chmod(before.directory+'/run.sh',0o755);await assert.rejects(assertSnapshot(before),/changed/);
 }finally{await f.close();}
});
test('privileged source modes fail closed and byte-only snapshots are not fresh evidence',async()=>{
 const f=await fixture();try{
  const before=await captureBaseline(f.project,f.root+'/before');const old={...before,files:{...before.files}};delete (old as {identityVersion?:number}).identityVersion;
  const {createHash}=await import('node:crypto');for(const file of Object.keys(old.files))old.files[file]=old.files[file]!.slice(7);old.digest=createHash('sha256').update(JSON.stringify(Object.entries(old.files).sort(([a],[b])=>a.localeCompare(b)))).digest('hex');
  await assert.rejects(assertSnapshot(old),/legacy|identity|version/i);
  await chmod(f.project+'/run.sh',0o4644);await assert.rejects(captureBaseline(f.project,f.root+'/unsafe'),/permission|privileged/i);
 }finally{await f.close();}
});

test('ordinary apply refuses a changed live mode after verification',async()=>{
 const f=await fixture();try{
  const baseline=await captureBaseline(f.project,f.root+'/baseline');await copySource(f.project,f.root+'/worker');await writeFile(f.root+'/worker/run.sh','new bytes');
  const candidate=await captureCandidate(baseline,f.root+'/worker',f.root+'/candidate');await chmod(f.project+'/run.sh',0o755);
  await assert.rejects(applyChanges(f.project,candidate.directory,candidate.changes,baseline,candidate),/changed/);assert.equal(await mode(f.project+'/run.sh'),0o755);assert.match(await readFile(f.project+'/run.sh','utf8'),/exit 0/);
 }finally{await f.close();}
});
