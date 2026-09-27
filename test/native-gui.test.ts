import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMacJourney,guiActions,assessMacJourney} from '../src/native/gui/schema.ts';
const journey={version:1,title:'Save a note',timeoutSeconds:180,steps:[{action:'fill',selector:'#note',value:'Hello'},{action:'press',selector:'#note',key:'Enter'},{action:'restart'},{action:'text',selector:'#notes li',expected:'Hello'},{action:'screenshot'}]};
test('macOS GUI journeys bound screenshots and keep expected values on the host',()=>{
 assert.deepEqual(parseMacJourney(journey),journey);
 assert.ok(!JSON.stringify(guiActions(parseMacJourney(journey))).includes('expected'));
 assert.throws(()=>parseMacJourney({...journey,steps:[...journey.steps,...Array.from({length:4},()=>({action:'screenshot'}))]}),/screenshots/);
 assert.throws(()=>parseMacJourney({...journey,steps:[{action:'screenshot'}]}),/expected/);
});
test('macOS GUI comparison rejects missing restart evidence, wrong text and unpackaged runs',()=>{
 const spec=parseMacJourney(journey);const report={version:1,packaged:true,steps:[{action:'fill'},{action:'press'},{action:'restart'},{action:'text',values:['Hello']},{action:'screenshot',file:'screen-4.png'}],errors:[]};
 assert.equal(assessMacJourney(spec,report).passed,true);
 assert.equal(assessMacJourney(spec,{...report,steps:report.steps.map(s=>s.action==='text'?{...s,values:['lost note']}:s)}).passed,false);
 assert.throws(()=>assessMacJourney(spec,{...report,steps:report.steps.filter(s=>s.action!=='restart')}));
 assert.throws(()=>assessMacJourney(spec,{...report,packaged:false}));
});

import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {macosSetup} from '../src/guide/macos.ts';import {listGuiApprovals,readGuiApproval,guiState,type GuiRuntime} from '../src/native/gui/store.ts';
const runtime:GuiRuntime={electron:'44.3.0',protocol:'a'.repeat(64),profile:{version:1,tart:'/tool/tart',tartHash:'b'.repeat(64),networkHash:'c'.repeat(64),cloneHash:'d'.repeat(64),image:'harness-macos-gui',files:{},identities:{},protocol:'e'.repeat(64),cpu:2,memoryMiB:4096,os:'26.6.2',arch:'arm64'}};
test('guided macOS starter approval shows behaviour and runtime without scripts or IDs',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'gui-guide-')),project=root+'/app';await mkdir(project);
 try{const answers=['1','n'],lines:string[]=[];const io={write:(s:string)=>{lines.push(s)},ask:async(p:string)=>{assert.ok(answers.length,p);return answers.shift()!;}};
  await macosSetup(project,io,async()=>runtime);assert.equal((await listGuiApprovals(project)).length,0);
  answers.push('1','y');await macosSetup(project,io,async()=>runtime);const all=await listGuiApprovals(project);assert.equal(all.length,1);assert.equal(all[0]!.journey.timeoutSeconds,180);assert.ok(all[0]!.journey.steps.some(s=>s.action==='restart'));assert.ok(lines.some(l=>l.includes('expected values stay')));
  answers.push('4','y');await macosSetup(project,io,async()=>({...runtime,protocol:'f'.repeat(64)}));const renewed=await listGuiApprovals(project);assert.equal(renewed.length,2);assert.deepEqual(renewed[1]!.journey,all[0]!.journey);assert.equal(renewed[1]!.runtime.protocol,'f'.repeat(64));
  const file=(await guiState(project))+'/approvals/'+all[0]!.id+'.json';const raw=JSON.parse(await readFile(file,'utf8'));raw.runtime.protocol='changed';await writeFile(file,JSON.stringify(raw));await assert.rejects(readGuiApproval(project,all[0]!.id),/approval changed/);
 }finally{await rm(root,{recursive:true,force:true});}
});
