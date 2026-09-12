import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { putArtifact, artifactBytes, exportArtifact, listArtifacts, collectArtifacts, releaseArtifacts } from '../src/artifacts/store.ts';
const provenance = { producer: 'job-test', input: 'a'.repeat(64), environment: 'b'.repeat(64), verification: 'unverified' as const };
test('artifact bytes are deduplicated, verified on read/export, and released only when inactive', async () => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-test-')), project = path.join(root, 'project'); await mkdir(project);
 try {
  const a = await putArtifact(project, 'model.bin', Buffer.from([0,255,1]), provenance);
  const b = await putArtifact(project, 'copy.bin', Buffer.from([0,255,1]), provenance);
  assert.equal(a.sha256,b.sha256); assert.notEqual(a.id,b.id); assert.deepEqual(await artifactBytes(project,a.id), Buffer.from([0,255,1]));
  const out = path.join(root,'export.bin'); await exportArtifact(project,a.id,out); assert.deepEqual(await readFile(out),Buffer.from([0,255,1]));
  await assert.rejects(exportArtifact(project,a.id,out), /exist/i);
  await assert.rejects(releaseArtifacts(project,'job-test',new Set(['job-test'])), /active|recoverable/);
  await collectArtifacts(project); assert.equal((await listArtifacts(project)).length,2);
  await writeFile(path.join(project+'-harness/artifacts/blobs',a.sha256),'corrupt'); await assert.rejects(artifactBytes(project,a.id),/hash|corrupt/);
  await releaseArtifacts(project,'job-test',new Set()); await collectArtifacts(project); assert.deepEqual(await listArtifacts(project),[]);
 } finally { await rm(root,{recursive:true,force:true}); }
});
test('artifact store refuses unsafe aliases and enforces bounded retention', async () => {
 const root = await mkdtemp(path.join(os.tmpdir(),'artifact-alias-')), project=path.join(root,'project'); await mkdir(project);
 try {
  await mkdir(project+'-harness'); await symlink(root,project+'-harness/artifacts');
  await assert.rejects(putArtifact(project,'test',Buffer.from('x'),provenance),/symlink|directory/);
  await rm(project+'-harness/artifacts');
  await assert.rejects(putArtifact(project,'../outside',Buffer.from('x'),provenance),/name|path/);
  await assert.rejects(putArtifact(project,'large',Buffer.alloc(33*1024*1024),provenance),/limit|MiB/);
 } finally {await rm(root,{recursive:true,force:true});}
});

test('build output declarations collect wheels and refuse unsafe trees and oversized batches',async()=>{
 const {buildOutputs}=await import('../src/artifacts/outputs.ts');
 const root=await mkdtemp(path.join(os.tmpdir(),'artifact-build-'));
 try{
  await mkdir(path.join(root,'dist'));await writeFile(path.join(root,'dist/a.whl'),Buffer.from('wheel'));await writeFile(path.join(root,'dist/ignore.txt'),'ignore');
  assert.deepEqual((await buildOutputs(root,['dist/*.whl'])).map(a=>a.name),['dist/a.whl']);
  await symlink('/etc/passwd',path.join(root,'dist/b.whl'));await assert.rejects(buildOutputs(root,['dist/*.whl']),/symlink/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('ordinary candidates cannot apply generated model formats or oversized data as source',async()=>{
 const {captureBaseline,captureCandidate}=await import('../src/workspace/candidate.ts');
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'artifact-source-'))),project=path.join(root,'project'),worker=path.join(root,'worker');await mkdir(project);await mkdir(worker);
 try{
  const baseline=await captureBaseline(project,path.join(root,'baseline'));
  await writeFile(path.join(worker,'model.onnx'),'weights');await assert.rejects(captureCandidate(baseline,worker,path.join(root,'candidate')),/generated package, model or dataset/);
  await rm(path.join(worker,'model.onnx'));await writeFile(path.join(worker,'data.bin'),Buffer.alloc(2*1024*1024+1));await assert.rejects(captureCandidate(baseline,worker,path.join(root,'candidate')),/2 MiB/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('interrupted atomic artifact writes do not poison committed manifests or cleanup',async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'artifact-atomic-'))),project=path.join(root,'project');await mkdir(project);
 try{
  const a=await putArtifact(project,'ready',Buffer.from('ready'),provenance),name='.harness-write-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  for(const dir of ['manifests','blobs'])await writeFile(path.join(project+'-harness/artifacts',dir,name),'incomplete');
  assert.equal((await listArtifacts(project)).length,1);await collectArtifacts(project);assert.equal((await artifactBytes(project,a.id)).toString(),'ready');
 }finally{await rm(root,{recursive:true,force:true});}
});
