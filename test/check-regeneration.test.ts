import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import {checkRequestBudget} from '../src/acceptance/budget.ts';
import {repairSavedCheck} from '../src/acceptance/guided.ts';
import {regenerateSavedCheck} from '../src/acceptance/regenerate.ts';
import {parseProposal,taskDigest} from '../src/acceptance/draft.ts';import {scopeDigest} from '../src/acceptance/scoped-review.ts';import {recipeCase} from '../src/acceptance/recipes/catalog.ts';import {sourceFiles} from '../src/workspace/candidate.ts';import {approveChecks,readApproval} from '../src/acceptance/checks.ts';import {webSpec} from './recipe-fixtures.ts';
const task={id:'app',title:'App',status:'todo' as const,priority:'must' as const,dependsOn:[],criteria:['Keep private data private.']};
const pass={verdict:'pass' as const,issues:[],limitations:[]};const io={write:(_s:string)=>{},ask:async()=>{throw Error('No code input expected');}};
const replacement={id:'privacy',tasks:['app'],description:'Inspect assets and SQLite plus application secrets.',steps:[{command:['node','-e','console.log(1)'],exitCode:0,stdout:'1\n'}]};
async function fixture(action:(project:string,dir:string,raw:string)=>Promise<void>){
 const root=await mkdtemp(path.join(os.tmpdir(),'regenerate-check-')),project=path.join(root,'project'),dir=project+'-harness/acceptance';await mkdir(project);await mkdir(dir,{recursive:true});
 try {
  await writeFile(path.join(project,'package.json'),'{"type":"module"}');await writeFile(path.join(project,'features.json'),JSON.stringify([task]));
  const other={...replacement,id:'other',description:'Retained check'};
  const proposal=parseProposal({version:1,contract:'Frozen interface.',coverage:[{criterion:1,cases:['privacy','other']}],manifest:{version:1,cases:[recipeCase(replacement,task.id,webSpec),other]}},task);
  const sourceDigest=createHash('sha256').update(JSON.stringify(Object.entries(await sourceFiles(project,'',['node_modules'])).sort(([a],[b])=>a.localeCompare(b)))).digest('hex');
  const ledger={version:1,entries:['$contract','privacy','other'].map(scope=>({scope,digest:scopeDigest(task,proposal,scope),repairs:0,syntaxRepairs:0,review:scope==='privacy'?{verdict:'repair',issues:['Recipe cannot observe private fixtures.'],limitations:[]}:pass}))};
  const raw=JSON.stringify({version:1,taskId:task.id,taskDigest:taskDigest(task),sourceDigest,proposal,ledger});await writeFile(path.join(dir,'review-progress.json'),raw);
  const file=path.join(root,'approval.json');await writeFile(file,JSON.stringify({version:1,cases:[other]}));await approveChecks(project,file);
  await action(project,dir,raw);
 }finally{await rm(root,{recursive:true,force:true});}
}
test('regeneration retains peers and approval, checkpoints generation and resumes only independent review',()=>fixture(async(project,dir,raw)=>{
 const approval=await readApproval(project);let generated=0,reviewed=0;
 await assert.rejects(regenerateSavedCheck(project,io,'privacy',{generate:async()=>{generated++;return replacement;},review:async()=>{reviewed++;throw Error('review interrupted');}}),/interrupted/);
 assert.equal(await readFile(path.join(dir,'review-progress.json'),'utf8'),raw);
 await regenerateSavedCheck(project,io,'privacy',{generate:async()=>{throw Error('must reuse generated candidate');},review:async()=>{reviewed++;return pass;}});
 const result=JSON.parse(await readFile(path.join(dir,'review-progress.json'),'utf8')),old=JSON.parse(raw);
 assert.equal(generated,1);assert.equal(reviewed,2);assert.deepEqual(result.proposal.manifest.cases[0],replacement);
 assert.deepEqual(result.proposal.manifest.cases[1],old.proposal.manifest.cases[1]);assert.equal(result.proposal.contract,old.proposal.contract);assert.deepEqual(result.proposal.coverage,old.proposal.coverage);
 for(const scope of ['$contract','other'])assert.deepEqual(result.ledger.entries.find((e:any)=>e.scope===scope),old.ledger.entries.find((e:any)=>e.scope===scope));
 assert.deepEqual(await readApproval(project),approval);
 await regenerateSavedCheck(project,io,'privacy',{generate:async()=>{throw Error('already committed');},review:async()=>{throw Error('already committed');}});
}));
test('rejected regeneration never replaces the saved check or approval',()=>fixture(async(project,dir,raw)=>{
 const approval=await readApproval(project);
 await assert.rejects(regenerateSavedCheck(project,io,'privacy',{generate:async()=>replacement,review:async()=>({verdict:'repair',issues:['Missing observation'],limitations:[]})}),/needs revision/);
 assert.equal(await readFile(path.join(dir,'review-progress.json'),'utf8'),raw);assert.deepEqual(await readApproval(project),approval);
}));
test('regeneration refuses identity changes, recipes, invalid syntax and changed source',()=>fixture(async(project,dir,raw)=>{
 for(const [value,message] of [[{...replacement,id:'other'},/cannot change/], [{...replacement,steps:recipeCase(replacement,task.id,webSpec).steps},/not another recipe/],[{...replacement,steps:[{...replacement.steps[0],command:['node','-e','const = invalid']}]},/syntax needs revision/]] as const){
  await assert.rejects(regenerateSavedCheck(project,io,'privacy',{generate:async()=>value,review:async()=>{throw Error('should not review invalid candidate');}}),message);
  assert.equal(await readFile(path.join(dir,'review-progress.json'),'utf8'),raw);
 }
 await writeFile(path.join(project,'new.js'),'changed');
 await assert.rejects(regenerateSavedCheck(project,io,'privacy',{generate:async()=>{throw Error('should not generate');},review:async()=>pass}),/changed/);
}));

test('repair routes an overbroad recipe to selected regeneration without asking for settings',()=>fixture(async(project)=>{
 await assert.rejects(repairSavedCheck(project,io,'privacy'),(error:any)=>/application-specific/.test(error.message)&&error.remedy.includes('harness checks regenerate privacy'));
}));
test('regeneration request allowance includes review and retains the candidate when exhausted',()=>fixture(async(project,dir,raw)=>{
 await assert.rejects(regenerateSavedCheck(project,io,'privacy',{
  generate:async()=>{for(let i=0;i<2;i++){const budget=await checkRequestBudget(900000);assert.ok(budget.timeoutMs<=180000);}return replacement;},
  review:async()=>{await checkRequestBudget(900000);throw Error('third request must not run');},
 }),(error:any)=>/request or time limit/.test(error.message)&&error.remedy.includes('checks regenerate privacy'));
 assert.equal(await readFile(path.join(dir,'review-progress.json'),'utf8'),raw);
 await regenerateSavedCheck(project,io,'privacy',{generate:async()=>{throw Error('candidate retained');},review:async()=>pass});
}));
test('regeneration rejects source changes during review before replacing any check',()=>fixture(async(project,dir,raw)=>{
 await assert.rejects(regenerateSavedCheck(project,io,'privacy',{generate:async()=>replacement,review:async()=>{await writeFile(path.join(project,'changed.js'),'changed');return pass;}}),/changed/);
 assert.equal(await readFile(path.join(dir,'review-progress.json'),'utf8'),raw);
}));
