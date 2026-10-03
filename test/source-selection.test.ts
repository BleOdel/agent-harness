import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sourceFiles, captureBaseline, assertSnapshot } from '../src/workspace/candidate.ts';
import { collectChanges, assertChangesAreApplicable, type Change } from '../src/workspace/changes.ts';
import { createSandbox, destroySandbox, createRunWorkspace, destroyRunWorkspace, applyChanges } from '../src/workspace/sandbox-lifecycle.ts';
import { renderDiff } from '../src/review/diff.ts';
import { collectTree } from '../src/view/files.ts';
const token='SYNTHETIC_PRIVATE_CANARY_58219';
const privatePaths=['.env.production','service/.env','service/.env.local','service/.env.staging','service/.npmrc','service/.aws/credentials'];
const safePaths=['.env.example','service/.env.sample','service/.env.template','index.js'];
async function fixture() {
 const root=await mkdtemp(path.join(os.tmpdir(),'source-selection-')),project=path.join(root,'project');
 for(const file of [...privatePaths,...safePaths]){const p=path.join(project,file);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,privatePaths.includes(file)?token:'SAFE_PLACEHOLDER');}
 return {root,project};
}
test('F09 one path policy excludes private variants at every depth across copies, reports and apply',async()=>{
 const {root,project}=await fixture();
 try {
  assert.deepEqual(Object.keys(await sourceFiles(project)).sort(),safePaths.slice().sort());
  const baseline=await captureBaseline(project,path.join(root,'baseline'));
  assert.deepEqual(Object.keys(baseline.files).sort(),safePaths.slice().sort());
  const sandbox=await createSandbox(project);
  try {for(const file of privatePaths)await assert.rejects(readFile(path.join(sandbox.workDirectory,file)),{code:'ENOENT'});
   assert.ok(sandbox.withheld.includes('service/.env'));
  }finally{await destroySandbox(sandbox);}
  const run=await createRunWorkspace(project);
  try {assert.ok(run.sandbox.withheld.includes('service/.env'));}finally{await destroyRunWorkspace(run);}
  const copy=path.join(root,'other');await mkdir(copy);await writeFile(path.join(copy,'index.js'),'SAFE_EDIT');
  const changes=await collectChanges(project,copy);
  assert.ok(changes.every(c=>!privatePaths.includes(c.file)));
  const forged:Change[]=[{file:'service/.env',kind:'modified',symlink:false}];
  assert.throws(()=>assertChangesAreApplicable(forged,copy),/excluded|private|never applies/);
  await assert.rejects(applyChanges(project,copy,forged),/excluded|private|never applies/);
  const diff=await renderDiff(project,project,forged);
  assert.ok(!diff.includes(token));assert.match(diff,/withheld|excluded/i);
  const tree=await collectTree(project,[]);
  assert.ok(!JSON.stringify(tree).includes(token));
  assert.deepEqual(tree.files.map(f=>f.path).sort(),safePaths.slice().sort());
  assert.equal(await readFile(path.join(project,'service/.env'),'utf8'),token,'live secrets are retained');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('a legacy snapshot containing newly excluded files is refused and preserved',async()=>{
 const {root,project}=await fixture();
 try {
  const files:Record<string,string>={};for(const p of [...privatePaths,...safePaths])files[p]=createHash('sha256').update(await readFile(path.join(project,p))).digest('hex');
  const digest=createHash('sha256').update(JSON.stringify(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)))).digest('hex');
  await assert.rejects(assertSnapshot({directory:project,files,digest}),/selection|Frozen source/);
  assert.equal(await readFile(path.join(project,'service/.env'),'utf8'),token);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('excluded artifact names cannot be published or exported; legacy bytes remain retained',async()=>{
 const {root,project}=await fixture();
 try {
  const {putArtifact,artifactBytes,exportArtifact}=await import('../src/artifacts/store.ts');
  const {readOutput}=await import('../src/view/workspace.ts');
  const provenance={producer:'fixture',input:'a'.repeat(64),environment:'b'.repeat(64),verification:'unverified' as const};
  await assert.rejects(putArtifact(project,'service/.env',Buffer.from(token),provenance),/excluded/);
  const a=await putArtifact(project,'safe.txt',Buffer.from(token),provenance);
  const state=project+'-harness';
  await writeFile(path.join(state,'artifacts/manifests',a.id+'.json'),JSON.stringify({...a,name:'service/.env.production'}));
  await assert.rejects(artifactBytes(project,a.id),/withheld/);
  await assert.rejects(exportArtifact(project,a.id,path.join(root,'exported.txt')),/withheld/);
  await assert.rejects(readOutput(project,a.id),/withheld/);
  assert.equal(await readFile(path.join(state,'artifacts/blobs',a.sha256),'utf8'),token);
  await assert.rejects(readFile(path.join(root,'exported.txt')),{code:'ENOENT'});
 }finally{await rm(root,{recursive:true,force:true});}
});
