import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { readFeatures, type Feature } from '../features.ts';
import { readArtifact, atomicWrite } from '../planning/store.ts';
import { sourceFiles } from '../workspace/candidate.ts';
import { readProfile } from '../project/profile.ts';
import { getAdapter } from '../adapters/registry.ts';
import { withWriter } from '../workspace/writer-lock.ts';
import { harnessDirectory } from '../record/record.ts';
import { choose, confirmed, type Dialogue } from '../guide/dialogue.ts';
import { readApproval, approveChecks, parseChecks, type CheckManifest } from './checks.ts';
import { generateProposal, parseProposal, taskDigest, type Proposal } from './draft.ts';
import { OperatorError } from '../verbs/io.ts';

interface SavedDraft { version: 1; taskId: string; inputDigest: string; sourceDigest: string; baseApprovalDigest: string | null; proposal: Proposal; manifest: CheckManifest; }
export type Drafter = typeof generateProposal;
const directory = (project: string) => path.join(harnessDirectory(project), 'acceptance');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function sourceDigest(project: string): Promise<string> {
 const adapter = getAdapter((await readProfile(project, true)).adapter);
 return digest(Object.entries(await sourceFiles(project, '', adapter.source.generatedDirectories)).sort(([a], [b]) => a.localeCompare(b)));
}
async function currentTask(project: string, id: string): Promise<Feature> {
 const result = await readFeatures(project);
 const task = result?.ok ? result.features.find(t => t.id === id) : undefined;
 if (!task) throw new OperatorError('The selected task is no longer available. Run harness checks setup again.');
 return task;
}
async function assertCurrent(project: string, saved: SavedDraft): Promise<void> {
 if (taskDigest(await currentTask(project, saved.taskId)) !== saved.inputDigest || await sourceDigest(project) !== saved.sourceDigest) throw new OperatorError('The source or task changed since this draft was prepared.', 'Run harness checks setup and choose to draft again.');
 const approval = await readApproval(project);
 const generated = saved.manifest.cases.filter(c => c.tasks.length === 1 && c.tasks[0] === saved.taskId);
 const expected = saved.proposal.manifest.cases;
 if (generated.length !== expected.length || generated.some((c, i) => {
  const original = expected[i]!;
  return !c.id.endsWith('-' + original.id) || digest({ ...c, id: original.id }) !== digest({ ...original, contract: saved.proposal.contract, taskDigest: saved.inputDigest });
 })) throw new OperatorError('Saved commands do not match the reviewed proposal. Draft checks again.');
 const retained = (manifest: CheckManifest) => manifest.cases.filter(c => !(c.tasks.length === 1 && c.tasks[0] === saved.taskId));
 if (digest(retained(saved.manifest)) !== digest(approval ? retained(approval.manifest) : [])) throw new OperatorError('The draft would alter checks for other tasks. Draft checks again.');
 if ((approval?.digest ?? null) !== saved.baseApprovalDigest && approval?.digest !== digest(saved.manifest)) throw new OperatorError('Approved checks changed since this draft was prepared.', 'Run harness checks setup and choose to draft again; newer checks will be preserved.');
}
export async function readGuidedDraft(project: string): Promise<SavedDraft | undefined> {
 const raw = await readArtifact(directory(project), 'guided-draft.json', 8 * 1024 * 1024);
 if (!raw) return undefined;
 const saved = JSON.parse(raw) as SavedDraft;
 if (saved.version !== 1 || typeof saved.taskId !== 'string' || typeof saved.inputDigest !== 'string' || typeof saved.sourceDigest !== 'string') throw new OperatorError('Invalid saved check draft.');
 saved.proposal = parseProposal(saved.proposal, await currentTask(project, saved.taskId));
 saved.manifest = parseChecks(saved.manifest);
 return saved;
}
export function describeProposal(io: Dialogue, proposal: Proposal, task: Feature): void {
 io.write(`Review proposed checks: ${task.title}`);
 io.write('These are proposed checks, not successful verification results.');
 for (const c of proposal.manifest.cases) io.write(`  • ${c.description}`);
 io.write('Interface choices the builder will receive:'); io.write(proposal.contract);
 io.write('Coverage against the approved requirements:');
 for (const coverage of proposal.coverage) {
  io.write(`  ${coverage.criterion}. ${task.criteria[coverage.criterion - 1]}`);
  io.write(coverage.cases.length ? `     Proposed checks: ${coverage.cases.join(', ')}` : '     Not automatically checked.');
  if (coverage.limitation) io.write(`     Limitation: ${coverage.limitation}`);
 }
 io.write('Approval does not waive any task criteria. Unchecked aspects still need separate evidence.');
 io.write('Approval replaces previous cases scoped only to this task; checks for other tasks are retained.');
}
export async function reviewGuidedDraft(project: string, io: Dialogue, draft?: SavedDraft): Promise<void> {
 const saved = draft ?? await readGuidedDraft(project);
 if (!saved) throw new OperatorError('No generated check draft is saved.', 'Run harness checks setup.');
 await assertCurrent(project, saved);
 describeProposal(io, saved.proposal, await currentTask(project, saved.taskId));
 for (;;) {
  const action = await choose(io, 'Review actions', ['Approve these behaviours and interface choices', 'View technical commands and expected results', 'Save for later']);
  if (action === 1) { io.write(JSON.stringify(saved.manifest, null, 2)); continue; }
  if (action !== 0) { io.write('Draft saved. Continue with harness checks review; nothing was approved.'); return; }
  if (!await confirmed(io, 'Approve this draft, including the stated limitations?')) return;
  await withWriter(project, 'checks approve', async () => {
   await assertCurrent(project, saved);
   if (await readArtifact(directory(project), 'guided-draft.json', 8 * 1024 * 1024) !== JSON.stringify(saved, null, 2) + '\n') throw new OperatorError('The draft changed while you reviewed it. Run harness checks review again.');
   const file = path.join(directory(project), 'draft.json');
   await atomicWrite(file, JSON.stringify(saved.manifest, null, 2) + '\n');
   await approveChecks(project, file);
  });
  io.write('Checks approved. Saved interface choices will be passed to the builder.');
  io.write(`Next: harness work ${saved.taskId}`); return;
 }
}
export async function guidedSetup(project: string, task: Feature, io: Dialogue, drafter: Drafter = generateProposal): Promise<void> {
 const existing = await readGuidedDraft(project).catch((error: Error) => { io.write(`Saved draft cannot be reused: ${error.message}`); return undefined; });
 if (existing?.taskId === task.id) {
  const option = await choose(io, 'A saved draft exists for this task', ['Review saved draft (no model request)', 'Draft again with changes']);
  if (option < 0) return;
  if (option === 0) return reviewGuidedDraft(project, io, existing);
 }
 const feedback = (await io.ask('Anything to add or change? (Enter to use the saved plan and criteria):')).trim();
 io.write('Drafting checks from the saved plan, criteria and source using your configured model. Application source is read-only.');
 let saved!: SavedDraft;
 await withWriter(project, 'checks draft', async () => {
  const fresh = await currentTask(project, task.id);
  const source = await sourceDigest(project);
  const previous = await readApproval(project);
  const proposal = parseProposal(await drafter(project, fresh, feedback, existing?.taskId === task.id ? existing.proposal : undefined), fresh);
  if (source !== await sourceDigest(project) || taskDigest(fresh) !== taskDigest(await currentTask(project, task.id))) throw new OperatorError('Project changed while drafting. Retry setup.');
  if ((await readApproval(project))?.digest !== previous?.digest) throw new OperatorError('Checks changed while drafting. Retry setup.');
  const prefix = randomUUID().slice(0, 8);
  const manifest = parseChecks({ version: 1, cases: [...(previous?.manifest.cases.filter(c => !(c.tasks.length === 1 && c.tasks[0] === fresh.id)) ?? []), ...proposal.manifest.cases.map(c => ({ ...c, id: `${fresh.id}-${prefix}-${c.id}`, contract: proposal.contract, taskDigest: taskDigest(fresh) }))] });
  saved = { version: 1, taskId: fresh.id, inputDigest: taskDigest(fresh), sourceDigest: source, baseApprovalDigest: previous?.digest ?? null, proposal, manifest };
  await mkdir(directory(project), { recursive: true, mode: 0o700 });
  await atomicWrite(path.join(directory(project), 'guided-draft.json'), JSON.stringify(saved, null, 2) + '\n');
 });
 await reviewGuidedDraft(project, io, saved);
}
