import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {type OperationRecord,parseLifecycleRecord} from '../src/reliability/lifecycle.ts';
import {updateOperationFile,retainLegacyRecord,readLegacyArchive} from '../src/reliability/compatibility.ts';
const h='a'.repeat(64);
const initial:OperationRecord={version:1,kind:'operation',id:'op-1',revision:0,binding:{taskId:'task-1',requirements:h,source:h,approval:null,runtime:h},phase:'preparing',status:'pending',outcome:'none',reservations:[],evidence:[]};
test('two actual writers cannot publish competing lifecycle transitions; stale retries preserve bytes',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'lifecycle-cas-')),project=root+'/app',state=project+'-harness';
 try {
  await mkdir(project);await mkdir(state);await writeFile(state+'/operation.json',JSON.stringify(initial));
  const module=new URL('../src/reliability/compatibility.ts',import.meta.url).href;
  const script=`import {updateOperationFile} from ${JSON.stringify(module)};try{await updateOperationFile(${JSON.stringify(project)},'operation.json',${JSON.stringify(initial)},{type:'start'});console.log('published')}catch(e){console.log('refused:'+e.message);process.exitCode=3}`;
  const child=()=>new Promise<{code:number|null;out:string}>((resolve,reject)=>{let out='';const p=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>out+=b);p.on('error',reject);p.on('close',code=>resolve({code,out}));});
  const results=await Promise.all([child(),child()]);
  assert.equal(results.filter(r=>r.code===0).length,1,JSON.stringify(results));
  assert.match(results.find(r=>r.code!==0)!.out,/locked|Stale/);
  const bytes=await readFile(state+'/operation.json','utf8'),current=parseLifecycleRecord(JSON.parse(bytes));
  assert.equal(current.revision,1);assert.equal(current.kind,'operation');
  await assert.rejects(updateOperationFile(project,'operation.json',initial,{type:'start'}),/Stale/);
  assert.equal(await readFile(state+'/operation.json','utf8'),bytes);
  assert.deepEqual(current.binding,initial.binding);
  if(current.kind!=='operation')assert.fail();
  const changed={...current,binding:{...current.binding,source:'b'.repeat(64)}};
  await assert.rejects(updateOperationFile(project,'operation.json',changed,{type:'reserve',requestId:'request-1'}),/binding|Stale/);
  const reserved=await updateOperationFile(project,'operation.json',current,{type:'reserve',requestId:'request-1'});
  const paused=await updateOperationFile(project,'operation.json',reserved,{type:'pause',outcome:'provider-interruption'});
  const restarted=JSON.parse(await readFile(state+'/operation.json','utf8')) as OperationRecord;
  assert.deepEqual(restarted,paused);
  const resumed=await updateOperationFile(project,'operation.json',restarted,{type:'start'});
  assert.deepEqual(resumed.reservations,['request-1']);
  await assert.rejects(updateOperationFile(project,'operation.json',resumed,{type:'reserve',requestId:'request-1'}),/duplicate/);
  await assert.rejects(updateOperationFile(project,'../outside.json',resumed,{type:'start'}),/path/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('legacy archives are idempotent, byte-preserving and never promote a projection into approval',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'lifecycle-legacy-'));
 try {
  const fixtures=JSON.parse(await readFile(new URL('./fixtures/lifecycle-legacy.json',import.meta.url),'utf8'));
  for(const {owner,original} of fixtures){
   const a=await retainLegacyRecord(root,owner,original),b=await retainLegacyRecord(root,owner,original);
   assert.equal(a,b);const archived=await readLegacyArchive(a);
   assert.equal(archived.original,original);assert.equal(archived.authority,'legacy-owner');
   assert.equal(archived.validation,'inspection-only');assert.ok(!('approved' in archived));
   const before=await readFile(a,'utf8');await retainLegacyRecord(root,owner,original);assert.equal(await readFile(a,'utf8'),before);
  }
  await assert.rejects(retainLegacyRecord(root,'stage','{"version":99}'),/version/);
  await assert.rejects(retainLegacyRecord(root,'preparation','{"version":1}'),/identity|state/);
  await assert.rejects(retainLegacyRecord(root,'features','not-json'),/JSON/);
  const a=await retainLegacyRecord(root,'features',fixtures[0].original);
  const bad=JSON.parse(await readFile(a,'utf8'));bad.original='[]';await writeFile(a,JSON.stringify(bad));
  await assert.rejects(readLegacyArchive(a),/digest/);
  await assert.rejects(retainLegacyRecord(root,'features',fixtures[0].original),/changed|digest/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('invalid transitions and unknown legacy versions cannot create or change state',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'lifecycle-invalid-')),project=root+'/app',state=project+'-harness';
 try{
  await mkdir(project);await mkdir(state);const original=JSON.stringify(initial);await writeFile(state+'/operation.json',original);
  for(const event of [{type:'start',approval:h},{type:'start',evidence:['invented']},null,{type:'reserve'},{type:'unknown'}]){
   await assert.rejects(updateOperationFile(project,'operation.json',initial,event as never));
   assert.equal(await readFile(state+'/operation.json','utf8'),original);
  }
  const archive=root+'/not-created';
  await assert.rejects(retainLegacyRecord(archive,'stage','{"version":99}'));
  await assert.rejects(readFile(archive),{code:'ENOENT'});
  await assert.rejects(retainLegacyRecord(archive,'unknown' as never,'{"version":1,"taskId":"t","plan":{}}'));
  await assert.rejects(readFile(archive),{code:'ENOENT'});
 }finally{await rm(root,{recursive:true,force:true});}
});
test('project aliases address the same owner record and legacy publication is exclusive',async()=>{
 const {symlink}=await import('node:fs/promises');
 const root=await mkdtemp(path.join(os.tmpdir(),'lifecycle-alias-')),project=root+'/app',state=project+'-harness';
 try{
  await mkdir(project);await mkdir(state);await writeFile(state+'/operation.json',JSON.stringify(initial));
  await symlink(project,root+'/alias');
  const current=await updateOperationFile(root+'/alias','operation.json',initial,{type:'start'});
  assert.equal(current.revision,1);assert.equal(JSON.parse(await readFile(state+'/operation.json','utf8')).revision,1);
  const original='[]\n';const paths=await Promise.all(Array.from({length:8},()=>retainLegacyRecord(root+'/archive','features',original)));
  assert.equal(new Set(paths).size,1);assert.equal((await readLegacyArchive(paths[0]!)).original,original);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('operation writes refuse hard links and nested symlinks without changing their targets',async()=>{
 const {symlink,link}=await import('node:fs/promises');
 const root=await mkdtemp(path.join(os.tmpdir(),'lifecycle-links-')),project=root+'/app',state=project+'-harness';
 try{
  await mkdir(project);await mkdir(state);await mkdir(root+'/outside');
  const original=JSON.stringify(initial);await writeFile(root+'/outside/operation.json',original);
  await symlink(root+'/outside',state+'/redirect');
  await assert.rejects(updateOperationFile(project,'redirect/operation.json',initial,{type:'start'}),/symlink|link/);
  await link(root+'/outside/operation.json',state+'/operation.json');
  await assert.rejects(updateOperationFile(project,'operation.json',initial,{type:'start'}),/link/);
  assert.equal(await readFile(root+'/outside/operation.json','utf8'),original);
 }finally{await rm(root,{recursive:true,force:true});}
});
