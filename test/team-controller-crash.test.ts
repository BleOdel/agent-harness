import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createTeam, recoverTeam } from "../src/team/controller.ts";
import { parseTeamPlan } from "../src/team/schema.ts";
import { readTeams } from "../src/view/status.ts";
import { sendControl } from "../src/team/control.ts";

test("SIGKILL preserves steering and spend; a new process projection detects death and explicit recovery removes the owned socket",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'m6-controller-crash-')),project=path.join(root,'project');await mkdir(project);
 const tasks=[{id:'one',title:'one',criteria:['works'],priority:'must' as const,status:'todo' as const,dependsOn:[]}];await writeFile(path.join(project,'features.json'),JSON.stringify(tasks));
 const dir=await createTeam(project,parseTeamPlan({version:1,roles:[{id:'b',instructions:'build',skills:[]}],skills:[]},tasks),root,{maxAttempts:1,maxDispatches:2,maxMs:60000,maxCostUsd:1});
 const module=(name:string)=>new URL(`../src/${name}.ts`,import.meta.url).href;
 const program=`import {TeamControl} from ${JSON.stringify(module('team/control'))};import {driveTeam} from ${JSON.stringify(module('team/controller'))};import {emptyUsage} from ${JSON.stringify(module('agent/events'))};import {writeFile} from 'node:fs/promises';
const dir=${JSON.stringify(dir)},c=await TeamControl.start(dir);await driveTeam(dir,{async execute(a){await c.record({type:'phase',attemptId:a.id,phase:'building',modelRole:'builder'});await c.record({type:'usage',attemptId:a.id,modelRole:'builder',usage:{...emptyUsage(),totalTokens:17,costUsd:0.03,turns:1}});c.register(a.id,{async steer(message){c.observe(a.id,{type:'message_start',message:{role:'user',content:message}})}});await writeFile(${JSON.stringify(path.join(root,'ready'))},a.id);await new Promise(()=>{});},async verify(){throw Error('unused')},async verifyIntegration(){throw Error('unused')},async cleanup(){}},c);`;
 const child=spawn(process.execPath,['--input-type=module','-e',program],{stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',(b:Buffer)=>{stderr+=b.toString();});const closed=new Promise(resolve=>child.once('close',resolve));
 try{
  let id='';for(let i=0;i<200;i++){id=await readFile(path.join(root,'ready'),'utf8').catch(()=> '');if(id)break;await delay(20);}assert.ok(id,stderr);
  await sendControl(dir,{type:'steer',attemptId:id,message:'retain this instruction'});assert.equal((await readTeams(project))[0]!.live,true);
  const meta=JSON.parse(await readFile(path.join(dir,'controller.json'),'utf8'));
  child.kill('SIGKILL');await closed;
  const after=(await readTeams(project))[0]!;assert.equal(after.live,false);assert.equal(after.status,'interrupted');assert.equal(after.tokens,17);assert.equal(after.costUsd,0.03);assert.equal(after.steering[0]!.state,'delivered');
  let cleaned=0;const state=await recoverTeam(dir,{async cleanup(){cleaned++;}});assert.equal(cleaned,1);assert.equal(state.status,'stopped');assert.equal(state.attempts[0]!.status,'interrupted');
  await assert.rejects(readFile(path.join(path.dirname(meta.socket),'owner.json')),{code:'ENOENT'});assert.equal(JSON.parse(await readFile(path.join(dir,'controller.json'),'utf8')).active,false);
 }finally{child.kill('SIGKILL');await closed;await rm(root,{recursive:true,force:true});}
});
