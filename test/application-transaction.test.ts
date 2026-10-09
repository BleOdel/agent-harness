import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm,stat,chmod} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {captureBaseline} from '../src/workspace/candidate.ts';
import {beginApplication,finishApplication,recoverPendingApplication} from '../src/workspace/application.ts';
import {readRecord,harnessDirectory} from '../src/record/record.ts';
import {withWriter} from '../src/workspace/writer-lock.ts';
const before='[{"id":"task","title":"Task","status":"todo","priority":"must","criteria":["works"],"dependsOn":[]}]\n',after=before.replace('todo','done');
async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),'application-transaction-')),project=root+'/project',candidate=root+'/candidate';await mkdir(project);await mkdir(candidate);await writeFile(project+'/features.json',before);for(const f of ['a','b']){await writeFile(project+'/'+f,'before');await writeFile(candidate+'/'+f,'after');}await chmod(candidate+'/b',0o755);const baseline=await captureBaseline(project,root+'/baseline');return {root,project,candidate,baseline,close:()=>rm(root,{recursive:true,force:true})};}
for(const point of ['intent','prepared:a','replaced:a','write:a','prepared:b','replaced:b','write:b','sources','prepared:features.json','features','record','event','complete'])test(`application recovery after ${point} publishes source, modes, features and one record`,async()=>{
 const f=await fixture();try{await assert.rejects(withWriter(f.project,'test',async()=>{const i=await beginApplication(f.project,{source:f.candidate,expected:f.baseline,featuresAfter:after,record:{id:'r1',at:'2026-10-09T00:00:00Z',project:f.project,goal:'task',attempts:1,outcome:'applied',changes:[],gates:[]}});await finishApplication(i,{checkpoint:p=>{if(p===point)throw Error('injected');}});}),/injected/);
 await recoverPendingApplication(f.project);await recoverPendingApplication(f.project);
 assert.equal(await readFile(f.project+'/a','utf8'),'after');assert.equal(await readFile(f.project+'/b','utf8'),'after');assert.equal((await stat(f.project+'/b')).mode&0o111,0o111);assert.equal(await readFile(f.project+'/features.json','utf8'),after);assert.equal((await readRecord(f.project)).runs.length,1);
 }finally{await f.close();}
});
test('second-file EACCES remains recoverable and rollback preserves source and requirements',async()=>{const f=await fixture();try{
 await assert.rejects(withWriter(f.project,'test',async()=>{const i=await beginApplication(f.project,{source:f.candidate,expected:f.baseline,featuresAfter:after,record:{id:'r1',at:'now',project:f.project,goal:'task',attempts:1,outcome:'applied',changes:[],gates:[]}});await finishApplication(i,{checkpoint:p=>{if(p==='prepared:b')throw Object.assign(Error('injected EACCES'),{code:'EACCES'});}});}),/EACCES/);
 await assert.rejects(withWriter(f.project,'competing',async()=>{}),/recovery/);
 await recoverPendingApplication(f.project,{rollback:true});for(const file of ['a','b'])assert.equal(await readFile(f.project+'/'+file,'utf8'),'before');assert.equal(await readFile(f.project+'/features.json','utf8'),before);assert.equal((await readRecord(f.project)).runs.length,0);
 }finally{await f.close();}});
for(const edit of ['bytes','mode','features'])test(`recovery refuses unrelated ${edit} changes`,async()=>{const f=await fixture();try{
 await assert.rejects(withWriter(f.project,'test',async()=>{const i=await beginApplication(f.project,{source:f.candidate,expected:f.baseline,featuresAfter:after,record:{id:'r1',at:'now',project:f.project,goal:'task',attempts:1,outcome:'applied',changes:[],gates:[]}});await finishApplication(i,{checkpoint:p=>{if(p==='write:a')throw Error('crash');}});}),/crash/);
 if(edit==='bytes')await writeFile(f.project+'/a','human');else if(edit==='mode')await chmod(f.project+'/a',0o755);else await writeFile(f.project+'/features.json',before+' ');
 await assert.rejects(recoverPendingApplication(f.project,{rollback:true}),/External change/);assert.equal((await readRecord(f.project)).runs.length,0);assert.ok(await stat(harnessDirectory(f.project)+'/application.json'));
 }finally{await f.close();}});

test('journalled ordinary undo and undo-of-undo restore executable modes and task state',async()=>{
 const {undo}=await import('../src/verbs/undo.ts');const f=await fixture();try{
 await withWriter(f.project,'test',async()=>{const i=await beginApplication(f.project,{source:f.candidate,expected:f.baseline,featuresAfter:after,record:{id:'r1',at:'now',project:f.project,goal:'task',attempts:1,outcome:'applied',changes:[],gates:[]}});await finishApplication(i);});
 await undo(f.project,['r1']);assert.equal(await readFile(f.project+'/b','utf8'),'before');assert.equal((await stat(f.project+'/b')).mode&0o111,0);assert.equal(JSON.parse(await readFile(f.project+'/features.json','utf8'))[0].status,'todo');
 await undo(f.project,['r2']);assert.equal(await readFile(f.project+'/b','utf8'),'after');assert.equal((await stat(f.project+'/b')).mode&0o111,0o111);assert.equal(JSON.parse(await readFile(f.project+'/features.json','utf8'))[0].status,'done');
 const records=(await readRecord(f.project)).runs;assert.equal(records.length,3);for(const record of records)assert.ok(record.transactionId);
 }finally{await f.close();}
});
for(const point of ['intent','prepared:a','replaced:a','write:a','prepared:b','replaced:b','write:b','sources','prepared:features.json','features','record','event','complete'])test(`fresh-process recovery survives SIGKILL at ${point}`,async()=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');const execute=promisify(execFile);const f=await fixture();
 try{
  const module=new URL('../src/workspace/application.ts',import.meta.url).href,writer=new URL('../src/workspace/writer-lock.ts',import.meta.url).href;
  const input={project:f.project,source:f.candidate,expected:f.baseline,featuresAfter:after,record:{id:'r1',at:'now',project:f.project,goal:'task',attempts:1,outcome:'applied',changes:[],gates:[]}};
  const script=`import {beginApplication,finishApplication} from ${JSON.stringify(module)};import {withWriter} from ${JSON.stringify(writer)};const input=JSON.parse(process.argv[1]);await withWriter(input.project,'test',async()=>{const i=await beginApplication(input.project,input);await finishApplication(i,{checkpoint:p=>{if(p===process.argv[2])process.kill(process.pid,'SIGKILL');}});});`;
  await assert.rejects(execute(process.execPath,['--input-type=module','-e',script,JSON.stringify(input),point]),(e:any)=>e.signal==='SIGKILL');
  const lock=JSON.parse(await readFile(f.project+'-harness.writer-lock','utf8'));
  const recover=`import {recoverWriter} from ${JSON.stringify(writer)};import {recoverPendingApplication} from ${JSON.stringify(module)};await recoverWriter(process.argv[1],process.argv[2]);await recoverPendingApplication(process.argv[1]);`;
  await execute(process.execPath,['--input-type=module','-e',recover,f.project,lock.token]);assert.equal((await readRecord(f.project)).runs.length,1);assert.equal(await readFile(f.project+'/features.json','utf8'),after);assert.equal(await readFile(f.project+'/b','utf8'),'after');assert.equal((await stat(f.project+'/b')).mode&0o111,0o111);
 }finally{await f.close();}
});

test('a persisted rollback continues without reauthorizing a forward product binding',async()=>{
 const f=await fixture();try{
  const i=await withWriter(f.project,'test',()=>beginApplication(f.project,{source:f.candidate,expected:f.baseline,featuresAfter:after,record:{id:'r1',at:'now',project:f.project,goal:'task',attempts:1,outcome:'applied',changes:[],gates:[]}}));
  await assert.rejects(finishApplication(i,{checkpoint:p=>{if(p==='write:a')throw Error('crash');}}),/crash/);
  await assert.rejects(recoverPendingApplication(f.project,{rollback:true,checkpoint:p=>{if(p==='write:a')throw Error('rollback crash');}}),/rollback crash/);
  // Model a retained forward pin whose product is no longer installed. Only
  // reversal to the original source is allowed by the saved rollback decision.
  const intentPath=harnessDirectory(f.project)+'/applications/'+i.id+'/intent.json',saved=JSON.parse(await readFile(intentPath,'utf8'));saved.before.productDigest='a'.repeat(64);
  const {digest}=await import('../src/team/schema.ts');await writeFile(intentPath,JSON.stringify(saved));await writeFile(harnessDirectory(f.project)+'/application.json',JSON.stringify({version:2,id:i.id,intentDigest:digest(saved)}));
  await recoverPendingApplication(f.project);assert.equal(await readFile(f.project+'/a','utf8'),'before');assert.equal((await readRecord(f.project)).runs.length,0);
 }finally{await f.close();}
});
