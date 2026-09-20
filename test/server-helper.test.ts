import assert from 'node:assert/strict';
import test from 'node:test';
import {access, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once, EventEmitter} from 'node:events';
import {withServer, stopProcess} from '../src/acceptance/runtime/server.mjs';

const ready = /^Listening at (http:\/\/127\.0\.0\.1:\d+)$/;
const script = `import http from 'node:http';import fs from 'node:fs';const file=process.env.TEST_DB;let n=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8')):0;fs.writeFileSync(file,String(++n));const s=http.createServer((q,r)=>r.end(String(n)));s.listen(0,'127.0.0.1',()=>console.log('Listening at http://127.0.0.1:'+s.address().port));`;
const options = {command:[process.execPath,'--input-type=module','-e',script],cwd:process.cwd(),databaseEnv:'TEST_DB',ready,startTimeoutMs:1500,stopTimeoutMs:150};
const dead = (pid:number) => assert.throws(()=>process.kill(pid,0),/ESRCH/);
test('server helper restarts against the same isolated database and removes data and children',async()=>{
 let dir='', first=0, second=0;
 await withServer(options,async app=>{
  dir=app.directory;first=app.pid;
  assert.equal(await (await fetch(app.url)).text(),'1');
  await app.restart();second=app.pid;
  assert.notEqual(second,first);dead(first);
  assert.equal(await (await fetch(app.url)).text(),'2');
  assert.equal(await readFile(app.database,'utf8'),'2');
  assert.match(app.stdout,/Listening at/);
 });
 dead(first);dead(second);await assert.rejects(access(dir),/ENOENT/);
});
test('callback errors still terminate the server and remove its database',async()=>{
 let pid=0, dir='';
 await assert.rejects(withServer(options,async app=>{pid=app.pid;dir=app.directory;throw Error('assertion failed');}),/assertion failed/);
 dead(pid);await assert.rejects(access(dir),/ENOENT/);
});
test('readiness timeout and spawn failure reject promptly and clean isolated data',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'helper-start-'));
 try{
  const pidfile=path.join(root,'pid');const dbfile=path.join(root,'db');
  const code=`require('fs').writeFileSync(${JSON.stringify(pidfile)},String(process.pid));require('fs').writeFileSync(${JSON.stringify(dbfile)},process.env.TEST_DB);setInterval(()=>{},1000);`;
  await assert.rejects(withServer({...options,command:[process.execPath,'-e',code],startTimeoutMs:300},async()=>assert.fail('not ready')),/readiness.*timed out/i);
  dead(Number(await readFile(pidfile,'utf8')));await assert.rejects(access(path.dirname(await readFile(dbfile,'utf8'))),/ENOENT/);
  await assert.rejects(withServer({...options,command:['/no-such-harness-server']},async()=>assert.fail('spawn failed')),/ENOENT/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('SIGTERM-resistant server is killed; signal-exited children never wait for a missed event',async()=>{
 let pid=0;
 await withServer({...options,command:[process.execPath,'--input-type=module','-e',`process.on('SIGTERM',()=>{});${script}`]},async app=>{pid=app.pid;});dead(pid);
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);const exited=once(child,'exit');child.kill('SIGKILL');await exited;
 const start=Date.now();await stopProcess(child,{timeoutMs:100});assert.ok(Date.now()-start<500);
});
test('unconfirmed SIGKILL fails within the deadline and releases pipe handles',async()=>{
 const child=new EventEmitter() as any;child.exitCode=null;child.signalCode=null;child.pid=undefined;
 let kills=0, released=0;child.kill=()=>{kills++;return true;};child.unref=()=>{released++;};
 child.stdout={destroy:()=>{released++;}};child.stderr={destroy:()=>{released++;}};
 await assert.rejects(stopProcess(child,{timeoutMs:20}),/exit was not observed/);
 assert.equal(kills,2);assert.equal(released,3);assert.equal(child.listenerCount('exit'),0);
});
test('output overflow is a failure rather than silent truncation',async()=>{
 await assert.rejects(withServer({...options,maxOutputBytes:256,command:[process.execPath,'-e',`process.stdout.write('x'.repeat(1024));setInterval(()=>{},1000);`]},async()=>assert.fail('not ready')),/output limit/);
});
test('output limits also apply during shutdown after application observations finish',async()=>{
 await assert.rejects(withServer({...options,maxOutputBytes:256,command:[process.execPath,'--input-type=module','-e',`process.on('SIGTERM',()=>{process.stdout.write('x'.repeat(1024));});${script}`]},async()=>{}),/output limit/);
});
