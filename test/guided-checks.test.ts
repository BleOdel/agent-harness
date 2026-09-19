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
 const io=dialogue(['','3']);
 await realGuidedSetup(project,task,io,drafter,async(_project,_task,p)=>({proposal:p,validation:{version:1,status:'reviewed',digest:proposalDigest(p),rounds:1,limitations:[],at:new Date().toISOString()}}));
 assert.equal(generated,1);assert.match(io.lines.join('\n'),/Resuming the saved check draft/);
}));
