import test from 'node:test';import assert from 'node:assert/strict';
import {parseAppleJourney,appleActions,assessAppleJourney} from '../src/native/apple/schema.ts';
const spec={version:1,title:'Save native note',timeoutSeconds:300,entry:'build.sh',app:'build/Notes.app',steps:[{action:'fill',selector:'note',value:'Hello'},{action:'click',selector:'save'},{action:'restart'},{action:'text',selector:'saved',expected:'Hello'},{action:'screenshot'}]};
test('native app journeys validate paths and accessibility identifiers and withhold expectations',()=>{
 assert.deepEqual(parseAppleJourney(spec),spec);assert.ok(!JSON.stringify(appleActions(parseAppleJourney(spec))).includes('expected'));
 for(const entry of ['../build.sh','a;pwd.sh','/build.sh'])assert.throws(()=>parseAppleJourney({...spec,entry}));
 for(const app of ['../Notes.app','/Applications/Notes.app','build/file'])assert.throws(()=>parseAppleJourney({...spec,app}));
 assert.throws(()=>parseAppleJourney({...spec,steps:[{action:'text',selector:'#css .selector',expected:'x'}]}));
 assert.throws(()=>parseAppleJourney({...spec,timeoutSeconds:601}));
 assert.throws(()=>parseAppleJourney({...spec,steps:[...spec.steps,...Array.from({length:3},()=>({action:'screenshot'}))]}));
 assert.throws(()=>parseAppleJourney({...spec,unknown:true}));
});
test('host rejects wrong native observations, reordered actions and unavailable automation',()=>{
 const journey=parseAppleJourney(spec);const report={version:1,packaged:true,steps:[{action:'fill'},{action:'click'},{action:'restart'},{action:'text',values:['Hello']},{action:'screenshot',file:'screen-4.png'}],errors:[]};
 assert.equal(assessAppleJourney(journey,report).passed,true);
 assert.equal(assessAppleJourney(journey,{...report,steps:report.steps.map(s=>s.action==='text'?{...s,values:['lost']} : s)}).passed,false);
 assert.equal(assessAppleJourney(journey,{...report,errors:['Accessibility denied']}).passed,false);
 assert.throws(()=>assessAppleJourney(journey,{...report,steps:report.steps.slice(1)}));
});

import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {appleSetup,guideApple} from '../src/guide/apple.ts';import {approveApple,listAppleApprovals,readAppleApproval,appleState,type AppleRuntime} from '../src/native/apple/store.ts';
const runtime:AppleRuntime={protocol:'a'.repeat(64),profile:{version:1,tart:'/tool/tart',tartHash:'b'.repeat(64),networkHash:'c'.repeat(64),cloneHash:'d'.repeat(64),image:'harness-macos-gui',files:{},identities:{},protocol:'e'.repeat(64),cpu:2,memoryMiB:4096,os:'26.6.2',arch:'arm64'}};
test('native guide permits declining and renewing a saved journey and binds build paths to approval',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'apple-guide-')),project=root+'/app';await mkdir(project);
 try{
  const answers=['1','n'],lines:string[]=[];const io={write:(s:string)=>{lines.push(s)},ask:async(p:string)=>{assert.ok(answers.length,p);return answers.shift()!;}};
  await appleSetup(project,io,async()=>runtime);assert.equal((await listAppleApprovals(project)).length,0);
  answers.push('1','y');await appleSetup(project,io,async()=>runtime);const [a]=await listAppleApprovals(project);assert.ok(a);assert.equal(a.journey.entry,'build.sh');assert.equal(a.journey.app,'build/Notes.app');assert.ok(lines.some(s=>s.includes('Guest-only')));
  answers.push('4','y');await appleSetup(project,io,async()=>({...runtime,protocol:'f'.repeat(64)}));const all=await listAppleApprovals(project);assert.equal(all.length,2);assert.deepEqual(all[1]!.journey,a.journey);
  const commands:string[][]=[];answers.push('4','0');await guideApple(project,io,async(p,args)=>{assert.equal(p,project);commands.push([...args]);return 0;});assert.deepEqual(commands,[['macos-native','init','swiftui']]);
  const file=(await appleState(project))+'/approvals/'+a.id+'.json';const raw=JSON.parse(await readFile(file,'utf8'));raw.journey.entry='changed.sh';await writeFile(file,JSON.stringify(raw));await assert.rejects(readAppleApproval(project,a.id),/approval changed/);
 }finally{await rm(root,{recursive:true,force:true});}
});
