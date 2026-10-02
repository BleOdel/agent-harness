import test from 'node:test';
import assert from 'node:assert/strict';
import {applyOutlinePatch,outlinePatchDigest,requestOutlinePatch} from '../src/acceptance/outline-patch.ts';
import {draftInParts,parseBlueprint,type Blueprint,type Preparation} from '../src/acceptance/preparation.ts';
import {CheckRequestInterrupted} from '../src/acceptance/request-failure.ts';
import type {Feature} from '../src/features.ts';
const task:Feature={id:'author',title:'Author experience',priority:'must',status:'todo',dependsOn:[],criteria:['Preserve prose and accessible errors.','Retain unrelated behaviour.']};
const outline:Blueprint=parseBlueprint({version:1,contract:'Existing API must remain byte-identical.\n\nBrowser limitations are outdated.',coverage:[{criterion:1,cases:['errors'],limitation:'Chromium has no clipboard support.'},{criterion:2,cases:['unchanged']}],cases:[{id:'errors',kind:'browser',description:'Observe error presentation and actual screen-reader announcements.'},{id:'unchanged',kind:'command',description:'Observe unrelated behaviour.'}]},task);
const patch=()=>({version:1,baseDigest:outlinePatchDigest(outline),cases:[{id:'errors',kind:'browser',description:'Observe retained prose, inline errors and keyboard access.'}],addCases:[{id:'announcements',kind:'manual',description:'Use a screen reader to hear validation and failure notifications; Chromium DOM observations cannot establish announcements.'}],coverage:[{criterion:1,cases:['errors','announcements'],limitation:'Actual assistive-technology announcements require human evidence.'}],contractEdits:[{section:1,text:'Chromium supports clipboard; actual screen-reader announcements require manual evidence.'}]});
const pass={verdict:'pass' as const,issues:[],limitations:[]};
const repair={verdict:'repair' as const,issues:['Separate actual screen-reader observations.'],limitations:[]};
test('section patch preserves unrelated bytes, order and coverage and never mutates its input',()=>{
 const before=structuredClone(outline),p=patch(),after=parseBlueprint(applyOutlinePatch(outline,p),task);
 assert.deepEqual(outline,before);assert.deepEqual(p,patch());
 assert.equal(after.contract.split('\n\n')[0],before.contract.split('\n\n')[0]);assert.deepEqual(after.cases[1],before.cases[1]);assert.deepEqual(after.coverage[1],before.coverage[1]);
 assert.equal(after.cases[2]!.kind,'manual');assert.deepEqual(after.coverage[0]!.cases,['errors','announcements']);assert.match(after.contract,/supports clipboard/);
});
test('patches fail atomically for stale bases, unknown fields, removed coverage, duplicate edits and whole-outline replacements',()=>{
 const before=structuredClone(outline);
 const bad:unknown[]=[{...patch(),baseDigest:'stale'},{...patch(),contract:'replace everything'},{...outline},{...patch(),approved:true},{...patch(),cases:[{...patch().cases[0],steps:[]}]},{...patch(),cases:[{...patch().cases[0],id:'missing'}]},{...patch(),cases:[patch().cases[0],patch().cases[0]]},{...patch(),addCases:[{...patch().addCases[0],id:'unchanged'}]},{...patch(),coverage:[{criterion:1,cases:[],limitation:'waive'}]},{...patch(),contractEdits:[{section:5,text:'wrong'}]},{...patch(),contractEdits:[{section:1,text:'x'},{section:1,text:'y'}]},{...patch(),cases:[{...patch().cases[0],description:'x'.repeat(17000)}]}];
 for(const raw of bad)assert.throws(()=>parseBlueprint(applyOutlinePatch(outline,raw),task));
 assert.deepEqual(outline,before);
 assert.throws(()=>applyOutlinePatch(outline,{version:1,baseDigest:outlinePatchDigest(outline)}),/no change/i);
});
test('repair request uses a dedicated bounded patch schema and no exploration tools',async()=>{
 let requests=0;
 const returned=await requestOutlinePatch('/unused',task,outline,repair.issues,undefined,async(_project,prompt,options)=>{
  requests++;assert.deepEqual(options,{tools:'none',stage:'outline-patch'});
  assert.match(prompt,/baseDigest/);assert.match(prompt,/contractEdits/);assert.match(prompt,/16 KiB/);assert.doesNotMatch(prompt,/Read the source in \/work|Return schema:|Generate ONLY the selected behaviour/);
  assert.match(prompt,/Existing API must remain byte-identical/);return patch();
 });
 assert.equal(requests,1);assert.deepEqual(returned,patch());
});
function services(save:(s:Preparation)=>Promise<void>){return {plan:async()=>outline,reviewOutline:async(b:Blueprint)=>b.cases.some(c=>c.id==='announcements')?pass:repair,repairOutline:async()=>patch(),generate:async()=>{throw Error('generation stop');},save};}
test('completed patch survives interruption before application and is reused without another request',async()=>{
 let saved:Preparation|undefined,calls=0,crash=true;
 const s={...services(async state=>{saved=structuredClone(state);if(state.pendingOutlinePatch&&crash){crash=false;throw Error('checkpoint crash');}}),repairOutline:async()=>{calls++;return patch();}};
 await assert.rejects(draftInParts(task,s),/checkpoint crash/);assert.deepEqual(saved!.blueprint,outline);assert.ok(saved!.pendingOutlinePatch);assert.equal(saved!.outlineRepairs,1);
 await assert.rejects(draftInParts(task,s,saved),/generation stop/);assert.equal(calls,1);assert.equal(saved!.blueprint.cases.at(-1)!.id,'announcements');assert.equal(saved!.pendingOutlinePatch,undefined);assert.equal(saved!.outlinePatchHistory!.length,1);assert.equal(saved!.outlineReview!.review.verdict,'pass');
});
test('invalid patch is retained, corrected within the existing budget and never applied before independent review',async()=>{
 let saved:Preparation|undefined,calls=0;
 const s={...services(async state=>{saved=structuredClone(state);}),repairOutline:async(_b:Blueprint,_issues:string[],previous?:{raw:unknown;error:string})=>{
  calls++;if(calls===1)return {...patch(),contract:'bad'};
  assert.ok(previous);assert.match(previous.error,/field/);assert.deepEqual(saved!.blueprint,outline);return patch();
 },reviewOutline:async()=>repair};
 await assert.rejects(draftInParts(task,s),/outline needs revision/);assert.equal(calls,2);assert.equal(saved!.outlinePatchHistory!.length,2);assert.equal(saved!.cases.length,0);assert.equal(saved!.outlineReview!.review.verdict,'repair');
 await assert.rejects(draftInParts(task,s,saved),/outline needs revision/);assert.equal(calls,2);
});
test('provider interruption preserves prior review and patch budget; stale retained patch refuses without a request',async()=>{
 let saved:Preparation|undefined;
 const s={...services(async state=>{saved=structuredClone(state);}),repairOutline:async()=>{throw new CheckRequestInterrupted('timeout','provider timed out');}};
 await assert.rejects(draftInParts(task,s),/provider timed out/);assert.equal(saved!.outlineRepairs,0);assert.equal(saved!.outlineReview!.review.verdict,'repair');
 saved!.pendingOutlinePatch={baseDigest:'stale',raw:patch()};
 await assert.rejects(draftInParts(task,s,saved),/saved outline patch/i);
});
test('large inherited interfaces survive unchanged while the repair reply stays small',()=>{
 const large={...outline,contract:'Existing inherited API. '.repeat(2000)+'\n\nUnapproved browser additions.'};
 const small={version:1,baseDigest:outlinePatchDigest(large),cases:[{...large.cases[0],description:'Observe prose and DOM errors; screen-reader evidence is separate.'}]};
 const next=applyOutlinePatch(large,small);
 assert.ok(Buffer.byteLength(JSON.stringify(large))>40000);assert.ok(Buffer.byteLength(JSON.stringify(small))<500);assert.equal(next.contract,large.contract);assert.deepEqual(next.coverage,large.coverage);
});
test('independent review interruption resumes the repaired outline without repeating the patch',async()=>{
 let saved:Preparation|undefined,calls=0,reviews=0;
 const s={...services(async state=>{saved=structuredClone(state);}),repairOutline:async()=>{calls++;return patch();},reviewOutline:async(b:Blueprint)=>{if(!b.cases.some(c=>c.id==='announcements'))return repair;if(++reviews===1)throw new CheckRequestInterrupted('timeout','review interrupted');return pass;}};
 await assert.rejects(draftInParts(task,s),/review interrupted/);assert.equal(calls,1);assert.equal(saved!.pendingOutlinePatch,undefined);assert.equal(saved!.outlineReview,undefined);
 await assert.rejects(draftInParts(task,s,saved),/generation stop/);assert.equal(calls,1);assert.equal(reviews,2);
});
