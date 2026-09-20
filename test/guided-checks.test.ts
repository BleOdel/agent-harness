import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProposal, taskDigest, contractContext } from '../src/acceptance/draft.ts';
const task = { id: 'stories', title: 'Stories', priority: 'must' as const, status: 'todo' as const, dependsOn: [], criteria: ['Pending stories are private.', 'Reader layout is accessible.'], planContext: 'Local blog' };
const proposal = () => ({ version: 1, contract: 'POST /api/stories creates a pending story.', coverage: [{ criterion: 1, cases: ['pending'] }, { criterion: 2, cases: [], limitation: 'Requires a real browser review.' }], manifest: { version: 1, cases: [{ id: 'pending', tasks: ['stories'], description: 'Submit a story and confirm the public feed omits it.', steps: [{ command: ['node', '-e', 'fetch("http://127.0.0.1:3000/api/stories")'], exitCode: 0, stdout: 'hidden\n' }] }] } });
test('generated checks require honest coverage and task-scoped observable checks', () => {
 const parsed = parseProposal(proposal(), task);
 assert.equal(parsed.coverage[1]?.limitation, 'Requires a real browser review.');
 const wrong = proposal(); wrong.manifest.cases[0]!.tasks = ['*'];
 assert.throws(() => parseProposal(wrong, task), /selected task/);
 const missing = proposal(); missing.coverage.pop();
 assert.throws(() => parseProposal(missing, task), /criterion/);
 const unknown = proposal(); unknown.coverage[0]!.cases = ['invented'];
 assert.throws(() => parseProposal(unknown, task), /case/);
});
test('contract handoff excludes hidden commands and task fingerprint ignores status but detects scope change', () => {
 const p = parseProposal(proposal(), task);
 const approval = { version: 1 as const, digest: '', approvedAt: '', manifest: { ...p.manifest, cases: p.manifest.cases.map(c => ({ ...c, contract: p.contract })) } };
 assert.match(contractContext(approval, ['stories']), /POST \/api\/stories/);
 assert.doesNotMatch(contractContext(approval, ['stories']), /hidden|fetch\(/);
 assert.equal(contractContext(approval, ['other']), '');
 assert.equal(taskDigest(task), taskDigest({ ...task, status: 'done' }));
 assert.notEqual(taskDigest(task), taskDigest({ ...task, criteria: ['Changed'] }));
});

import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { guidedSetup as realGuidedSetup, reviewGuidedDraft } from '../src/acceptance/guided.ts';
import { readApproval, requireChecks, approveChecks } from '../src/acceptance/checks.ts';
import { harnessDirectory } from '../src/record/record.ts';
import { draftPrompt } from '../src/acceptance/draft.ts';
import { proposalDigest } from '../src/acceptance/repair.ts';
const guidedSetup = (project: string, selected: Parameters<typeof realGuidedSetup>[1], io: Parameters<typeof realGuidedSetup>[2], drafter: Parameters<typeof realGuidedSetup>[3]) => realGuidedSetup(project, selected, io, drafter, async (_project, _task, proposal) => ({ proposal, validation: { version: 1, status: 'reviewed', digest: proposalDigest(proposal), rounds: 1, limitations: [], at: new Date().toISOString() } }));
function dialogue(values: string[]) {
 const lines: string[] = [];
 return { lines, write: (text: string) => { lines.push(text); }, ask: async (q: string) => { lines.push(q); assert.ok(values.length, `Unexpected prompt: ${q}`); return values.shift()!; } };
}
async function fixture(action: (project: string) => Promise<void>) {
 const root = await mkdtemp(path.join(os.tmpdir(), 'guided-checks-'));
 const project = path.join(root, 'project'); await mkdir(project);
 await writeFile(path.join(project, 'features.json'), JSON.stringify([task]));
 try { await action(project); } finally { await rm(root, { recursive: true, force: true }); }
}
test('drafting saves before approval; resume avoids another model call and hands off contract', () => fixture(async project => {
 let calls = 0;
 const io = dialogue(['', '3']);
 await guidedSetup(project, task, io, async (_project, received) => { calls++; assert.equal(received.planContext, task.planContext); return parseProposal(proposal(), task); });
 assert.equal(await readApproval(project), undefined);
 assert.match(io.lines.join('\n'), /Not automatically checked/);
 assert.ok(!io.lines.some(line => line.includes('Application command')));
 const review = dialogue(['1', '1', 'y']);
 await guidedSetup(project, task, review, async () => { throw new Error('Unexpected model request'); });
 assert.equal(calls, 1);
 const approval = await requireChecks(project, ['stories']);
 assert.match(contractContext(approval, ['stories']), /POST/);
 assert.equal(approval.manifest.cases[0]?.taskDigest, taskDigest(task));
}));
test('changes to source or requirements block saved draft approval', () => fixture(async project => {
 await guidedSetup(project, task, dialogue(['', '3']), async () => parseProposal(proposal(), task));
 await writeFile(path.join(project, 'new.js'), '// a change');
 await assert.rejects(reviewGuidedDraft(project, dialogue([])), /source or task changed/);
 assert.equal(await readApproval(project), undefined);
}));
test('changed requirements invalidate approved generated checks before model work', () => fixture(async project => {
 await guidedSetup(project, task, dialogue(['', '1', 'y']), async () => parseProposal(proposal(), task));
 await writeFile(path.join(project, 'features.json'), JSON.stringify([{ ...task, criteria: ['Changed'] }]));
 await assert.rejects(requireChecks(project, ['stories']), /older requirements/);
}));
test('generated approval preserves other tasks and draft failure preserves previous approval', () => fixture(async project => {
 const other = { version: 1, cases: [{ id: 'other', tasks: ['runtime'], steps: [{ command: ['node', '-p', '1'], exitCode: 0, stdout: '1\n' }] }] };
 const file = path.join(project, 'approved-input.json'); await writeFile(file, JSON.stringify(other));
 await approveChecks(project, file);
 const before = await readApproval(project);
 await assert.rejects(guidedSetup(project, task, dialogue(['']), async () => { throw new Error('Provider unavailable'); }), /Provider/);
 assert.equal((await readApproval(project))?.digest, before?.digest);
 await guidedSetup(project, task, dialogue(['', '1', 'y']), async () => parseProposal(proposal(), task));
 assert.deepEqual((await readApproval(project))?.manifest.cases[0], other.cases[0]);
}));
test('tampered commands cannot hide behind the original plain-language review', () => fixture(async project => {
 await guidedSetup(project, task, dialogue(['', '3']), async () => parseProposal(proposal(), task));
 const file = path.join(harnessDirectory(project), 'acceptance', 'guided-draft.json');
 const saved = JSON.parse(await readFile(file, 'utf8'));
 saved.manifest.cases[0].steps[0].stdout = 'fake success';
 await writeFile(file, JSON.stringify(saved, null, 2) + '\n');
 await assert.rejects(reviewGuidedDraft(project, dialogue([])), /do not match/);
}));
test('draft instruction asks for executable behaviour, isolated data and honest limitations', () => {
 const prompt = draftPrompt(task);
 assert.match(prompt, /Do not run commands or edit files/);
 assert.match(prompt, /processes do not survive steps/);
 assert.match(prompt, /complete minimal interface contract/);
 assert.match(prompt, /not hardcoded success claims/);
});

test('legacy saved drafts receive automatic review before approval without retyping feedback', () => fixture(async project => {
 await guidedSetup(project, task, dialogue(['', '3']), async () => parseProposal(proposal(), task));
 const file=path.join(harnessDirectory(project),'acceptance','guided-draft.json');
 const legacy=JSON.parse(await readFile(file,'utf8'));delete legacy.validation;await writeFile(file,JSON.stringify(legacy,null,2)+'\n');
 let reviewed=0;
 const io=dialogue(['1','y']);
 await reviewGuidedDraft(project,io,undefined,async(_project,_task,p)=>{reviewed++;return {proposal:p,validation:{version:1,status:'reviewed',digest:proposalDigest(p),rounds:1,limitations:[],at:new Date().toISOString()}};});
 assert.equal(reviewed,1);assert.ok(await readApproval(project));
 assert.match(io.lines.join('\n'),/predates automatic quality review/);
 assert.ok(!io.lines.some(line=>line.includes('Anything to add')));
}));
test('repair progress survives a provider failure and resumes without regenerating the draft',()=>fixture(async project=>{
 let generated=0;
 const drafter=async()=>{generated++;return parseProposal(proposal(),task);};
 await assert.rejects(realGuidedSetup(project,task,dialogue(['']),drafter,async()=>{throw new Error('provider unavailable');}),/provider unavailable/);
 assert.equal(await readApproval(project),undefined);
 const io=dialogue(['1','3']);
 await realGuidedSetup(project,task,io,drafter,async(_project,_task,p)=>({proposal:p,validation:{version:1,status:'reviewed',digest:proposalDigest(p),rounds:1,limitations:[],at:new Date().toISOString()}}));
 assert.equal(generated,1);assert.match(io.lines.join('\n'),/Resuming the saved check draft/);
}));

test('resume retains saved findings, archives review snapshots and never approves a failed repair',()=>fixture(async project=>{
 const drafter=async()=>parseProposal(proposal(),task);
 await assert.rejects(realGuidedSetup(project,task,dialogue(['']),drafter,async(_project,_task,p,_progress,checkpoint)=>{
  await checkpoint!(p,3,['contradictory response helper']);throw new Error('review blocked');
 }),/review blocked/);
 const directory=path.join(harnessDirectory(project),'acceptance');
 const {readdir}=await import('node:fs/promises');
 const before=await readdir(path.join(directory,'review-history'));
 assert.equal(before.length,2);
 await assert.rejects(realGuidedSetup(project,task,dialogue(['1']),async()=>{throw new Error('must resume');},async(_project,_task,_p,_progress,_checkpoint,issues)=>{
  assert.deepEqual(issues,['contradictory response helper']);throw new Error('provider unavailable');
 }),/provider unavailable/);
 const latest=JSON.parse(await readFile(path.join(directory,'review-progress.json'),'utf8'));
 assert.deepEqual(latest.issues,['contradictory response helper']);
 const after=await readdir(path.join(directory,'review-history'));
 assert.equal(after.length,3);assert.ok(before.every(file=>after.includes(file)));
 assert.equal(await readApproval(project),undefined);
}));
test('explicitly drafting again with empty feedback does not resume the old proposal',()=>fixture(async project=>{
 let calls=0;
 const drafter=async()=>{calls++;const p=proposal();p.contract+=' generation '+calls;return parseProposal(p,task);};
 await guidedSetup(project,task,dialogue(['','3']),drafter);
 await guidedSetup(project,task,dialogue(['2','','3']),drafter);
 assert.equal(calls,2);
 const saved=JSON.parse(await readFile(path.join(harnessDirectory(project),'acceptance','guided-draft.json'),'utf8'));
 assert.match(saved.proposal.contract,/generation 2/);assert.equal(await readApproval(project),undefined);
}));
test('default review shows behaviours without dumping API details; interface choices remain inspectable',()=>fixture(async project=>{
 const io=dialogue(['','3']);await guidedSetup(project,task,io,async()=>parseProposal(proposal(),task));
 assert.match(io.lines.join('\n'),/Submit a story/);assert.doesNotMatch(io.lines.join('\n'),/POST \/api\/stories/);
 const details=dialogue(['4','3']);await reviewGuidedDraft(project,details);
 assert.match(details.lines.join('\n'),/POST \/api\/stories/);assert.equal(await readApproval(project),undefined);
}));
test('a deliberate restart carries the latest repaired proposal forward rather than the older guided draft',()=>fixture(async project=>{
 await guidedSetup(project,task,dialogue(['','3']),async()=>parseProposal(proposal(),task));
 const progressFile=path.join(harnessDirectory(project),'acceptance','review-progress.json');
 const latest=JSON.parse(await readFile(progressFile,'utf8'));latest.proposal.contract='Latest corrected interface.';await writeFile(progressFile,JSON.stringify(latest));
 await guidedSetup(project,task,dialogue(['2','','3']),async(_project,_task,_feedback,previous)=>{assert.equal(previous!.contract,'Latest corrected interface.');return previous!;});
}));

test('revising an interrupted preparation retains its latest outline and findings',()=>fixture(async project=>{
 await guidedSetup(project,task,dialogue(['','3']),async()=>parseProposal(proposal(),task));
 const dir=path.join(harnessDirectory(project),'acceptance');
 const draft=JSON.parse(await readFile(path.join(dir,'guided-draft.json'),'utf8'));
 const p=draft.proposal;
 await writeFile(path.join(dir,'preparation.json'),JSON.stringify({version:1,taskId:task.id,taskDigest:taskDigest(task),sourceDigest:draft.sourceDigest,state:{version:1,blueprint:{version:1,contract:'Latest partial interface.',coverage:p.coverage,cases:p.manifest.cases.map((c:{id:string;description:string})=>({id:c.id,description:c.description}))},cases:[],outlineReview:{review:{verdict:'repair',issues:['Missing response field.'],limitations:[]}}}}));
 await rm(path.join(dir,'guided-draft.json'));await rm(path.join(dir,'review-progress.json'));
 const io=dialogue(['2','Keep the saved scope.','3']);
 await realGuidedSetup(project,task,io,async(_project,_task,_feedback,previous)=>{assert.equal(previous!.contract,'Latest partial interface.');return previous!;},async(_project,_task,p,_progress,_checkpoint,issues)=>{
  assert.deepEqual(issues,['Missing response field.']);return {proposal:p,validation:{version:1,status:'reviewed',digest:proposalDigest(p),rounds:1,limitations:[],at:new Date().toISOString()}};
 });
 assert.equal(await readApproval(project),undefined);
}));

import {repairSavedCheck} from '../src/acceptance/guided.ts';
import {scopeDigest,reviewScopes} from '../src/acceptance/scoped-review.ts';
import {applyCodeRepair} from '../src/acceptance/targeted.ts';
test('targeted repair archives its prior budget, keeps unrelated cases and approvals, and never approves the selected fix',()=>fixture(async project=>{
 const p=parseProposal(proposal(),task);p.manifest.cases.push({...structuredClone(p.manifest.cases[0]!),id:'second'});p.coverage[0]!.cases.push('second');
 await assert.rejects(realGuidedSetup(project,task,dialogue(['']),async()=>p,async()=>{throw Error('interrupted');}),/interrupted/);
 const file=path.join(harnessDirectory(project),'acceptance','review-progress.json');
 const before=JSON.parse(await readFile(file,'utf8'));const pass={verdict:'pass' as const,issues:[],limitations:[]};
 before.ledger={version:1,entries:[{scope:'pending',digest:scopeDigest(task,p,'pending'),repairs:2,syntaxRepairs:0,review:{verdict:'repair',issues:['shutdown defect'],limitations:[]}},{scope:'second',digest:scopeDigest(task,p,'second'),repairs:0,syntaxRepairs:0,review:pass}]};
 await writeFile(file,JSON.stringify(before));
 const io=dialogue(['1']);
 await repairSavedCheck(project,io,undefined,async(_project,t,input,scope,l,save,progress)=>reviewScopes(t,input,{syntax:async()=>[],review:async()=>pass,repair:async()=>applyCodeRepair(t,input,scope,{codes:[{step:1,code:'console.log("repaired")'}]}),save,progress},l,scope));
 const after=JSON.parse(await readFile(file,'utf8'));
 assert.deepEqual(after.proposal.manifest.cases[1],before.proposal.manifest.cases[1]);
 assert.deepEqual(after.ledger.entries[1],before.ledger.entries[1]);assert.equal(after.ledger.entries[0].retryCount,1);
 assert.equal(await readApproval(project),undefined);assert.match(io.lines.join('\n'),/Next: harness checks review/);
 assert.ok((await (await import('node:fs/promises')).readdir(path.join(harnessDirectory(project),'acceptance','review-history'))).some(n=>n.endsWith('-before-targeted-repair.json')));
}));
test('targeted repair refuses changed source before spending model work',()=>fixture(async project=>{
 await assert.rejects(realGuidedSetup(project,task,dialogue(['']),async()=>parseProposal(proposal(),task),async()=>{throw Error('interrupted');}),/interrupted/);
 await writeFile(path.join(project,'changed.js'),'changed');
 await assert.rejects(repairSavedCheck(project,dialogue([]),'pending',async()=>{throw Error('must not dispatch');}),/older source/);
}));
