import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile,symlink,readdir} from 'node:fs/promises';
import {putArtifact,releaseArtifacts,collectArtifacts,artifactBytes} from '../src/artifacts/store.ts';
import {prepareRelease,approveRelease,dryRunRelease,stageRelease,retireRelease} from '../src/releases/controller.ts';
import {readRelease,releaseRoot,saveRelease} from '../src/releases/store.ts';
async function fixture(t: test.TestContext){const root=await mkdtemp('/private/tmp/release-test-'),project=root+'/project',destination=root+'/out';await mkdir(project);await mkdir(destination);t.after(()=>rm(root,{recursive:true,force:true}));const artifact=await putArtifact(project,'app.zip',Buffer.from('inert package bytes'),{producer:'fixture',input:'a'.repeat(64),environment:'b'.repeat(64),verification:'diagnostics-passed'});return {root,project,destination,artifact};}
test('draft pins bytes independently, dry run writes nothing, approval binds the exact manifest, staging is idempotent',async t=>{
 const f=await fixture(t),draft=await prepareRelease(f.project,{artifact:f.artifact.id,name:'notes',version:'1.2.3',destination:f.destination});
 await releaseArtifacts(f.project,'fixture',new Set());await collectArtifacts(f.project);assert.equal((await artifactBytes(f.project,draft.manifest.snapshot.id)).toString(),'inert package bytes');
 assert.equal((await dryRunRelease(f.project,draft.id)).approved,false);assert.deepEqual(await readdir(f.destination),[]);await assert.rejects(stageRelease(f.project,draft.id),/approval/i);
 await approveRelease(f.project,draft.id,draft.digest);const staged=await stageRelease(f.project,draft.id);assert.equal(staged.status,'staged');
 const receipt=await readFile(staged.manifest.target+'/receipt.json','utf8');assert.equal(JSON.parse(receipt).manifestDigest,draft.digest);assert.equal((await stageRelease(f.project,draft.id)).status,'staged');assert.equal(await readFile(staged.manifest.target+'/receipt.json','utf8'),receipt);
 await retireRelease(f.project,draft.id);await collectArtifacts(f.project);await assert.rejects(stageRelease(f.project,draft.id),/retired/);assert.equal(await readFile(staged.manifest.target+'/receipt.json','utf8'),receipt);
});
test('changed draft, destination, output and verification status are refused',async t=>{
 const f=await fixture(t);for(const name of ['../escape','x/y','UPPER'])await assert.rejects(prepareRelease(f.project,{artifact:f.artifact.id,name,version:'1.0.0',destination:f.destination}),/name/);
 const unverified=await putArtifact(f.project,'raw.bin',Buffer.from('raw'),{input:f.artifact.input,environment:f.artifact.environment,producer:'raw',verification:'unverified'});await assert.rejects(prepareRelease(f.project,{artifact:unverified.id,name:'raw',version:'1.0.0',destination:f.destination}),/unverified/);
 const d=await prepareRelease(f.project,{artifact:f.artifact.id,name:'notes',version:'1.0.0',destination:f.destination});await assert.rejects(approveRelease(f.project,d.id,'f'.repeat(64)),/changed|digest/);await approveRelease(f.project,d.id,d.digest);
 await mkdir(d.manifest.target);await writeFile(d.manifest.target+'/unrelated','keep');await assert.rejects(stageRelease(f.project,d.id),/owner|ownership/);assert.equal(await readFile(d.manifest.target+'/unrelated','utf8'),'keep');
 const state=await readRelease(f.project,d.id);state.manifest.version='2.0.0';await saveRelease(f.project,state);await assert.rejects(readRelease(f.project,d.id),/changed|identity/);
});
test('partial staging resumes and modified completed bytes never get overwritten',async t=>{
 const f=await fixture(t),d=await prepareRelease(f.project,{artifact:f.artifact.id,name:'notes',version:'1.0.0',destination:f.destination});await approveRelease(f.project,d.id,d.digest);
 await assert.rejects(stageRelease(f.project,d.id,async phase=>{if(phase==='payload')throw Error('interrupted fixture');}),/interrupted fixture/);
 assert.equal((await readRelease(f.project,d.id)).status,'staging');assert.ok(!(await readdir(d.manifest.target)).includes('receipt.json'));
 await stageRelease(f.project,d.id);const file=d.manifest.target+'/'+d.manifest.filename;await writeFile(file,'changed');await assert.rejects(stageRelease(f.project,d.id),/changed|mismatch/);assert.equal(await readFile(file,'utf8'),'changed');
});
test('release references cannot be removed early; corrupt blobs, swapped directories and symlinks fail closed',async t=>{
 const f=await fixture(t),d=await prepareRelease(f.project,{artifact:f.artifact.id,name:'notes',version:'1.0.0',destination:f.destination});await approveRelease(f.project,d.id,d.digest);
 await assert.rejects(releaseArtifacts(f.project,d.id,new Set()),/Retire/);
 const blob=f.project+'-harness/artifacts/blobs/'+d.manifest.snapshot.sha256,bytes=await readFile(blob);await writeFile(blob,'corrupt');await assert.rejects(stageRelease(f.project,d.id),/hash|size/);assert.deepEqual(await readdir(f.destination),[]);await writeFile(blob,bytes);
 await symlink(f.root,d.manifest.target);await assert.rejects(stageRelease(f.project,d.id),/symlink|unsafe/);await rm(d.manifest.target);
 const {rename}=await import('node:fs/promises');await rename(f.destination,f.destination+'-old');await mkdir(f.destination);await assert.rejects(stageRelease(f.project,d.id),/destination changed/);assert.deepEqual(await readdir(f.destination),[]);
});
test('receipt conflicts and recognized pending links are reconciled without replacing foreign files',async t=>{
 const f=await fixture(t),d=await prepareRelease(f.project,{artifact:f.artifact.id,name:'notes',version:'1.0.0',destination:f.destination});await approveRelease(f.project,d.id,d.digest);
 await assert.rejects(stageRelease(f.project,d.id,async p=>{if(p==='reserved')throw Error('pause');}),/pause/);
 const {link}=await import('node:fs/promises');await link(d.manifest.target+'/owner.json',d.manifest.target+'/.pending-owner.json');
 await stageRelease(f.project,d.id);assert.ok(!(await readdir(d.manifest.target)).includes('.pending-owner.json'));
 const receipt=d.manifest.target+'/receipt.json';await writeFile(receipt,'wrong receipt');await assert.rejects(stageRelease(f.project,d.id),/changed|mismatch/);assert.equal(await readFile(receipt,'utf8'),'wrong receipt');
});
test('partial pending bytes are replaced only inside the owned staging directory',async t=>{
 const f=await fixture(t),d=await prepareRelease(f.project,{artifact:f.artifact.id,name:'notes',version:'1.0.0',destination:f.destination});await approveRelease(f.project,d.id,d.digest);
 await assert.rejects(stageRelease(f.project,d.id,async p=>{if(p==='reserved')throw Error('pause');}),/pause/);
 await writeFile(d.manifest.target+'/.pending-'+d.manifest.filename,'partial');await dryRunRelease(f.project,d.id);await stageRelease(f.project,d.id);
 assert.equal(await readFile(d.manifest.target+'/'+d.manifest.filename,'utf8'),'inert package bytes');assert.ok(!(await readdir(d.manifest.target)).some(n=>n.startsWith('.pending-')));
});
test('interrupted retirement keeps staging disabled and can finish reference cleanup',async t=>{
 const f=await fixture(t),d=await prepareRelease(f.project,{artifact:f.artifact.id,name:'notes',version:'1.0.0',destination:f.destination});
 const {chmod}=await import('node:fs/promises'),manifests=f.project+'-harness/artifacts/manifests';
 await chmod(manifests,0o500);try{await assert.rejects(retireRelease(f.project,d.id));}finally{await chmod(manifests,0o700);}
 const partial=await readRelease(f.project,d.id);assert.equal(partial.status,'retired');assert.notEqual(partial.retentionReleased,true);await assert.rejects(stageRelease(f.project,d.id),/retired/);
 await retireRelease(f.project,d.id);assert.equal((await readRelease(f.project,d.id)).retentionReleased,true);
});
