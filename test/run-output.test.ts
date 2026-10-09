import assert from "node:assert/strict";
import test from "node:test";
import { run } from "../src/run.ts";
test("bounded capture refuses oversized output even if the child exits successfully", async () => {
 const result=await run(process.execPath,["-e","process.stdout.write('x'.repeat(100000))"],{timeoutMs:5000,maxOutputBytes:4096});
 assert.equal(result.outputLimited,true);assert.ok(Buffer.byteLength(result.stdout)<=4096);
});
test("bounded capture preserves Unicode split across output chunks", async () => {
 const result=await run(process.execPath,["-e","process.stdout.write(Buffer.from([0xe2]));setTimeout(()=>process.stdout.write(Buffer.from([0x82,0xac])),50)"],{timeoutMs:5000,maxOutputBytes:4096});
 assert.equal(result.code,0);assert.equal(result.stdout,"€");assert.ok(!result.outputLimited);
});

test('the default limits continuous output and cannot return successful truncated evidence',async()=>{
 const result=await run(process.execPath,['-e','process.on("SIGTERM",()=>{});let n=0;function flood(){if(n++<256){process.stdout.write("x".repeat(65536));process.stderr.write("y".repeat(65536));setImmediate(flood)}}flood();setInterval(()=>{},1000)'],{timeoutMs:5000});
 assert.equal(result.outputLimited,true);assert.notEqual(result.code,0);assert.equal(result.timedOut,false);
 assert.ok(Buffer.byteLength(result.stdout)+Buffer.byteLength(result.stderr)<=8*1024*1024);
});
test('invalid and unlimited overrides fail before launching a process',async()=>{
 for(const value of [NaN,Infinity,0,-1,1.5,128*1024*1024])await assert.rejects(async()=>run(process.execPath,['-e','throw Error("must not run")'],{timeoutMs:5000,maxOutputBytes:value}),/limit|bound/i);
});
test('overflow retains a bounded Unicode head and tail, and callback exceptions stop the child',async()=>{
 const result=await run(process.execPath,['-e','process.stdout.write("HEAD"+"€".repeat(20000)+"TAIL")'],{timeoutMs:5000,maxOutputBytes:4096});
 assert.equal(result.outputLimited,true);assert.notEqual(result.code,0);assert.ok(result.stdout.startsWith('HEAD'));assert.ok(Buffer.byteLength(result.stdout)<=4096);assert.ok(!result.stdout.includes('\uFFFD'));
 const start=Date.now();await assert.rejects(run(process.execPath,['-e','process.stdout.write("hello");setInterval(()=>{},1000)'],{timeoutMs:5000,onOutput:()=>{throw Error('callback failed')}}),/callback failed/);assert.ok(Date.now()-start<4000);
});

test('exclusive diagnostic storage is private and quota bounded on both streams',async()=>{
 const {mkdtemp,readFile,rm,stat}=await import('node:fs/promises');const {tmpdir}=await import('node:os');
 const root=await mkdtemp(tmpdir()+'/run-diagnostics-'),file=root+'/output.log';
 try{
  const result=await run(process.execPath,['-e','process.stdout.write("START");process.stderr.write("€".repeat(20000))'],{timeoutMs:5000,maxOutputBytes:4096,diagnosticFile:file});
  assert.equal(result.outputLimited,true);assert.equal(result.termination,'output-limit');assert.notEqual(result.code,0);
  const info=await stat(file);assert.equal(info.mode&0o777,0o600);assert.ok(info.size<=4096);assert.equal(result.diagnosticBytes,info.size);
  const before=await readFile(file);await assert.rejects(run(process.execPath,['-e','process.stdout.write("overwrite")'],{timeoutMs:5000,diagnosticFile:file}),{code:'EEXIST'});assert.deepEqual(await readFile(file),before);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('overflow kills owned descendants that hold pipes open',{skip:process.platform==='win32'},async()=>{
 const {mkdtemp,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');
 const root=await mkdtemp(tmpdir()+'/run-descendants-'),file=root+'/heartbeat';
 try{
  const grandchild=`const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(${JSON.stringify(file)},'x'),20);console.log('ready')`;
  const script=`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','pipe','inherit']});c.stdout.once('data',()=>{process.stdout.write('x'.repeat(100000));});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
  const result=await run(process.execPath,['-e',script],{timeoutMs:5000,maxOutputBytes:4096});assert.equal(result.outputLimited,true);assert.equal(result.timedOut,false);
  await new Promise(r=>setTimeout(r,100));const before=await readFile(file,'utf8').catch(()=> '');await new Promise(r=>setTimeout(r,100));assert.equal(await readFile(file,'utf8').catch(()=>''),before);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('diagnostic write failure yields incomplete output rather than a successful reply',async()=>{
 const {mkdtemp,rm,stat}=await import('node:fs/promises');const {tmpdir}=await import('node:os');
 const root=await mkdtemp(tmpdir()+'/run-disk-failure-');
 try{
  const script=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {run} from ${JSON.stringify(new URL('../src/run.ts',import.meta.url).href)};const original=fs.writeSync;let calls=0;fs.writeSync=(fd,b,off,len)=>{if(calls++>0)throw Error('fixture disk full');return original(fd,b,off,Math.min(len,10));};syncBuiltinESMExports();const r=await run(process.execPath,['-e','process.stdout.write("x".repeat(10000));setInterval(()=>{},1000)'],{timeoutMs:3000,diagnosticFile:${JSON.stringify(root+'/log')}});console.log(JSON.stringify(r));`;
  const result=await run(process.execPath,['--input-type=module','-e',script],{timeoutMs:5000});assert.equal(result.code,0);
  const observed=JSON.parse(result.stdout);assert.equal(observed.outputLimited,true);assert.notEqual(observed.code,0);assert.match(observed.outputProblem,/fixture disk full/);
  assert.equal(observed.diagnosticBytes,10);assert.equal((await stat(root+'/log')).size,10);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('F07 subprocess output is bounded by default',async()=>{
 const result=await run(process.execPath,['-e','process.stdout.write("x".repeat(16*1024*1024))'],{timeoutMs:10000});
 assert.equal(result.outputLimited,true,'the proposed default capture ceiling must stop a bounded 16 MiB flood');
 assert.ok(Buffer.byteLength(result.stdout)+Buffer.byteLength(result.stderr)<16*1024*1024);
});

test('a group-signal race falls back to the owned child and waits for natural close',async()=>{
 const script=`import {run} from ${JSON.stringify(new URL('../src/run.ts',import.meta.url).href)};const original=process.kill;process.kill=(pid,signal)=>{if(pid<0)throw Object.assign(Error('fixture group EPERM'),{code:'EPERM'});return original(pid,signal)};const result=await run(process.execPath,['-e','process.stdout.write("x".repeat(100000));setInterval(()=>{},1000)'],{timeoutMs:3000,maxOutputBytes:4096});console.log(JSON.stringify(result));`;
 const execution=await run(process.execPath,['--input-type=module','-e',script],{timeoutMs:5000});assert.equal(execution.code,0,execution.stderr);
 const result=JSON.parse(execution.stdout);assert.equal(result.outputLimited,true);assert.equal(result.timedOut,false);assert.notEqual(result.code,0);
});

test('verification launchers reject oversized reports even when the child exits zero',async()=>{
 const {verificationProcess}=await import('../src/verification-process.ts');
 await assert.rejects(verificationProcess(['-e','process.stdout.write("x".repeat(16*1024*1024))'],process.env,()=>{}),/output-limit/);
 const complete=await verificationProcess(['-e','console.log("observed")'],process.env,()=>{});
 assert.equal(complete.code,0);assert.equal(complete.stdout,'observed\n');
});
