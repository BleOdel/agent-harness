import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCheckEdits } from '../src/acceptance/edits.ts';
import { parseProposal } from '../src/acceptance/draft.ts';
const task={id:'story',title:'Stories',priority:'must' as const,status:'todo' as const,dependsOn:[],criteria:['Only approved stories are public.']};
const original=()=>parseProposal({version:1,contract:'GET /stories returns approved stories.',coverage:[{criterion:1,cases:['privacy']}],manifest:{version:1,cases:[{id:'privacy',tasks:['story'],description:'Pending stays private',steps:[{command:['node','-e','const pending = true; console.log(pending);'],exitCode:0,stdout:'false\n'}]}]}},task);
const edit={target:'code',caseId:'privacy',step:1,before:'const pending = true;',after:'const pending = false;',issues:[1],reason:'Correct the observed condition.'};
test('targeted check edits preserve unrelated bytes, scope and expected results',()=>{
 const p=original();const result=applyCheckEdits(p,{edits:[edit]},['wrong condition'],task);
 assert.equal(result.manifest.cases[0]!.steps[0]!.command[2],'const pending = false; console.log(pending);');
 assert.equal(p.manifest.cases[0]!.steps[0]!.command[2],'const pending = true; console.log(pending);');
 const expected=original();expected.manifest.cases[0]!.steps[0]!.command[2]=result.manifest.cases[0]!.steps[0]!.command[2]!;
 assert.deepEqual(result,expected);
});
test('repairs cannot silently omit findings, overwrite case identity or use ambiguous/stale replacements',()=>{
 assert.throws(()=>applyCheckEdits(original(),{edits:[edit]},['first','second'],task),/every finding/);
 for(const bad of [{...edit,target:'id'},{...edit,before:'not in source'},{...edit,before:''},{...edit,issues:[2]}]){
  assert.throws(()=>applyCheckEdits(original(),{edits:[bad]},['first'],task));
 }
 const p=original();p.manifest.cases[0]!.steps[0]!.command[2]='repeat repeat';
 assert.throws(()=>applyCheckEdits(p,{edits:[{...edit,before:'repeat'}]},['first'],task),/exactly once/);
});
test('an explicit limitation can be added without removing a mapped check or waiving the criterion',()=>{
 const result=applyCheckEdits(original(),{edits:[{target:'limitation',criterion:1,before:'',after:'Browser rendering requires separate browser evidence.',issues:[1],reason:'Disclose browser evidence limit.'}]},['claim too broad'],task);
 assert.deepEqual(result.coverage[0]!.cases,['privacy']);
 assert.match(result.coverage[0]!.limitation!,/Browser/);
 assert.deepEqual(result.manifest,original().manifest);
});
