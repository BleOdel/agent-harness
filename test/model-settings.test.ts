import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveModelSettings, parseEffort } from '../src/model-settings.ts';
import { buildAgentCommand } from '../src/agent/pi.ts';
import { buildPlanCommand } from '../src/verbs/plan.ts';
import { buildReviewCommand } from '../src/review/reviewer.ts';
test('reasoning defaults to medium, validates names and honours environment over saved settings', async () => {
 const root=await mkdtemp(path.join(os.tmpdir(),'model-settings-')); const project=path.join(root,'app'); await mkdir(project); await mkdir(project+'-harness');
 try {
  assert.equal(resolveModelSettings(project,{}).effort,'medium');
  await writeFile(path.join(project+'-harness','model.json'),JSON.stringify({version:1,provider:'openai-codex',model:'example',effort:'high'}));
  assert.equal(resolveModelSettings(project,{}).effort,'high');
  const override=resolveModelSettings(project,{HARNESS_REASONING_EFFORT:'low'});
  assert.equal(override.effort,'low'); assert.equal(override.sources.effort,'environment/config file');
  assert.throws(()=>parseEffort('turbo'),/reasoning effort/i);
 } finally { await rm(root,{recursive:true,force:true}); }
});
test('all agent launchers explicitly pass reasoning effort',()=>{
 const request={goal:'task',provider:'openai-codex',model:'example',effort:'high' as const,timeoutMs:100,skills:false};
 const commands=[buildAgentCommand(request),buildPlanCommand({...request,topic:'topic',skills:[],skillsConfigured:false}),buildReviewCommand({...request,title:'Review',criteria:[],diff:''})];
 for(const command of commands) assert.equal(command[command.indexOf('--thinking')+1],'high');
});

import { supportedEfforts, assertModelEffort } from '../src/model-settings.ts';
test('installed Pi catalog adapter refuses unknown models and unsupported effort',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pi-catalog-'));
 try {
  const dist=path.join(root,'node_modules/@earendil-works/pi-ai/dist');await mkdir(dist,{recursive:true});
  await writeFile(path.join(dist,'compat.js'),"exports.getModel=(p,id)=>p==='fixture'&&id==='fixture'?{id}:undefined;exports.getSupportedThinkingLevels=()=>['medium','high'];");
  assert.deepEqual(await supportedEfforts(root,'fixture','fixture'),['medium','high']);
  await assert.rejects(assertModelEffort(root,{provider:'fixture',model:'missing',effort:'high'}),/not in the installed/);
  await assert.rejects(assertModelEffort(root,{provider:'fixture',model:'fixture',effort:'max'}),/does not support/);
 }finally{await rm(root,{recursive:true,force:true});}
});

import { modelCommand } from '../src/verbs/model.ts';
test('model setup saves supported strength and explains conflicting overrides',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'model-guide-'));const project=path.join(root,'app');await mkdir(project);
 const dist=path.join(root,'node_modules/@earendil-works/pi-ai/dist');await mkdir(dist,{recursive:true});
 await writeFile(path.join(dist,'compat.js'),"exports.getModel=()=>({id:'fixture'});exports.getSupportedThinkingLevels=()=>['medium','high'];");
 const keys=['HARNESS_PROVIDER','HARNESS_MODEL','HARNESS_REASONING_EFFORT','HARNESS_PI_PACKAGE','HARNESS_AGENT_DIR'] as const;
 const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{HARNESS_PROVIDER:'fixture',HARNESS_MODEL:'fixture',HARNESS_REASONING_EFFORT:'medium',HARNESS_PI_PACKAGE:root});delete process.env.HARNESS_AGENT_DIR;
 const lines:string[]=[];const answers=['','','2','y'];
 try {
  await modelCommand(project,['setup'],{write:s=>{lines.push(s);},ask:async()=>answers.shift()!});
  assert.equal(resolveModelSettings(project,{}).effort,'high');
  assert.equal(resolveModelSettings(project).effort,'medium');
  assert.match(lines.join('\n'),/HARNESS_REASONING_EFFORT currently overrides/);
 }finally{for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}await rm(root,{recursive:true,force:true});}
});
