import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import {useRecipeSavedCheck} from '../src/acceptance/guided.ts';import {parseProposal,taskDigest} from '../src/acceptance/draft.ts';import {scopeDigest,reviewScopes,scopedPrompt} from '../src/acceptance/scoped-review.ts';import {recipeCase} from '../src/acceptance/recipes/catalog.ts';import {parsePreparedCase} from '../src/acceptance/preparation.ts';import {sourceFiles} from '../src/workspace/candidate.ts';import {getAdapter} from '../src/adapters/registry.ts';import {readProfile} from '../src/project/profile.ts';import {approveChecks,readApproval} from '../src/acceptance/checks.ts';import {webSpec} from './recipe-fixtures.ts';
const task={id:'app',title:'Web app',status:'todo' as const,priority:'must' as const,dependsOn:[],criteria:['Serve assets and keep SQLite private.']};
const pass={verdict:'pass' as const,issues:[],limitations:[]};
const original=()=>parseProposal({version:1,contract:'node app.js starts with APP_DB and PORT=0. Readiness is Listening at URL. GET / and /api/stories return 200. Reject invalid Host/Origin with 403.',coverage:[{criterion:1,cases:['boundary','other']}],manifest:{version:1,cases:['boundary','other'].map(id=>({id,tasks:['app'],description:id==='boundary'?'Inspect assets and SQLite privacy.':'Another behaviour.',steps:[{command:['node','-e','console.log(1)'],exitCode:0,stdout:'1\n'}]}))}},task);
async function fixture(run:(project:string,dir:string,raw:string,approval:unknown)=>Promise<void>){
 const root=await mkdtemp(path.join(os.tmpdir(),'recipe-migration-')),project=path.join(root,'app'),dir=project+'-harness/acceptance';await mkdir(project);await mkdir(dir,{recursive:true});
 try{await writeFile(path.join(project,'package.json'),'{"type":"module"}');await writeFile(path.join(project,'features.json'),JSON.stringify([task]));const file=path.join(root,'approved.json');await writeFile(file,JSON.stringify({version:1,cases:[{id:'old',tasks:['other'],steps:[{command:['node','-e','console.log(1)'],exitCode:0,stdout:'1\n'}]}]}));await approveChecks(project,file);
 const adapter=getAdapter((await readProfile(project,true)).adapter);const sourceDigest=createHash('sha256').update(JSON.stringify(Object.entries(await sourceFiles(project,'',adapter.source.generatedDirectories)).sort(([a],[b])=>a.localeCompare(b)))).digest('hex');
 const p=original();const raw=JSON.stringify({version:1,taskId:task.id,taskDigest:taskDigest(task),sourceDigest,proposal:p,ledger:{version:1,entries:[{scope:'other',digest:scopeDigest(task,p,'other'),repairs:0,syntaxRepairs:0,review:pass},{scope:'$contract',digest:scopeDigest(task,p,'$contract'),repairs:0,syntaxRepairs:0,review:pass}]}});await writeFile(path.join(dir,'review-progress.json'),raw);await run(project,dir,raw,await readApproval(project));
 }finally{await rm(root,{recursive:true,force:true});}
}
const io={write:(_s:string)=>{},ask:async()=>{throw Error('No probe code should be requested.');}};
test('recipe migration reviews settings once, retains peers and approval, and resumes an interrupted saved receipt',async()=>{
 await fixture(async(project,dir,raw,approval)=>{
  let calls=0;
  await assert.rejects(useRecipeSavedCheck(project,io,'boundary',{settings:webSpec,reviewer:async()=>{calls++;throw Error('provider stopped');}}),/provider stopped/);
  assert.equal(await readFile(path.join(dir,'review-progress.json'),'utf8'),raw);assert.deepEqual(await readApproval(project),approval);
  await assert.rejects(useRecipeSavedCheck(project,io,'boundary',{resume:true,reviewer:async()=>{throw Error('must not retry automatically');}}),/interrupted/);
  await useRecipeSavedCheck(project,io,'boundary',{settings:webSpec,reviewer:async(_project,_task,p)=>{calls++;assert.equal(p.manifest.cases[0]!.steps[0]!.command.includes('-e'),false);return pass;}});
  const result=JSON.parse(await readFile(path.join(dir,'review-progress.json'),'utf8'));assert.equal(calls,2);assert.equal(result.proposal.manifest.cases[0].steps[0].recipe.kind,'node-web-sqlite');assert.deepEqual(result.proposal.manifest.cases[1],original().manifest.cases[1]);assert.equal(result.ledger.entries.find((e:any)=>e.scope==='other').digest,JSON.parse(raw).ledger.entries[0].digest);assert.deepEqual(await readApproval(project),approval);await assert.rejects(readFile(path.join(dir,'recipe-change.json')),{code:'ENOENT'});
 });
});
test('recipe rejection leaves the old check intact; changing only settings can be reviewed without rebuilding peers',async()=>{
 await fixture(async(project,dir,raw,approval)=>{
  await assert.rejects(useRecipeSavedCheck(project,io,'boundary',{settings:{...webSpec,entry:'wrong.js'},reviewer:async()=>({verdict:'repair',issues:['wrong entry'],limitations:[]})}),/settings need attention/);
  assert.equal(await readFile(path.join(dir,'review-progress.json'),'utf8'),raw);
  await useRecipeSavedCheck(project,io,'boundary',{settings:webSpec,reviewer:async()=>pass});assert.deepEqual(await readApproval(project),approval);
 });
});
test('recipe cases skip generated-code repair even when the mapping reviewer identifies a problem',async()=>{
 const p=original();p.manifest.cases[0]=recipeCase({id:'boundary',description:'Inspect assets and SQLite privacy.'},task.id,webSpec);let repairs=0,reviews=0;
 await assert.rejects(reviewScopes(task,p,{syntax:async()=>[],review:async()=>{reviews++;return {verdict:'repair',issues:['wrong path'],limitations:[]};},repair:async()=>{repairs++;return p;},save:async()=>{}},{version:1,entries:[]},'boundary'),/settings or coverage/);
 assert.equal(reviews,1);assert.equal(repairs,0);const prompt=scopedPrompt(task,p,'boundary',[]);assert.match(prompt,/mapping/);assert.equal(prompt.includes('Exact executable source'),false);
 const selected={id:'boundary',description:'Inspect assets and SQLite privacy.'};const compiled=parsePreparedCase({...selected,tasks:[task.id],recipe:webSpec},task,selected);assert.equal(compiled.steps[0]!.command.includes('-e'),false);
 assert.throws(()=>parsePreparedCase({...selected,tasks:[task.id],recipe:{...webSpec,code:'unsafe'}},task,selected));
});

test('stale recipe pin does not block repair of another scope, and its refresh requires an independent review',async()=>{
 await fixture(async(project,dir,_raw,approval)=>{
  const {repairSavedCheck}=await import('../src/acceptance/guided.ts');
  const {applyCodeRepair}=await import('../src/acceptance/repair-response.ts');
  const record=JSON.parse(await readFile(path.join(dir,'review-progress.json'),'utf8'));
  record.proposal.manifest.cases[0]=recipeCase({id:'boundary',description:'Inspect assets and SQLite privacy.'},task.id,webSpec);
  record.proposal.manifest.cases[0].steps[0].recipeRuntime='0'.repeat(64);
  record.proposal=parseProposal(record.proposal,task);
  record.ledger.entries=[
   {scope:'boundary',digest:scopeDigest(task,record.proposal,'boundary'),repairs:0,syntaxRepairs:0,review:pass},
   {scope:'other',digest:scopeDigest(task,record.proposal,'other'),repairs:2,syntaxRepairs:0,review:{verdict:'repair',issues:['Fix probe'],limitations:[]}},
  ];
  await writeFile(path.join(dir,'review-progress.json'),JSON.stringify(record));
  let reviewed=0;
  await repairSavedCheck(project,io,'other',async(_project,t,p,scope,ledger,save)=>{
   return reviewScopes(t,p,{syntax:async()=>[],review:async s=>{assert.equal(s,'other');reviewed++;return pass;},repair:async()=>applyCodeRepair(t,p,scope,{codes:[{step:1,code:'console.log(2-1)'}]}),save},ledger,scope);
  });
  assert.equal(reviewed,1);
  const updated=JSON.parse(await readFile(path.join(dir,'review-progress.json'),'utf8'));
  assert.deepEqual(updated.proposal.manifest.cases[0],record.proposal.manifest.cases[0]);
  assert.deepEqual(updated.ledger.entries.find((e:any)=>e.scope==='boundary'),record.ledger.entries[0]);
  assert.deepEqual(await readApproval(project),approval);
  let refreshed=0;
  await useRecipeSavedCheck(project,io,'boundary',{settings:webSpec,reviewer:async(_project,_task,p)=>{
   refreshed++;assert.notEqual(p.manifest.cases[0]!.steps[0]!.recipeRuntime,'0'.repeat(64));return pass;
  }});
  const final=JSON.parse(await readFile(path.join(dir,'review-progress.json'),'utf8'));
  assert.equal(refreshed,1);assert.deepEqual(final.proposal.manifest.cases[1],updated.proposal.manifest.cases[1]);
  assert.deepEqual(final.ledger.entries.find((e:any)=>e.scope==='other'),updated.ledger.entries.find((e:any)=>e.scope==='other'));
  assert.notEqual(final.ledger.entries.find((e:any)=>e.scope==='boundary').digest,record.ledger.entries[0].digest);
  assert.deepEqual(await readApproval(project),approval);
 });
});
test('a prior pass cannot hide a stale recipe pin during ordinary review',async()=>{
 let p=original();p.manifest.cases[0]=recipeCase({id:'boundary',description:'Inspect assets and SQLite privacy.'},task.id,webSpec);
 p.manifest.cases[0]!.steps[0]!.recipeRuntime='0'.repeat(64);p=parseProposal(p,task);
 const ledger={version:1 as const,entries:[{scope:'boundary',digest:scopeDigest(task,p,'boundary'),repairs:0,syntaxRepairs:0,review:pass}]};
 let requests=0;
 await assert.rejects(reviewScopes(task,p,{syntax:async()=>[],review:async()=>{requests++;return pass;},repair:async()=>{requests++;return p;},save:async()=>{}},ledger,'boundary'),(error:any)=>{
  assert.equal(error.name,'OperatorError');assert.match(error.remedy,/harness checks use-recipe boundary/);return true;
 });
 assert.equal(requests,0);
});
