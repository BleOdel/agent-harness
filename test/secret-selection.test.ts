import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {contentFindings, assertContentAllowed, CONTENT_LIMIT} from '../src/workspace/secret-content.ts';
import {sourceFiles, captureBaseline, assertSnapshot} from '../src/workspace/candidate.ts';
import {createSandbox} from '../src/workspace/sandbox-lifecycle.ts';
import {renderDiff} from '../src/review/diff.ts';
import {collectTree} from '../src/view/files.ts';
import {putArtifact, artifactBytes} from '../src/artifacts/store.ts';
import {readOutput} from '../src/view/workspace.ts';
import {readArtifact} from '../src/planning/store.ts';
import {sourcePolicyCommand} from '../src/verbs/source.ts';
import {withWriter} from '../src/workspace/writer-lock.ts';
const canary = 'gh'+'p_'+ 'A7cD9eF2'.repeat(5);
const digest=(b:string)=>createHash('sha256').update(b).digest('hex');
async function fixture(t:TestContext) {const root=await mkdtemp(path.join(os.tmpdir(),'secret-selection-'));t.after(()=>rm(root,{recursive:true,force:true}));const project=path.join(root,'project');await mkdir(project);return {root,project};}
test('bounded high-confidence scanning catches synthetic tokens and keys without returning values',()=>{
 for(const text of [canary,'-----BEGIN '+'OPENSSH PRIVATE KEY-----\nfixture',Buffer.from('binary\0'+canary)]) {
  assert.ok(contentFindings(text).length);assert.throws(()=>assertContentAllowed('fixture.txt',text),e=>e instanceof Error&&!e.message.includes(canary)&&/withheld/i.test(e.message));
 }
 assert.deepEqual(contentFindings('API_KEY=YOUR_API_KEY_HERE\nTOKEN=example'),[]);
 assert.throws(()=>assertContentAllowed('large',Buffer.alloc(CONTENT_LIMIT+1)),/limit/);
});
test('source copies, snapshots, prompts, diffs and dashboard never expose detected content',async t=>{
 const {root,project}=await fixture(t);await writeFile(path.join(project,'index.js'),canary);
 await assert.rejects(sourceFiles(project),/withheld/);
 await assert.rejects(captureBaseline(project,path.join(root,'baseline')),/withheld/);
 await assert.rejects(createSandbox(project),/withheld/);
 await assert.rejects(readArtifact(project,'index.js'),/withheld/);
 const diff=await renderDiff(project,project,[{file:'index.js',kind:'modified',symlink:false}]);
 assert.ok(!diff.includes(canary));assert.match(diff,/withheld/);
 const tree=await collectTree(project,[]);assert.ok(!JSON.stringify(tree).includes(canary));assert.equal(tree.omitted,1);
 assert.equal(await readFile(path.join(project,'index.js'),'utf8'),canary);
});
test('host exceptions bind exact path and bytes; worker config cannot authorize content; revocation preserves snapshots',async t=>{
 const {root,project}=await fixture(t);await writeFile(path.join(project,'fixture.txt'),canary);
 await sourcePolicyCommand(project,['allow','fixture.txt','--sha256',digest(canary),'--reason','Synthetic test fixture']);
 const snapshot=await withWriter(project,'fixture',()=>captureBaseline(project,path.join(root,'baseline')));
 await assert.rejects(assertSnapshot(snapshot),/withheld/,'no ambient host authorization outside operation');
 await withWriter(project,'fixture',()=>assertSnapshot(snapshot));
 await writeFile(path.join(project,'other.txt'),canary);
 await withWriter(project,'fixture',()=>assert.rejects(sourceFiles(project),/withheld/));await rm(path.join(project,'other.txt'));
 await writeFile(path.join(project,'fixture.txt'),canary+'changed');
 await withWriter(project,'fixture',()=>assert.rejects(sourceFiles(project),/withheld/));
 await sourcePolicyCommand(project,['revoke','fixture.txt']);
 await withWriter(project,'fixture',()=>assert.rejects(assertSnapshot(snapshot),/withheld/));
 assert.equal(await readFile(path.join(snapshot.directory,'fixture.txt'),'utf8'),canary);
 await writeFile(path.join(project,'.env'),canary);
 await assert.rejects(sourcePolicyCommand(project,['allow','.env','--sha256',digest(canary),'--reason','Example']),/excluded/);
 await assert.rejects(sourcePolicyCommand(project,['allow','fixture.txt','--sha256',digest(canary),'--reason','Example']),/changed/);
});
test('artifact ingestion and legacy export are checked without deleting retained blobs',async t=>{
 const {root,project}=await fixture(t);const p={producer:'fixture',input:'a'.repeat(64),environment:'b'.repeat(64),verification:'unverified' as const};
 await assert.rejects(putArtifact(project,'safe.txt',Buffer.from(canary),p),/withheld/);
 const a=await putArtifact(project,'safe.txt',Buffer.from('safe'),p);
 const state=project+'-harness';const legacy={...a,sha256:digest(canary),size:Buffer.byteLength(canary)};
 await writeFile(path.join(state,'artifacts/blobs',legacy.sha256),canary);
 await writeFile(path.join(state,'artifacts/manifests',a.id+'.json'),JSON.stringify(legacy));
 await assert.rejects(artifactBytes(project,a.id),/withheld/);await assert.rejects(readOutput(project,a.id),/withheld/);
 assert.equal(await readFile(path.join(state,'artifacts/blobs',legacy.sha256),'utf8'),canary);
});
test('unsafe proposed content cannot be applied, and model prompt guards fire before dispatch',async t=>{
 const {root,project}=await fixture(t),copy=path.join(root,'copy');await mkdir(copy);await writeFile(path.join(project,'index.js'),'original');await writeFile(path.join(copy,'index.js'),canary);
 const {applyChanges}=await import('../src/workspace/sandbox-lifecycle.ts');
 await assert.rejects(applyChanges(project,copy,[{file:'index.js',kind:'modified',symlink:false}]),/withheld/);
 assert.equal(await readFile(path.join(project,'index.js'),'utf8'),'original');
 const {buildAgentCommand}=await import('../src/agent/pi.ts');
 assert.throws(()=>buildAgentCommand({goal:canary,provider:undefined,model:undefined,timeoutMs:1,skills:false}),/withheld/);
 const {requestCheckJson}=await import('../src/acceptance/draft.ts');await assert.rejects(requestCheckJson(project,canary),/withheld/);
 const {buildPlanCommand}=await import('../src/verbs/plan.ts');assert.throws(()=>buildPlanCommand({topic:canary,skills:[],skillsConfigured:false,provider:undefined,model:undefined}),/withheld/);
});
test('safe environment examples pass; content findings in examples and worker-written policy do not',async t=>{
 const {project}=await fixture(t);await writeFile(path.join(project,'.env.example'),'API_KEY=YOUR_KEY_HERE');
 assert.ok((await sourceFiles(project))['.env.example']);await writeFile(path.join(project,'.env.example'),canary);
 await writeFile(path.join(project,'source-policy.json'),JSON.stringify({version:1,exceptions:[{path:'.env.example',sha256:digest(canary),reason:'worker request'}]}));
 await assert.rejects(sourceFiles(project),/withheld/);
});
test('binary and oversized inputs cannot bypass scanning, and aliased policy state is refused',async t=>{
 const {root,project}=await fixture(t);await writeFile(path.join(project,'image.png'),Buffer.from('PNG\0'+canary));
 await assert.rejects(sourceFiles(project),/withheld/);await rm(path.join(project,'image.png'));
 const {symlink,truncate}=await import('node:fs/promises');await writeFile(path.join(project,'huge.dat'),'');await truncate(path.join(project,'huge.dat'),CONTENT_LIMIT+1);
 await assert.rejects(sourceFiles(project),/limit/);await rm(path.join(project,'huge.dat'));
 const policy=path.join(root,'policy.json');await writeFile(policy,JSON.stringify({version:1,exceptions:[]}));await mkdir(project+'-harness');await symlink(policy,path.join(project+'-harness','source-policy.json'));
 await assert.rejects(withWriter(project,'fixture',async()=>{}),/symlink|alias/);
 await rm(project+'-harness',{recursive:true,force:true});const outside=path.join(root,'outside');await mkdir(outside);await writeFile(path.join(outside,'source-policy.json'),JSON.stringify({version:1,exceptions:[]}));await symlink(outside,project+'-harness');await assert.rejects(withWriter(project,'fixture',async()=>{}),/symlink|alias/);
});
test('operator inspection prints redacted findings and does not silently grant an exception',async t=>{
 const {project}=await fixture(t);await writeFile(path.join(project,'fixture.txt'),canary);
 const {run}=await import('../src/run.ts');
 const r=await run(process.execPath,[path.resolve(import.meta.dirname,'../src/cli.ts'),'source','inspect'],{env:{...process.env,HARNESS_PROJECT:project,HARNESS_CONFIG:'/dev/null'},timeoutMs:10000});
 assert.equal(r.code,0);assert.match(r.stdout,/github-token/);assert.ok(r.stdout.includes(digest(canary)));assert.ok(!r.stdout.includes(canary));assert.ok(!r.stderr.includes(canary));
 await assert.rejects(sourceFiles(project),/withheld/);await assert.rejects(readFile(path.join(project+'-harness','source-policy.json')),{code:'ENOENT'});
});
