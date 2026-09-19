import assert from 'node:assert/strict';
import test from 'node:test';
import { draftInParts, type Preparation, type Blueprint } from '../src/acceptance/preparation.ts';
import { scopedReview, type ReviewLedger } from '../src/acceptance/scoped-review.ts';
import { parseProposal } from '../src/acceptance/draft.ts';
const task={id:'story',title:'Stories',priority:'must' as const,status:'todo' as const,dependsOn:[],criteria:['Pending stays private.','Deletion removes a story.']};
const blueprint={version:1,contract:'POST /stories creates pending; DELETE /stories/:id deletes.',coverage:[{criterion:1,cases:['privacy']},{criterion:2,cases:['delete']}],cases:[{id:'privacy',description:'Pending privacy'},{id:'delete',description:'Permanent deletion'}]};
const entry=(id:string)=>({id,tasks:['story'],description:id==='privacy'?'Pending privacy':'Permanent deletion',steps:[{command:['node','-e','console.log("observed")'],exitCode:0,stdout:'observed\n'}]});
const proposal=()=>parseProposal({...blueprint,manifest:{version:1,cases:blueprint.cases.map(c=>entry(c.id))}},task);
const pass={verdict:'pass' as const,issues:[],limitations:[]};
test('interrupted preparation retains complete cases and resumes only missing behaviour',async()=>{
 let state:Preparation|undefined;const calls:string[]=[];
 const services={plan:async()=>blueprint,generate:async(id:string)=>{calls.push(id);if(id==='delete')throw Error('provider unavailable');return entry(id);},save:async(s:Preparation)=>{state=structuredClone(s);}};
 await assert.rejects(draftInParts(task,services),/provider unavailable/);
 assert.equal(state!.cases.length,1);
 const result=await draftInParts(task,{...services,plan:async()=>{throw Error('must reuse contract');},generate:async id=>{calls.push(id);return entry(id);}},state);
 assert.deepEqual(calls,['privacy','delete','delete']);assert.equal(result.contract,blueprint.contract);
 assert.equal(result.manifest.cases.length,2);
});
test('a case generator cannot rewrite interface choices, case identity or exceed bounded source',async()=>{
 for(const bad of [{...entry('other')},{...entry('privacy'),contract:'replace interface'},{...entry('privacy'),steps:[{command:['node','-e','x'.repeat(17000)],exitCode:0,stdout:'x'}]}]){
  await assert.rejects(draftInParts(task,{plan:async()=>blueprint,generate:async()=>bad,save:async()=>{}}));
 }
});
test('scoped review retains successful checks across interruption and repairs only the failing case',async()=>{
 let ledger:ReviewLedger={version:1,entries:[]};const seen:string[]=[];let failed=false;
 const services={syntax:async()=>[],review:async(scope:string)=>{seen.push(scope);if(scope==='delete'&&!failed){failed=true;throw Error('provider unavailable');}return pass;},repair:async()=>{throw Error('unexpected repair');},save:async(_p:ReturnType<typeof proposal>,l:ReviewLedger)=>{ledger=structuredClone(l);}};
 await assert.rejects(scopedReview(task,proposal(),services,ledger),/provider unavailable/);
 assert.equal(ledger.entries.filter(e=>e.review?.verdict==='pass').length,2);
 const done=await scopedReview(task,proposal(),services,ledger);
 assert.deepEqual(seen,['$contract','privacy','delete','delete']);assert.equal(done.validation.status,'reviewed');
});
test('repair cannot change a passing check or frozen contract; unchanged repair stops without another model review',async()=>{
 for(const change of ['contract','other','none']){
  let reviews=0;
  await assert.rejects(scopedReview(task,proposal(),{syntax:async()=>[],review:async scope=>{reviews++;return scope==='privacy'?{verdict:'repair',issues:['Missing observation'],limitations:[]}:pass;},repair:async(_scope,p)=>{const n=structuredClone(p);if(change==='contract')n.contract+=' changed';if(change==='other')n.manifest.cases[1]!.steps[0]!.stdout='changed';return n;},save:async()=>{}}),/contract|unrelated|no change/);
  assert.equal(reviews,2);
 }
});
test('resume cannot reset the repair budget or accept stale successful reviews',async()=>{
 let p=proposal();let ledger:ReviewLedger={version:1,entries:[]};let calls=0;
 const services={syntax:async()=>[],review:async(scope:string)=>{calls++;return scope==='privacy'?{verdict:'repair' as const,issues:['still broken'],limitations:[]}:pass;},repair:async(_scope:string,original:typeof p)=>{const n=structuredClone(original);n.manifest.cases[0]!.steps[0]!.command[2]+=';';return n;},save:async(value:typeof p,l:ReviewLedger)=>{p=structuredClone(value);ledger=structuredClone(l);}};
 await assert.rejects(scopedReview(task,p,services,ledger),/two repair/);
 const before=calls;
 await assert.rejects(scopedReview(task,p,services,ledger),/two repair/);
 assert.equal(calls,before);
 const changed=proposal();changed.contract+=' Different route.';
 const seen:string[]=[];
 await scopedReview(task,changed,{syntax:async()=>[],review:async scope=>{seen.push(scope);return pass;},repair:services.repair,save:async()=>{}},ledger);
 assert.deepEqual(seen,['$contract','privacy','delete']);
});

import {parseScopedReview} from '../src/acceptance/scoped-review.ts';
test('blocking findings require an existing criterion and preserve context; optional extensions do not block',()=>{
 const p=proposal();
 const good={verdict:'repair',findings:[{criterion:1,kind:'missing-observation',problem:'The code only prints a literal.',evidence:'console.log("observed")'}],limitations:[]};
 assert.equal(parseScopedReview(good,task,p,'privacy').issues.length,1);
 const imprecise=parseScopedReview({...good,findings:[{...good.findings[0],evidence:'imprecise reviewer quotation'}]},task,p,'privacy');assert.equal(imprecise.verdict,'repair');assert.match(imprecise.issues[0]!,/quotation not verified/);assert.match(imprecise.issues[0]!,/Exact requirement: Pending stays private/);
 for(const change of [{criterion:3},{evidence:''},{kind:'optional-hardening'}])assert.throws(()=>parseScopedReview({...good,findings:[{...good.findings[0],...change}]},task,p,'privacy'));
 assert.equal(parseScopedReview({verdict:'pass',findings:[],limitations:['Optional extra permutations.']},task,p,'privacy').verdict,'pass');
 assert.throws(()=>parseScopedReview({...good,verdict:'pass'},task,p,'privacy'),/Contradictory/);
});
test('a semantic repair is syntax-checked and independently reviewed again with the original finding',async()=>{
 const p=proposal();let repairs=0,reviews=0;const received:string[][]=[];
 const result=await scopedReview(task,p,{syntax:async selected=>selected.manifest.cases[0]?.steps[0]?.command[2]==='const = ;'?['privacy, step 1: syntax error']:[],review:async(scope,_p,previous)=>{
  if(scope==='privacy'){received.push([...previous]);reviews++;return reviews===1?{verdict:'repair',issues:['missing HTTP observation'],limitations:[]}:pass;}return pass;
 },repair:async(_scope,original,_issues,syntax)=>{repairs++;const n=structuredClone(original);n.manifest.cases[0]!.steps[0]!.command[2]=syntax?'console.log("repaired")':'const = ;';return n;},save:async()=>{}});
 assert.equal(repairs,2);assert.equal(reviews,2);assert.equal(result.validation.status,'reviewed');
 assert.match(received[1]!.join(' '),/syntax error/);
});
test('a contradictory outline stops before generating code and retains the review for resume',async()=>{
 let state:Preparation|undefined;let reviews=0,cases=0;
 const services={plan:async()=>blueprint,reviewOutline:async()=>{reviews++;return {verdict:'repair' as const,issues:['A route contradicts the existing interface.'],limitations:[]};},generate:async()=>{cases++;return entry('privacy');},save:async(s:Preparation)=>{state=structuredClone(s);}};
 await assert.rejects(draftInParts(task,services),/outline needs revision/);
 await assert.rejects(draftInParts(task,services,state),/outline needs revision/);
 assert.equal(cases,0);assert.equal(reviews,1);
});
test('review evidence can quote literal multiline interface text without JSON escape ambiguity',()=>{
 const p=proposal();p.contract='POST /stories\ncreates pending stories.';
 assert.equal(parseScopedReview({verdict:'repair',findings:[{criterion:1,kind:'contract-conflict',problem:'Example contradiction.',evidence:p.contract}],limitations:[]},task,p,'$contract').issues.length,1);
});

import {repairReviewReferences} from '../src/acceptance/scoped-review.ts';
test('review reference repair cannot delete a finding, change its meaning or turn rejection into a pass',()=>{
 const p=proposal();const original={verdict:'repair',findings:[{criterion:'1',kind:'missing-observation',problem:'No HTTP observation.',evidence:'wrong quote'}],limitations:['Source review needed.']};
 const corrected={...original,findings:[{...original.findings[0],criterion:1,evidence:'Pending stays private.'}]};
 assert.equal(repairReviewReferences(original,corrected,task,p,'privacy').verdict,'repair');
 for(const bad of [{...corrected,verdict:'pass'},{...corrected,findings:[]},{...corrected,findings:[{...corrected.findings[0],problem:'Optional suggestion.'}]},{...corrected,limitations:[]}])assert.throws(()=>repairReviewReferences(original,bad,task,p,'privacy'));
});
test('a single review wrapper is normalized without changing the independent verdict',()=>{
 const p=proposal();const r={verdict:'repair',findings:[{criterion:1,kind:'missing-observation',problem:'No HTTP observation.',evidence:'Pending stays private.'}],limitations:[]};
 assert.equal(parseScopedReview({review:r},task,p,'privacy').verdict,'repair');
 assert.equal(parseScopedReview({review:r,error:'Prior schema error'},task,p,'privacy').verdict,'repair');
 assert.equal(repairReviewReferences({...r,findings:[{...r.findings[0],evidence:'incorrect'}]},{review:r},task,p,'privacy').verdict,'repair');
 assert.throws(()=>parseScopedReview({review:r,verdict:'pass'},task,p,'privacy'));
});
import {scopedPrompt} from '../src/acceptance/scoped-review.ts';
test('outline review does not request an executable trace while case review does',()=>{
 assert.doesNotMatch(scopedPrompt(task,proposal(),'$contract',[]),/Trace readiness/);
 assert.match(scopedPrompt(task,proposal(),'$contract',[]),/Do not infer missing observations/);
 assert.match(scopedPrompt(task,proposal(),'privacy',[]),/Trace readiness/);
});
test('outline and executable review both preserve independent project-test gates',()=>{
 for(const scope of ['$contract','privacy'])assert.match(scopedPrompt(task,proposal(),scope,[]),/Do not require or propose npm test/);
});
test('a changed early case cannot erase already reviewed later cases when its provider call fails',async()=>{
 let ledger:ReviewLedger={version:1,entries:[]};const services={syntax:async()=>[],review:async()=>pass,repair:async()=>{throw Error('unexpected repair');},save:async(_p:ReturnType<typeof proposal>,l:ReviewLedger)=>{ledger=structuredClone(l);}};
 await scopedReview(task,proposal(),services,ledger);
 const changed=proposal();changed.manifest.cases[0]!.steps[0]!.command[2]+=';';
 await assert.rejects(scopedReview(task,changed,{...services,review:async()=>{throw Error('provider unavailable');}},ledger),/provider unavailable/);
 assert.ok(ledger.entries.some(e=>e.scope==='delete'&&e.review?.verdict==='pass'));
 const seen:string[]=[];await scopedReview(task,changed,{...services,review:async scope=>{seen.push(scope);return pass;}},ledger);
 assert.deepEqual(seen,['privacy']);
});
test('legacy findings survive interruption and are supplied to case review, then clear after all scopes pass',async()=>{
 let ledger:ReviewLedger={version:1,entries:[],previousIssues:['Previous privacy defect']};
 const received:string[][]=[];
 const services={syntax:async()=>[],review:async(scope:string,_p:ReturnType<typeof proposal>,previous:readonly string[])=>{received.push([...previous]);if(scope==='privacy')throw Error('provider unavailable');return pass;},repair:async()=>{throw Error('unexpected');},save:async(_p:ReturnType<typeof proposal>,l:ReviewLedger)=>{ledger=structuredClone(l);}};
 await assert.rejects(scopedReview(task,proposal(),services,ledger),/provider unavailable/);
 assert.deepEqual(received,[[],['Previous privacy defect']]);assert.deepEqual(ledger.previousIssues,['Previous privacy defect']);
 await scopedReview(task,proposal(),{...services,review:async()=>pass},ledger);assert.equal(ledger.previousIssues,undefined);
});

test('outline correction is reviewed before code and its budget persists across provider interruption',async()=>{
 let saved:Preparation|undefined;let repairs=0,generated=0,reviews=0;
 const services={plan:async()=>blueprint,reviewOutline:async(b:Blueprint)=>{reviews++;return b.contract.includes('corrected')?pass:{verdict:'repair' as const,issues:['Response field is ambiguous.'],limitations:[]};},repairOutline:async(b:Blueprint)=>{repairs++;if(repairs===1)throw Error('provider unavailable');return {...b,contract:b.contract+' corrected'};},generate:async(id:string)=>{generated++;return entry(id);},save:async(s:Preparation)=>{saved=structuredClone(s);}};
 await assert.rejects(draftInParts(task,services),/provider unavailable/);
 assert.equal(generated,0);assert.equal(saved!.outlineRepairs,1);
 const result=await draftInParts(task,services,saved);
 assert.match(result.contract,/corrected/);assert.equal(generated,2);assert.equal(repairs,2);assert.equal(reviews,2);assert.equal(saved!.outlineRepairs,2);
});
test('unchanged outline repairs and depleted budgets stop without generating or approving code',async()=>{
 let saved:Preparation|undefined;let repairs=0;
 const services={plan:async()=>blueprint,reviewOutline:async()=>({verdict:'repair' as const,issues:['Still contradictory.'],limitations:[]}),repairOutline:async(b:Blueprint)=>{repairs++;return b;},generate:async()=>{throw Error('must not generate');},save:async(s:Preparation)=>{saved=structuredClone(s);}};
 await assert.rejects(draftInParts(task,services),/outline repair made no change/i);
 await assert.rejects(draftInParts(task,services,saved),/outline repair made no change/i);
 const before=repairs;await assert.rejects(draftInParts(task,services,saved),/outline needs revision/);assert.equal(repairs,before);
});

test('invalid generated case repair checkpoints raw output and resumes with its spent budget',async()=>{
 let state:Preparation|undefined;let generations=0,repairs=0;
 const services={plan:async()=>blueprint,generate:async(id:string)=>{generations++;const c=entry(id);return id==='privacy'?{...c,steps:[{...c.steps[0],stdoutIncludes:''}]}:c;},repairCase:async(_id:string,_b:Blueprint,raw:unknown,error:string)=>{repairs++;assert.match(error,/stdoutIncludes/);assert.ok(raw);if(repairs===1)throw Error('provider unavailable');return entry('privacy');},save:async(s:Preparation)=>{state=structuredClone(s);}};
 await assert.rejects(draftInParts(task,services),/provider unavailable/);
 assert.equal(state!.pendingCase!.repairs,1);assert.equal(generations,1);
 const done=await draftInParts(task,services,state);assert.equal(done.manifest.cases.length,2);assert.equal(generations,2);assert.equal(repairs,2);assert.equal(state!.pendingCase,undefined);
});
test('invalid case repair cannot restart an exhausted generation budget',async()=>{
 let state:Preparation|undefined;let repairs=0;
 const bad={...entry('privacy'),steps:[{...entry('privacy').steps[0],stdoutIncludes:''}]};
 const services={plan:async()=>blueprint,generate:async()=>bad,repairCase:async()=>{repairs++;return {...bad,attempt:repairs};},save:async(s:Preparation)=>{state=structuredClone(s);}};
 await assert.rejects(draftInParts(task,services),/could not prepare this behaviour/);
 await assert.rejects(draftInParts(task,services,state),/could not prepare this behaviour/);assert.equal(repairs,2);assert.equal(state!.cases.length,0);
});

test('an oversized behaviour can split after exhausted format repairs, reusing completed cases and reviewing the partition',async()=>{
 let saved:Preparation|undefined;let splitCalls=0,reviewCalls=0;const generated:string[]=[];
 const services={plan:async()=>blueprint,reviewOutline:async()=>pass,generate:async(id:string,b:Blueprint)=>{generated.push(id);return {...entry(id),description:b.cases.find(c=>c.id===id)!.description,...(id==='delete'?{steps:[{command:['node','-e','x'.repeat(18000)],exitCode:0,stdout:'x'}]}:{})};},repairCase:async(_id:string,_b:Blueprint,raw:unknown)=>({...raw as object,changed:0}),splitCase:async()=>{splitCalls++;return {cases:[{id:'delete-authorized',description:'Authorized deletion'},{id:'delete-private',description:'Deletion privacy'}]};},reviewSplit:async()=>{reviewCalls++;if(reviewCalls===1)throw Error('provider unavailable');return pass;},save:async(s:Preparation)=>{saved=structuredClone(s);}};
 // A distinct repair marker permits the second bounded attempt while remaining oversized.
 let repairCalls=0;services.repairCase=async(_id,_b,raw)=>({...raw as object,changed:++repairCalls});
 await assert.rejects(draftInParts(task,services),/provider unavailable/);
 assert.equal(saved!.cases.length,1);assert.equal(saved!.splits,1);assert.ok(saved!.pendingSplit);
 const done=await draftInParts(task,services,saved);
 assert.deepEqual(generated,['privacy','delete','delete-authorized','delete-private']);assert.equal(splitCalls,1);assert.equal(reviewCalls,2);
 assert.equal(done.contract,blueprint.contract);assert.deepEqual(done.coverage[1]!.cases,['delete-authorized','delete-private']);assert.equal(saved!.retiredCases![0]!.repairs,2);
});
import {partitionBlueprint} from '../src/acceptance/preparation.ts';
test('partitioning can replace only the selected behaviour and cannot alter its interface or unrelated coverage',()=>{
 const b=proposal();const original={version:1 as const,contract:b.contract,coverage:b.coverage,cases:b.manifest.cases.map(c=>({id:c.id,description:c.description!}))};
 const parts={cases:[{id:'delete-a',description:'First deletion observation'},{id:'delete-b',description:'Second deletion observation'}]};
 const changed=partitionBlueprint(task,original,'delete',parts);assert.equal(changed.contract,original.contract);assert.deepEqual(changed.cases[0],original.cases[0]);assert.deepEqual(changed.coverage[0],original.coverage[0]);
 for(const bad of [{...parts,contract:'changed'},{cases:[parts.cases[0]]},{cases:[parts.cases[0],{id:'privacy',description:'collision'}]}])assert.throws(()=>partitionBlueprint(task,original,'delete',bad));
});

test('exhausted partition budget cannot trigger another model call on resume',async()=>{
 const b=proposal();const saved:Preparation={version:1,blueprint:{version:1,contract:b.contract,coverage:b.coverage,cases:b.manifest.cases.map(c=>({id:c.id,description:c.description!}))},cases:[entry('privacy')],pendingCase:{id:'delete',raw:{...entry('delete'),steps:[{command:['node','-e','x'.repeat(18000)],exitCode:0,stdout:'x'}]},repairs:2},splits:2};
 await assert.rejects(draftInParts(task,{plan:async()=>{throw Error('must reuse');},generate:async()=>{throw Error('must not generate');},repairCase:async()=>{throw Error('budget exhausted');},splitCase:async()=>{throw Error('must not split again');},reviewSplit:async()=>pass,save:async()=>{}},saved),/could not prepare this behaviour/);
});
