import test from 'node:test';
import assert from 'node:assert/strict';
import {compileRecipe} from '../src/acceptance/recipes/catalog.ts';
import {webSpec} from './recipe-fixtures.ts';
import {parseProposal} from '../src/acceptance/draft.ts';
import {scopeDigest, type ReviewLedger} from '../src/acceptance/scoped-review.ts';
import {simplifiableScopes, simplifyOutline, simplifyInParts, sqliteWebOutline, type SimplificationState} from '../src/acceptance/simplification.ts';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {simplifySavedCheck} from '../src/acceptance/guided.ts';
import {sourceFiles} from '../src/workspace/candidate.ts';
import {getAdapter} from '../src/adapters/registry.ts';
import {readProfile} from '../src/project/profile.ts';
import {createHash} from 'node:crypto';
import {taskDigest} from '../src/acceptance/draft.ts';
import {approveChecks,readApproval} from '../src/acceptance/checks.ts';

const task={id:'app',title:'App',status:'todo' as const,priority:'must' as const,dependsOn:[],criteria:['Serve the application and protect private data.','Persist changes.']};
const pass={verdict:'pass' as const,issues:[],limitations:[]};
const part=(id:string,description=id)=>({id,tasks:['app'],description,steps:[{command:['node','-e','console.log(1)'],exitCode:0,stdout:'1\n'}]});
const original=()=>parseProposal({version:1,contract:'GET / returns HTML; private data must not be served.',coverage:[{criterion:1,cases:['startup','giant'],limitation:'Browser evidence needed.'},{criterion:2,cases:['persistence']}],manifest:{version:1,cases:[part('startup'),part('giant'),part('persistence')]}},task);
const plan={cases:[{id:'entry',description:'Read the HTML entry.'},{id:'boundary',description:'Verify private data is not served.'}],limitations:[{criterion:1,text:'Dynamic asset discovery needs browser evidence; it is not waived.'}]};
function ledger(p=original()):ReviewLedger{return {version:1,entries:[{scope:'$contract',digest:scopeDigest(task,p,'$contract'),repairs:0,syntaxRepairs:0,review:pass},{scope:'startup',digest:scopeDigest(task,p,'startup'),repairs:0,syntaxRepairs:0,review:pass},{scope:'giant',digest:scopeDigest(task,p,'giant'),repairs:2,syntaxRepairs:2,review:{verdict:'repair',issues:['parser is broken'],limitations:[]}}]};}
test('simplification changes only the selected outline and affected coverage; it cannot change the contract',()=>{
 const p=original(), next=simplifyOutline(task,p,'giant',plan);
 assert.equal(next.contract,p.contract);assert.deepEqual(next.manifest.cases[0],p.manifest.cases[0]);assert.deepEqual(next.manifest.cases.at(-1),p.manifest.cases.at(-1));
 assert.deepEqual(next.coverage[0]!.cases,['startup','entry','boundary']);assert.deepEqual(next.coverage[1],p.coverage[1]);assert.match(next.coverage[0]!.limitation!,/^Browser evidence needed\./);
 for(const bad of [{...plan,contract:'weakened'}, {...plan,cases:[plan.cases[0]]}, {...plan,cases:[plan.cases[0],plan.cases[0]]}, {...plan,limitations:[{criterion:2,text:'skip persistence'}]}, {...plan,cases:[{id:'startup',description:'reuse'},plan.cases[1]]}])assert.throws(()=>simplifyOutline(task,p,'giant',bad));
});
test('the SQLite design template is limited to the matching runtime and remains an unreviewed outline',()=>{
 const p=original();assert.equal(sqliteWebOutline(p,'giant'),undefined);
 p.contract+=' Use node:sqlite.';assert.equal(sqliteWebOutline(p,'giant'),undefined);
 p.manifest.cases[1]!.description='Inspect static assets and SQLite boundaries.';
 const next=simplifyOutline(task,p,'giant',sqliteWebOutline(p,'giant'));
 assert.equal(next.manifest.cases.length,4);assert.equal(next.contract,p.contract);assert.deepEqual(next.manifest.cases[0],p.manifest.cases[0]);
 assert.equal('validation' in next,false);assert.equal(next.manifest.cases[1]!.steps[0]!.command.at(-1),'');
});
test('simplification reviews the outline first, resumes generated parts, and retains only valid peer receipts',async()=>{
 const p=original();let state:SimplificationState|undefined;let generated=0;let outlines=0;
 const services={plan:async()=>plan,reviewOutline:async()=>{outlines++;return pass;},generate:async(id:string)=>{generated++;if(id==='boundary')throw Error('provider timeout');return part(id,plan.cases.find(c=>c.id===id)!.description);},syntax:async()=>[],review:async()=>pass,repair:async()=>{throw Error('not needed');},save:async(s:SimplificationState)=>{state=structuredClone(s);}};
 await assert.rejects(simplifyInParts(task,p,'giant',ledger(),services),/provider timeout/);
 assert.equal(outlines,1);assert.equal(state!.cases.length,1);assert.equal(state!.generationAttempts.boundary,1);
 const result=await simplifyInParts(task,p,'giant',ledger(),{...services,plan:async()=>{throw Error('must reuse outline');},generate:async id=>{generated++;return part(id,plan.cases.find(c=>c.id===id)!.description);}},state);
 assert.equal(outlines,1);assert.equal(generated,3);assert.equal(result.ledger.entries.find(e=>e.scope==='startup')!.review!.verdict,'pass');
 assert.equal(result.ledger.entries.find(e=>e.scope==='startup')!.digest,scopeDigest(task,result.proposal,'startup'));
 assert.equal(result.ledger.entries.some(e=>e.scope==='giant'),false);assert.equal(result.ledger.entries.some(e=>e.scope==='persistence'),false);
 assert.deepEqual(result.proposal.manifest.cases.at(-1),p.manifest.cases.at(-1));assert.equal('validation' in result,false);
});
test('failed outline never generates code and retries are bounded across resume',async()=>{
 let state:SimplificationState|undefined;let calls=0;const p=original();
 const services={plan:async()=>{calls++;throw Error('offline');},reviewOutline:async()=>pass,generate:async()=>{throw Error('must not generate');},syntax:async()=>[],review:async()=>pass,repair:async()=>p,save:async(s:SimplificationState)=>{state=structuredClone(s);}};
 for(let i=0;i<2;i++)await assert.rejects(simplifyInParts(task,p,'giant',ledger(),services,state),/offline/);
 await assert.rejects(simplifyInParts(task,p,'giant',ledger(),services,state),/outline.*budget/i);assert.equal(calls,2);
 const failed={...services,plan:async()=>plan,reviewOutline:async()=>({verdict:'repair' as const,issues:['missing privacy coverage'],limitations:[]})};
 await assert.rejects(simplifyInParts(task,p,'giant',ledger(),failed),/outline correction made no change/);
 assert.deepEqual(state!.outlineReview!.review.issues,['missing privacy coverage']);
 await assert.rejects(simplifyInParts(task,p,'giant',ledger(),failed,state),/outline needs revision/);
});
test('saved simplification is bound to source proposal, task, scope and reviewed outline',async()=>{
 const p=original();let saved:SimplificationState|undefined;
 const services={plan:async()=>plan,reviewOutline:async()=>pass,generate:async()=>{throw Error('stop');},syntax:async()=>[],review:async()=>pass,repair:async()=>p,save:async(s:SimplificationState)=>{saved=structuredClone(s);}};
 await assert.rejects(simplifyInParts(task,p,'giant',ledger(),services),/stop/);
 const changed=structuredClone(p);changed.contract+=' changed';
 await assert.rejects(simplifyInParts(task,changed,'giant',ledger(),services,saved),/changed/);
 const tampered=structuredClone(saved!);tampered.outline!.manifest.cases[1]!.description='silently weaken';
 await assert.rejects(simplifyInParts(task,p,'giant',ledger(),services,tampered),/outline/);
});

test('an outline correction is reviewed independently before any executable generation',async()=>{
 const p=original();let plans=0,reviews=0,generated=0;
 const fixed={...plan,cases:[{...plan.cases[0],description:'Read the contracted HTML entry in /work.'},plan.cases[1]]};
 const result=await simplifyInParts(task,p,'giant',ledger(),{
  plan:async(previous,issues)=>{plans++;if(previous){assert.deepEqual(issues,['wrong working directory']);return fixed;}return plan;},
  reviewOutline:async()=>{reviews++;return reviews===1?{verdict:'repair',issues:['wrong working directory'],limitations:[]}:pass;},
  generate:async id=>{assert.equal(reviews,2);generated++;return part(id,fixed.cases.find(c=>c!.id===id)!.description);},
  syntax:async()=>[],review:async()=>pass,repair:async()=>p,save:async()=>{},
 });
 assert.equal(plans,2);assert.equal(reviews,2);assert.equal(generated,2);assert.equal(result.proposal.contract,p.contract);
});
test('oversized or malformed new checks never replace saved original checks',async()=>{
 const p=original();let state:SimplificationState|undefined;let calls=0;
 const services={plan:async()=>plan,reviewOutline:async()=>pass,generate:async(id:string)=>{calls++;const c=part(id,plan.cases.find(c=>c.id===id)!.description);c.steps[0]!.command[2]='x'.repeat(9000);return c;},syntax:async()=>[],review:async()=>pass,repair:async()=>p,save:async(s:SimplificationState)=>{state=structuredClone(s);}};
 await assert.rejects(simplifyInParts(task,p,'giant',ledger(),services),/generation.*budget/i);
 assert.equal(calls,2);assert.equal(state!.cases.length,0);assert.deepEqual(p,original());
});

test('a crash after generation reuses the saved raw response without another model request',async()=>{
 const p=original();let state:SimplificationState|undefined;let calls=0;
 const services={plan:async()=>plan,reviewOutline:async()=>pass,generate:async(id:string)=>{calls++;return part(id,plan.cases.find(c=>c.id===id)!.description);},syntax:async()=>[],review:async()=>pass,repair:async()=>p,save:async(s:SimplificationState)=>{state=structuredClone(s);if(s.lastGenerated)throw Error('crash after checkpoint');}};
 await assert.rejects(simplifyInParts(task,p,'giant',ledger(),services),/crash/);
 assert.equal(calls,1);
 await simplifyInParts(task,p,'giant',ledger(),{...services,save:async()=>{}},state);
 assert.equal(calls,2);
});

test('no correction request is spent when the outline review budget cannot review its result',async()=>{
 const p=original();let saved:SimplificationState|undefined;
 const services={plan:async()=>plan,reviewOutline:async()=>{throw Error('provider interrupted');},generate:async()=>{throw Error('must not generate');},syntax:async()=>[],review:async()=>pass,repair:async()=>p,save:async(s:SimplificationState)=>{saved=structuredClone(s);}};
 await assert.rejects(simplifyInParts(task,p,'giant',ledger(),services),/provider interrupted/);
 assert.equal(saved!.outlineReviewAttempts,1);
 await assert.rejects(simplifyInParts(task,p,'giant',ledger(),{...services,plan:async()=>{throw Error('must not spend correction request');},reviewOutline:async()=>({verdict:'repair',issues:['revise outline'],limitations:[]})},saved),/outline needs revision/);
 assert.equal(saved!.outlineAttempts,1);assert.equal(saved!.outlineReviewAttempts,2);
});

for(const kind of ['exhausted-code','rejected-recipe'] as const)test(`writer-locked simplification preserves original draft, resumes and never approves (${kind})`,async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'simplification-flow-')), project=path.join(root,'app'), dir=project+'-harness/acceptance';
 try{
  await mkdir(project);await mkdir(dir,{recursive:true});await writeFile(path.join(project,'package.json'),'{"type":"module"}');
  await writeFile(path.join(project,'features.json'),JSON.stringify([task]));
  const manifest={version:1,cases:[{id:'existing',tasks:['other'],steps:[{command:['node','-e','console.log(1)'],exitCode:0,stdout:'1\n'}]}]};
  const file=path.join(root,'checks.json');await writeFile(file,JSON.stringify(manifest));await approveChecks(project,file);const approved=await readApproval(project);
  const adapter=getAdapter((await readProfile(project,true)).adapter);
  const sourceDigest=createHash('sha256').update(JSON.stringify(Object.entries(await sourceFiles(project,'',adapter.source.generatedDirectories)).sort(([a],[b])=>a.localeCompare(b)))).digest('hex');
  const proposal=original();if(kind==='rejected-recipe')proposal.manifest.cases[1]!.steps=[compileRecipe(webSpec)];
  const savedLedger=ledger(proposal);if(kind==='rejected-recipe'){const entry=savedLedger.entries.find(e=>e.scope==='giant')!;entry.repairs=0;entry.syntaxRepairs=0;}
  const record={version:1,taskId:task.id,taskDigest:taskDigest(task),sourceDigest,proposal,ledger:savedLedger,round:0,issues:[]};
  const raw=JSON.stringify(record);await writeFile(path.join(dir,'review-progress.json'),raw);
  const lines:string[]=[];const io={write:(s:string)=>lines.push(s),ask:async()=>{throw Error('explicit scope should not prompt');}};
  const factory:Parameters<typeof simplifySavedCheck>[3]=(_project,_task,_p,_scope,_findings,save)=>({plan:async()=>plan,reviewOutline:async()=>pass,generate:async()=>{throw Error('provider timeout');},syntax:async()=>[],review:async()=>pass,repair:async()=>original(),save});
  await assert.rejects(simplifySavedCheck(project,io,'giant',factory),/provider timeout/);
  assert.equal(await readFile(path.join(dir,'review-progress.json'),'utf8'),raw);assert.deepEqual(await readApproval(project),approved);
  await assert.rejects(readFile(project+'-harness.writer-lock'),{code:'ENOENT'});
  await simplifySavedCheck(project,io,undefined,(...args)=>({...factory!(...args),generate:async id=>part(id,plan.cases.find(c=>c.id===id)!.description)}));
  const updated=JSON.parse(await readFile(path.join(dir,'review-progress.json'),'utf8'));
  assert.deepEqual(updated.proposal.manifest.cases.map((c:{id:string})=>c.id),['startup','entry','boundary','persistence']);
  assert.equal(updated.ledger.entries.find((e:{scope:string})=>e.scope==='startup').review.verdict,'pass');
  assert.deepEqual(await readApproval(project),approved);assert.equal(await readFile(path.join(project,'features.json'),'utf8'),JSON.stringify([task]));
  await assert.rejects(readFile(path.join(dir,'simplification.json')),{code:'ENOENT'});
  assert.match(lines.join('\n'),/Resuming saved simplification/);
 }finally{await rm(root,{recursive:true,force:true});}
});
import {withCheckBudget,checkRequestBudget,CheckBudgetExceeded} from '../src/acceptance/budget.ts';
test('bounded preparation does not charge simplification review or generation when dispatch is paused',async()=>{
 let saved:SimplificationState|undefined;
 const services={plan:async()=>{await checkRequestBudget(1000);return plan;},reviewOutline:async()=>{await checkRequestBudget(1000);return pass;},generate:async()=>{throw Error('must pause before generation');},syntax:async()=>[],review:async()=>pass,repair:async()=>{throw Error('unexpected repair');},save:async(s:SimplificationState)=>{saved=structuredClone(s);}};
 const run=()=>withCheckBudget({maxRequests:1,maxSeconds:10,requestSeconds:1},{requests:0},async()=>{},()=>{},()=>simplifyInParts(task,original(),'giant',ledger(),services,saved));
 await assert.rejects(run(),CheckBudgetExceeded);assert.equal(saved!.outlineReviewAttempts??0,0);
 await assert.rejects(run(),CheckBudgetExceeded);assert.deepEqual(saved!.generationAttempts,{});assert.equal(saved!.outlineReview?.review.verdict,'pass');
});

test('compound reader privacy checks bypass the SQLite simplification template',()=>{
 const p=original();p.contract+=' Use node:sqlite.';
 p.manifest.cases[1]!.description="Build a compact fixture set containing an unreviewed edit, sensitive approved prose, private rejection/removal explanations, internal moderation notes, a report note and management keys. Obtain corresponding key hashes through read-only inspection of the actual isolated SQLite database without writing fixtures directly. Across public feed, initial details, unavailable responses, report responses and collected static assets, scan headers and raw/decoded response bodies for applicable private markers; exclude only the deliberately disclosed approved body from its own explicit-continue response. Confirm nonempty database evidence, capture actual database and existing sidecar snapshots before and after requests, and apply the pinned byte-disclosure helper to all retained bodies. Probe the frozen database-looking URL list with exact neutral 404 assertions and scan those responses too. Print observed resource, snapshot and response counts, not sensitive values. This is bounded public-surface evidence, not a claim that the intentionally unsecured moderator API is private or that every possible URL/browser request has been examined.";
 assert.equal(sqliteWebOutline(p,'giant'),undefined);
 for(const extra of [' Check management key hashes.', ' Submit reports and inspect private notes.', ' Verify pending revision privacy.']){
  p.manifest.cases[1]!.description='Inspect static assets and SQLite boundaries.'+extra;
  assert.equal(sqliteWebOutline(p,'giant'),undefined);
 }
});

test('simplification accepts current failed designs without spending repair attempts, but rejects stale or passed reviews',()=>{
 const p=original(),l=ledger(p),entry=l.entries.find(e=>e.scope==='giant')!;
 entry.repairs=0;entry.syntaxRepairs=0;
 assert.deepEqual(simplifiableScopes(task,p,l),['giant']);
 entry.review=pass;assert.deepEqual(simplifiableScopes(task,p,l),[]);
 entry.review={verdict:'repair',issues:['Missing observations'],limitations:[]};
 entry.digest='stale';assert.deepEqual(simplifiableScopes(task,p,l),[]);
 entry.digest=scopeDigest(task,p,'giant');delete entry.review;
 assert.deepEqual(simplifiableScopes(task,p,l),[]);
 entry.repairs=2;assert.deepEqual(simplifiableScopes(task,p,l),['giant']);
});
