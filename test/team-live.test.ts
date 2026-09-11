import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.ts";
import { assertRpcVersion, buildRpcArguments, RpcPeer, JsonLines, PI_RPC_VERSION } from "../src/agent/rpc.ts";
import { stopContainer } from "../src/containment/stop.ts";
import { createTeam, driveTeam } from "../src/team/controller.ts";
import { parseTeamPlan } from "../src/team/schema.ts";
import { readState } from "../src/team/state.ts";
import { readRecord } from "../src/record/record.ts";
import { processWorker } from "../src/team/worker.ts";
import { TeamControl, sendControl, readTelemetry } from "../src/team/control.ts";
import { readTeams } from "../src/view/status.ts";
import { withWriter } from "../src/workspace/writer-lock.ts";
import { run } from "../src/run.ts";
import { writeRpcFixture } from "./rpc-fixture.ts";
const configured=process.env.HARNESS_IMAGE_ID!==undefined&&process.env.HARNESS_DOCKER!==undefined;
const exec=promisify(execFile);

test("M6 Docker: installed pinned Pi supports the required correlated RPC controls without credentials",{skip:configured?false:'configure Docker for pinned RPC compatibility'},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pi-rpc-probe-'));const config=loadConfig(),name=`harness-probe-${randomUUID()}`;
 for(const d of ['work','agent'])await mkdir(path.join(root,d));
 await assertRpcVersion(config.piPackageDirectory);
 const args=buildRpcArguments({dockerExecutable:config.dockerExecutable,imageId:config.imageId,containerName:name,workDirectory:path.join(root,'work'),agentDirectory:path.join(root,'agent'),piPackageDirectory:config.piPackageDirectory,user:`${process.getuid?.()??501}:${process.getgid?.()??20}`},{goal:'unused',provider:undefined,model:undefined,timeoutMs:30000,skills:false});
 assert.equal(args.includes('--interactive'),true);assert.equal(args.includes('--tty'),false);
 const child=spawn(config.dockerExecutable,args,{stdio:['pipe','pipe','pipe']});let stderr='';const peer=new RpcPeer(v=>{child.stdin.write(JSON.stringify(v)+'\n');},()=>{},15000);const frames=new JsonLines(v=>peer.receive(v));
 child.stdout.on('data',(b:Buffer)=>{try{frames.push(b);}catch(e){peer.close(e as Error);}});child.stderr.on('data',(b:Buffer)=>{stderr+=b.toString();});child.on('error',e=>peer.close(e));child.stdin.on('error',e=>peer.close(e));const closed=new Promise<void>(resolve=>child.on('close',()=>{peer.close(Error(stderr));resolve();}));
 try{const state=await peer.request('get_state');assert.equal(state.data?.isStreaming,false);assert.equal(state.data?.pendingMessageCount,0);assert.equal((await peer.request('abort')).success,true);await assert.rejects(peer.request('clear_queue'),/Unknown command|unsupported/iu);assert.equal(PI_RPC_VERSION,'0.80.6');}
 finally{peer.close();child.kill('SIGKILL');await closed;await stopContainer(config.dockerExecutable,name);await rm(root,{recursive:true,force:true});}
});

test("M6 Docker: live CLI steering reaches the builder, preserves writer exclusion and reports builder plus reviewer usage",{skip:configured?false:'configure Docker for live steering'},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'team-live-'));const project=path.join(root,'project'),pi=path.join(root,'pi'),agent=path.join(root,'agent');
 for(const d of [path.join(project,'test'),path.join(pi,'dist'),agent])await mkdir(d,{recursive:true});
 await writeFile(path.join(project,'package.json'),JSON.stringify({type:'module',scripts:{test:'node --test test/*.test.mjs'}}));await writeFile(path.join(project,'test/works.test.mjs'),"import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';assert.equal(readFileSync('result.txt','utf8'),'steered');");
 await writeRpcFixture(pi,`const fs=require('node:fs');if(process.argv.includes('read,grep'))console.log(JSON.stringify({verdict:'pass',unmet:[],unaccounted:[],notes:[]}));else{if(!process.argv.at(-1).includes('use steered'))throw Error('missing steering');fs.writeFileSync('result.txt','steered');fs.writeFileSync('.harness-claim.json',JSON.stringify({files:['result.txt'],deletions:[],criteria:[{criterion:'works',verifiedBy:'test/works.test.mjs'}]}));console.log(JSON.stringify({type:'turn_end',message:{provider:'fixture',model:'fixture',usage:{totalTokens:7,cost:{total:0.01}}}}));}`);
 const tasks=[{id:'one',title:'WAIT_FOR_STEER',criteria:['works'],priority:'must' as const,status:'todo' as const,dependsOn:[]}];await writeFile(path.join(project,'features.json'),JSON.stringify(tasks));
 const dir=await createTeam(project,parseTeamPlan({version:1,roles:[{id:'b',instructions:'build',skills:[]}],skills:[]},tasks),root,{maxAttempts:1,maxDispatches:1,maxMs:60000,maxCostUsd:1});const control=await TeamControl.start(dir);const config={...loadConfig(),piPackageDirectory:pi,agentDirectory:agent,provider:'fixture',model:'fixture',agentTimeoutMs:30000};
 const driven=withWriter(project,'team test',()=>driveTeam(dir,processWorker(config,dir,['npm','test'],()=>{},control),control));void driven.catch(()=>{});
 try{
  let attempt;for(let i=0;i<600;i++){attempt=(await readState(dir,false)).attempts[0];if(attempt&&await readFile(path.join(attempt.directory,'agent/ready')).then(()=>true,()=>false))break;await delay(25);}assert.ok(attempt);assert.equal(await readFile(path.join(attempt.directory,'agent/ready'),'utf8'),'yes');
  await assert.rejects(withWriter(project,'other',async()=>{}),/locked/u);
  const response=await exec(process.execPath,[path.resolve('src/cli.ts'),'team','steer',attempt.id,'use steered'],{env:{...process.env,HARNESS_PROJECT:project}});assert.match(response.stdout,/acknowledged/u);
  const state=await driven;assert.equal(state.status,'staged');assert.equal(state.usage.tokens,8);assert.equal(state.usage.costUsd,0.01);
  const events=await readTelemetry(dir);assert.equal(events.filter(e=>e.type==='steer-delivered').length,1);const status=(await readTeams(project))[0]!;assert.deepEqual(status.attempts[0]!.models.map(m=>m.role).sort(),['builder','reviewer']);assert.equal(status.tokens,8);
  await assert.rejects(readFile(path.join(project,'result.txt')),{code:'ENOENT'});await assert.rejects(readFile(path.join(attempt.directory,'agent/auth.json')),{code:'ENOENT'});
 }finally{if(!(await readState(dir,false)).finishedAt)await sendControl(dir,{type:'abort'}).catch(()=>{});await driven.catch(()=>{});await control.close();await rm(root,{recursive:true,force:true});}
});

test("M6 Docker: abort discards queued work and removes only owned containers without applying",{skip:configured?false:'configure Docker for live abort'},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'team-live-abort-')),project=path.join(root,'project'),pi=path.join(root,'pi'),agent=path.join(root,'agent');
 for(const d of [project,path.join(pi,'dist'),agent])await mkdir(d,{recursive:true});await writeRpcFixture(pi,"require('node:fs').writeFileSync('/pi-agent/ready','yes');setInterval(()=>{},1000);");
 const tasks=[{id:'one',title:'WAIT_FOR_KILL',criteria:['works'],priority:'must' as const,status:'todo' as const,dependsOn:[]}];await writeFile(path.join(project,'features.json'),JSON.stringify(tasks));const dir=await createTeam(project,parseTeamPlan({version:1,roles:[{id:'b',instructions:'build',skills:[]}],skills:[]},tasks),root,{maxAttempts:1,maxDispatches:2,maxMs:60000,maxCostUsd:1});
 const config={...loadConfig(),piPackageDirectory:pi,agentDirectory:agent},foreign=`harness-unrelated-${randomUUID()}`;
 const started=await run(config.dockerExecutable,['run','--detach','--rm','--pull=never',`--name=${foreign}`,`--label=io.harness.run=${path.basename(dir)}`,'--label=io.harness.attempt=not-our-attempt',config.imageId,'node','-e','setInterval(()=>{},1000)'],{timeoutMs:15000});assert.equal(started.code,0,started.stderr);
 const control=await TeamControl.start(dir),driven=driveTeam(dir,processWorker(config,dir,['npm','test'],()=>{},control),control);void driven.catch(()=>{});
 try{
  let attempt;for(let i=0;i<600;i++){attempt=(await readState(dir,false)).attempts[0];if(attempt&&await readFile(path.join(attempt.directory,'agent/ready')).then(()=>true,()=>false))break;await delay(25);}assert.ok(attempt);assert.equal(await readFile(path.join(attempt.directory,'agent/ready'),'utf8'),'yes');
  await sendControl(dir,{type:'steer',attemptId:attempt.id,message:'queued work'});
  const response=await exec(process.execPath,[path.resolve('src/cli.ts'),'team','abort',path.basename(dir)],{env:{...process.env,HARNESS_PROJECT:project}});assert.match(response.stdout,/abort-requested/u);
  const state=await driven;assert.equal(state.status,'aborted');assert.equal(state.attempts.length,1);assert.deepEqual(state.integrated,[]);assert.equal((await readRecord(project)).runs.length,0);
  const own=await run(config.dockerExecutable,['ps','--all','--quiet','--filter',`label=io.harness.attempt=${attempt.id}`],{timeoutMs:15000});assert.equal(own.stdout.trim(),'');const other=await run(config.dockerExecutable,['inspect','--format','{{.State.Running}}',foreign],{timeoutMs:15000});assert.equal(other.stdout.trim(),'true');
 }finally{if(!control.aborting)await sendControl(dir,{type:'abort'}).catch(()=>{});await driven.catch(()=>{});await control.close();await stopContainer(config.dockerExecutable,foreign);await rm(root,{recursive:true,force:true});}
});
