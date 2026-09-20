import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {approveChecks,requireChecks,verifyAcceptance} from '../src/acceptance/checks.ts';
import {captureBaseline} from '../src/workspace/candidate.ts';
import {loadConfig} from '../src/config.ts';
import {SERVER_DIGEST,SERVER_MODULE} from '../src/acceptance/server-runtime.ts';
const configured=!!process.env.HARNESS_IMAGE_ID&&!!process.env.HARNESS_DOCKER;
test('Docker: pinned read-only helper cleans Linux process groups, persists restarts and rejects wrong application output',{skip:configured?false:'configure Docker for helper verification'},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'helper-docker-'));const project=path.join(root,'project');await mkdir(project);
 const code=`import http from 'node:http';import fs from 'node:fs';import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});fs.writeFileSync('/work/child.pid',String(child.pid));const db=process.env.APP_DB;let n=fs.existsSync(db)?Number(fs.readFileSync(db,'utf8')):0;fs.writeFileSync(db,String(++n));const server=http.createServer((q,r)=>r.end(String(n)));process.on('SIGTERM',()=>{});server.listen(0,'127.0.0.1',()=>console.log('Listening at http://127.0.0.1:'+server.address().port));`;
 const probe=`import assert from 'node:assert/strict';import {readFile,writeFile,access} from 'node:fs/promises';import {withServer} from '${SERVER_MODULE}';let directory,pid;const observed=[];await assert.rejects(writeFile('${SERVER_MODULE}','bad'));await withServer({command:['node','app.js'],databaseEnv:'APP_DB',ready:/^Listening at (http:\\/\\/127\\.0\\.0\\.1:\\d+)$/,stopTimeoutMs:150},async app=>{directory=app.directory;observed.push(await(await fetch(app.url,{signal:AbortSignal.timeout(2000)})).text());await app.restart();observed.push(await(await fetch(app.url,{signal:AbortSignal.timeout(2000)})).text());pid=Number(await readFile('/work/child.pid','utf8'));});await assert.rejects(access(directory));let running=true;for(let i=0;i<40;i++){try{const state=(await readFile('/proc/'+pid+'/stat','utf8')).split(') ')[1][0];running=state!=='Z';}catch(e){if(e.code!=='ENOENT')throw e;running=false;}if(!running)break;await new Promise(r=>setTimeout(r,25));}assert.equal(running,false);console.log(observed.join(','));`;
 try{
  await writeFile(path.join(project,'package.json'),'{"type":"module"}');await writeFile(path.join(project,'app.js'),code);
  const input=path.join(root,'checks.json');await writeFile(input,JSON.stringify({version:1,cases:[{id:'server',tasks:['server'],steps:[{command:['node','--input-type=module','-e',probe],serverRuntime:SERVER_DIGEST,exitCode:0,stdout:'1,2\n'}]}]}));await approveChecks(project,input);
  const approved=await requireChecks(project,['server']);const config=loadConfig();const good=await captureBaseline(project,path.join(root,'good'));const result=await verifyAcceptance(project,good,['server'],config,approved);assert.equal(result.summaries.length,1);
  await writeFile(path.join(project,'app.js'),code.replace('r.end(String(n))','r.end("wrong")'));const bad=await captureBaseline(project,path.join(root,'bad'));await assert.rejects(verifyAcceptance(project,bad,['server'],config,approved),/did not match/);
  const evidence=JSON.parse(await readFile(result.evidencePath,'utf8'));assert.equal(evidence.observations[0].stdoutPreview,'1,2\n');
 }finally{await rm(root,{recursive:true,force:true});}
});
