import {ensureCheckBudget,CheckBudgetExceeded} from './budget.ts';
import {recipeForDescription,inferWebRecipe,recipeDescription} from './recipes/catalog.ts';
import {blockedScopes, renewScope, repairScopeInIsolation} from './targeted.ts';
import {simplifyInParts, simplificationServices, type SimplificationState} from './simplification.ts';
import {assertServerRuntimes} from './server-runtime.ts';
import { validateProposal, proposalDigest, type DraftValidation } from "./repair.ts";
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { prepareInParts, blueprintProposal, parseBlueprint, type Preparation } from './preparation.ts';
import { validateInScopes, scopeDigest, type ReviewLedger } from './scoped-review.ts';
import path from 'node:path';
import { readFeatures, type Feature } from '../features.ts';
import { readArtifact, atomicWrite } from '../planning/store.ts';
import { sourceFiles } from '../workspace/candidate.ts';
import { readProfile } from '../project/profile.ts';
import { getAdapter } from '../adapters/registry.ts';
import { withWriter } from '../workspace/writer-lock.ts';
import { harnessDirectory } from '../record/record.ts';
import { choose, confirmed, type Dialogue } from '../guide/dialogue.ts';
import { readApproval, approveChecks, parseChecks, parseCheckDraft, type CheckManifest } from './checks.ts';
import { generateProposal, parseProposal, taskDigest, type Proposal } from './draft.ts';
import { OperatorError } from '../verbs/io.ts';

interface SavedDraft { validation?: DraftValidation; version: 1; taskId: string; inputDigest: string; sourceDigest: string; baseApprovalDigest: string | null; proposal: Proposal; manifest: CheckManifest; }
export type Drafter = typeof generateProposal;
export type Validator = typeof validateProposal;
const isReviewed = (saved: SavedDraft) => saved.validation?.version === 1 && saved.validation.status === "reviewed" && saved.validation.digest === proposalDigest(saved.proposal);
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
export async function readGuidedDraft(project: string, recovering = false): Promise<SavedDraft | undefined> {
 const raw = await readArtifact(directory(project), 'guided-draft.json', 8 * 1024 * 1024);
 if (!raw) return undefined;
 const saved = JSON.parse(raw) as SavedDraft;
 if (saved.version !== 1 || typeof saved.taskId !== 'string' || typeof saved.inputDigest !== 'string' || typeof saved.sourceDigest !== 'string') throw new OperatorError('Invalid saved check draft.');
 saved.proposal = parseProposal(saved.proposal, await currentTask(project, saved.taskId));
 saved.manifest = recovering ? parseCheckDraft(saved.manifest) : parseChecks(saved.manifest);
 return saved;
}
export async function readyCheckDraft(project:string):Promise<boolean>{
 const saved=await readGuidedDraft(project,true);if(!saved||!isReviewed(saved))return false;
 await assertCurrent(project,saved);
 try{parseChecks(saved.manifest);assertServerRuntimes(saved.manifest);return true;}catch{return false;}
}
export function describeProposal(io: Dialogue, proposal: Proposal, task: Feature): void {
 io.write(`Review proposed checks: ${task.title}`);
 io.write('These are proposed checks, not successful verification results.');
 for (const c of proposal.manifest.cases){io.write(`  • ${c.description}`);for(const s of c.steps)if(s.recipe)io.write('    '+recipeDescription(s.recipe));}
 io.write('An interface contract is saved with these behaviours. View the interface contract for exact routes, fields and startup choices.');
 io.write('Coverage against the approved requirements:');
 for (const coverage of proposal.coverage) {
  io.write(`  ${coverage.criterion}. ${task.criteria[coverage.criterion - 1]}`);
  io.write(coverage.cases.length ? `     Proposed checks: ${coverage.cases.join(', ')}` : '     Not automatically checked.');
  if (coverage.limitation) io.write(`     Limitation: ${coverage.limitation}`);
 }
 io.write('Approval does not waive any task criteria. Unchecked aspects still need separate evidence.');
 io.write('Approval replaces previous cases scoped only to this task; checks for other tasks are retained.');
}
export async function reviewGuidedDraft(project: string, io: Dialogue, draft?: SavedDraft, validator: Validator = validateProposal): Promise<void> {
 if(await readArtifact(directory(project),'recipe-change.json',8*1024*1024))return useRecipeSavedCheck(project,io,undefined,{resume:true});
 if(await readArtifact(directory(project),'simplification.json',8*1024*1024))return simplifySavedCheck(project,io);
 const saved = draft ?? await readGuidedDraft(project,true);
 if (!saved && await resumePreparation(project, io)) return;
 if (!saved) throw new OperatorError('No generated check draft is saved.', 'Run harness checks setup.');
 await assertCurrent(project, saved);
 let currentHelpers=true;try{parseChecks(saved.manifest);assertServerRuntimes(saved.manifest);}catch{currentHelpers=false;}
 if (!isReviewed(saved)||!currentHelpers) {
  io.write(currentHelpers?'This draft predates automatic quality review. Checking and repairing it before approval…':'Refreshing changed helpers and independently reviewing affected checks before approval…');
  return guidedSetup(project, await currentTask(project, saved.taskId), io, generateProposal, validator, saved.proposal);
 }
 io.write(`Draft quality reviewed in ${saved.validation!.rounds} round(s). This is not an application test result.`);
 for (const limitation of saved.validation!.limitations) io.write(`Reviewer limitation: ${limitation}`);
 describeProposal(io, saved.proposal, await currentTask(project, saved.taskId));
 for (;;) {
  const action = await choose(io, 'Review actions', ['Approve these behaviours and interface choices', 'View technical commands and expected results', 'Save for later', 'View the interface contract']);
  if (action === 1) { io.write(JSON.stringify(saved.manifest, null, 2)); continue; }
  if (action === 3) { io.write(saved.proposal.contract); continue; }
  if (action !== 0) { io.write('Draft saved. Continue with harness checks review; nothing was approved.'); return; }
  if (!await confirmed(io, 'Approve this draft, including the stated limitations?')) return;
  await withWriter(project, 'checks approve', async () => {
   await assertCurrent(project, saved);
   assertServerRuntimes(saved.manifest);
   if (await readArtifact(directory(project), 'guided-draft.json', 8 * 1024 * 1024) !== JSON.stringify(saved, null, 2) + '\n') throw new OperatorError('The draft changed while you reviewed it. Run harness checks review again.');
   const file = path.join(directory(project), 'draft.json');
   await atomicWrite(file, JSON.stringify(saved.manifest, null, 2) + '\n');
   await approveChecks(project, file);
  });
  io.write('Checks approved. Saved interface choices will be passed to the builder.');
  io.write(`Next: harness work ${saved.taskId}`); return;
 }
}
export async function guidedSetup(project: string, task: Feature, io: Dialogue, drafter: Drafter = generateProposal, validator: Validator = validateProposal, automatic?: Proposal, resume = false, deferApproval = false): Promise<void> {
 if(resume&&await readArtifact(directory(project),'recipe-change.json',8*1024*1024))return useRecipeSavedCheck(project,io,undefined,{resume:true});
 if(resume&&await readArtifact(directory(project),'simplification.json',8*1024*1024))return simplifySavedCheck(project,io);
 const existing = await readGuidedDraft(project).catch((error: Error) => { io.write(`Saved draft cannot be reused: ${error.message}`); return undefined; });
 let freshPreparation = false;
 if (!automatic && !resume && existing?.taskId === task.id) {
  const option = await choose(io, 'A saved draft exists for this task', [isReviewed(existing) ? 'Review saved draft (no model request)' : 'Check and repair saved draft automatically', 'Draft again with changes']);
  if (option < 0) return;
  if (option === 0) return reviewGuidedDraft(project, io, existing, validator);
  freshPreparation = true;
 }
 if (!automatic && !resume && !existing) {
  const incomplete = await readArtifact(directory(project),'review-progress.json',8*1024*1024) ?? await readArtifact(directory(project),'preparation.json',8*1024*1024);
  if (incomplete && JSON.parse(incomplete).taskId === task.id) {
   const record=JSON.parse(incomplete);
   const repairable=record.ledger && blockedScopes(task,parseProposal(record.proposal,task),record.ledger).length;
   const option=await choose(io,'Preparation is saved for this task',['Resume saved preparation (reuse completed reviews)','Prepare again with changes',...(repairable?['Repair a blocked check (keep the other checks)','Simplify a blocked check into smaller checks']:[])]);
   if(option<0)return;
   if(option===0)return guidedSetup(project,task,io,drafter,validator,undefined,true);
   if(option===2)return repairSavedCheck(project,io);
   if(option===3)return simplifySavedCheck(project,io);
   freshPreparation=true;
  }
 }
 const feedback = automatic || resume ? '' : (await io.ask('Anything to add or change? (Enter to use the saved plan and criteria):')).trim();
 io.write('Preparing and independently reviewing checks with your configured model. Application source is read-only.');
 let saved!: SavedDraft;
 await withWriter(project, 'checks draft', async () => {
  const fresh = await currentTask(project, task.id);
  const source = await sourceDigest(project);
  const previous = await readApproval(project);
  await mkdir(directory(project), { recursive: true, mode: 0o700 });
  let pending: Proposal | undefined;
  let previousIssues: string[] = [];
  let previousProposal = existing?.taskId===task.id ? existing.proposal : undefined;
  const earlierPreparation=await readArtifact(directory(project),'preparation.json',8*1024*1024);
  if(earlierPreparation){
   const prior=JSON.parse(earlierPreparation);
   if(prior.taskId===fresh.id&&prior.taskDigest===taskDigest(fresh)&&prior.sourceDigest===source){
    if(prior.state?.blueprint)previousProposal=blueprintProposal(fresh,parseBlueprint(prior.state.blueprint,fresh));
    else if(prior.previousProposal)previousProposal=parseProposal(prior.previousProposal,fresh);
    const issues=[...(prior.previousIssues??[]),...(prior.state?.outlineReview?.review?.issues??[])];
    if(issues.every((issue:unknown)=>typeof issue==='string'))previousIssues=[...new Set<string>(issues)];
   }
  }
  const priorRaw=await readArtifact(directory(project),'review-progress.json',8*1024*1024);
  if(priorRaw){
   const prior=JSON.parse(priorRaw);
   if(prior.taskId===fresh.id&&prior.taskDigest===taskDigest(fresh)&&prior.sourceDigest===source){
    previousProposal=parseProposal(prior.proposal,fresh);
    if(Array.isArray(prior.issues)&&prior.issues.every((issue:unknown)=>typeof issue==='string'))previousIssues=prior.issues;
   }
  }
  if (freshPreparation || feedback) {
   for (const name of ['review-progress.json', 'preparation.json', 'guided-draft.json', 'simplification.json','recipe-change.json']) {
    const old = await readArtifact(directory(project), name, 8 * 1024 * 1024);
    if (old) {const history = path.join(directory(project), 'review-history');await mkdir(history,{recursive:true,mode:0o700});await atomicWrite(path.join(history,`${Date.now()}-${randomUUID()}.json`),old);}
    await rm(path.join(directory(project),name),{force:true});
   }
  }
  let ledger: ReviewLedger | undefined;
  const progress = await readArtifact(directory(project), 'review-progress.json', 8 * 1024 * 1024);
  if (!feedback && progress) {
   const record = JSON.parse(progress);
   if (record.taskId === fresh.id && record.taskDigest === taskDigest(fresh) && record.sourceDigest === source) {
    if (Array.isArray(record.issues) && record.issues.every((issue: unknown) => typeof issue === 'string')) previousIssues = record.issues;
    if (record.ledger?.version === 1 && Array.isArray(record.ledger.entries)) ledger = record.ledger;
    pending = parseProposal(record.proposal, fresh); io.write('Resuming the saved check draft; no requirements need retyping.');
   }
  }
  const prepare = async () => {
   if (drafter !== generateProposal) return parseProposal(await drafter(project,fresh,feedback,previousProposal),fresh);
   const raw = await readArtifact(directory(project),'preparation.json',8*1024*1024);
   const record = raw ? JSON.parse(raw) : undefined;
   const reusable = record?.taskId===fresh.id && record.taskDigest===taskDigest(fresh) && record.sourceDigest===source;
   if(reusable)io.write('Resuming saved behaviour preparation; completed checks will be reused.');
   const request = {
    version:1,taskId:fresh.id,taskDigest:taskDigest(fresh),sourceDigest:source,
    feedback:reusable && typeof record.feedback==='string' ? record.feedback : feedback,
    previousProposal:reusable && record.previousProposal ? parseProposal(record.previousProposal,fresh) : previousProposal,
    previousIssues:reusable && Array.isArray(record.previousIssues) && record.previousIssues.every((issue:unknown)=>typeof issue==='string') ? record.previousIssues as string[] : previousIssues,
    ...(reusable && record.state ? {state:record.state as Preparation} : {}),
   };
   const save = async (state?:Preparation) => {
    await atomicWrite(path.join(directory(project),'preparation.json'),JSON.stringify({...request,...(state?{state}:{})},null,2)+'\n');
   };
   // Save the request before contacting the provider, including before an outline exists.
   await save();
   return prepareInParts(project,fresh,request.feedback,request.previousProposal,save,io.write,request.state,request.previousIssues);
  };
  const partialRaw = await readArtifact(directory(project),'preparation.json',8*1024*1024);
  const partial = partialRaw ? JSON.parse(partialRaw) : undefined;
  const hasPartial = partial?.taskId===fresh.id && partial.taskDigest===taskDigest(fresh) && partial.sourceDigest===source;
  const initial = pending ?? (hasPartial ? await prepare() : automatic ?? await prepare());
  const checkpoint = async (proposal: Proposal, round: number, issues: string[]) => {
   const record = JSON.stringify({ version: 1, taskId: fresh.id, taskDigest: taskDigest(fresh), sourceDigest: source, proposal, round, issues, ...(ledger ? {ledger} : {}) }, null, 2) + '\n';
   const history = path.join(directory(project), 'review-history');
   await mkdir(history, { recursive: true, mode: 0o700 });
   await atomicWrite(path.join(history, `${Date.now()}-${randomUUID()}.json`), record);
   await atomicWrite(path.join(directory(project), 'review-progress.json'), record);
  };
  if (!pending && !ledger) {
   const completedRaw=await readArtifact(directory(project),'preparation.json',8*1024*1024);
   const completed=completedRaw?JSON.parse(completedRaw):undefined;
   if(completed?.taskId===fresh.id && completed.taskDigest===taskDigest(fresh) && completed.sourceDigest===source && completed.state?.outlineReview?.review?.verdict==='pass'){
    const b=completed.state.blueprint;
    if(JSON.stringify({contract:b.contract,coverage:b.coverage,cases:b.cases})===JSON.stringify({contract:initial.contract,coverage:initial.coverage,cases:initial.manifest.cases.map(c=>({id:c.id,description:c.description}))}))ledger={version:1,entries:[{scope:'$contract',digest:scopeDigest(fresh,initial,'$contract'),repairs:0,syntaxRepairs:0,review:completed.state.outlineReview.review}]};
   }
  }
  if(previousIssues.length)ledger={...(ledger??{version:1,entries:[]}),previousIssues:[...new Set([...(ledger?.previousIssues??[]),...previousIssues])]};
  await checkpoint(initial, 0, previousIssues);
  const { proposal, validation } = validator === validateProposal
   ? await validateInScopes(project,fresh,initial,io.write,async(p,current)=>{ledger=current;await checkpoint(p,0,[...(current.previousIssues??[]),...current.entries.flatMap(e=>e.review?.issues??[])]);},ledger)
   : await validator(project, fresh, initial, io.write, checkpoint, previousIssues);
  if (source !== await sourceDigest(project) || taskDigest(fresh) !== taskDigest(await currentTask(project, task.id))) throw new OperatorError('Project changed while drafting. Retry setup.');
  if ((await readApproval(project))?.digest !== previous?.digest) throw new OperatorError('Checks changed while drafting. Retry setup.');
  const prefix = randomUUID().slice(0, 8);
  const manifest = parseChecks({ version: 1, cases: [...(previous?.manifest.cases.filter(c => !(c.tasks.length === 1 && c.tasks[0] === fresh.id)) ?? []), ...proposal.manifest.cases.map(c => ({ ...c, id: `${fresh.id}-${prefix}-${c.id}`, contract: proposal.contract, taskDigest: taskDigest(fresh) }))] });
  saved = { validation, version: 1, taskId: fresh.id, inputDigest: taskDigest(fresh), sourceDigest: source, baseApprovalDigest: previous?.digest ?? null, proposal, manifest };
  await mkdir(directory(project), { recursive: true, mode: 0o700 });
  await atomicWrite(path.join(directory(project), 'guided-draft.json'), JSON.stringify(saved, null, 2) + '\n');
 });
 if(deferApproval)io.write("Checks prepared and saved. Review with harness checks review; nothing was approved.");
 else await reviewGuidedDraft(project, io, saved, validator);
}

/** Resume a first preparation even if no complete guided draft has been produced yet. */
export async function resumePreparation(project:string,io:Dialogue,deferApproval=false):Promise<boolean>{
 if(await readArtifact(directory(project),'recipe-change.json',8*1024*1024)){await useRecipeSavedCheck(project,io,undefined,{resume:true});return true;}
 if(await readArtifact(directory(project),'simplification.json',8*1024*1024)){await simplifySavedCheck(project,io);return true;}
 for(const name of ['review-progress.json','preparation.json']){
  const raw=await readArtifact(directory(project),name,8*1024*1024);if(!raw)continue;
  const record=JSON.parse(raw);const task=await currentTask(project,record.taskId);
  if(record.taskDigest!==taskDigest(task)||record.sourceDigest!==await sourceDigest(project))throw new OperatorError('Saved preparation describes older source or requirements.','Run harness checks setup to prepare checks for the current task.');
  if(record.proposal&&record.ledger){const p=parseProposal(record.proposal,task);const suitable=p.manifest.cases.find(c=>!c.steps.some(s=>s.recipe)&&recipeForDescription(c.description??'')&&!record.ledger.entries.some((e:{scope:string;review?:{verdict:string}})=>e.scope===c.id&&e.review?.verdict==='pass'));if(suitable){io.write('A tested recipe can replace this generated parser check.');await useRecipeSavedCheck(project,io,suitable.id);return true;}}
  await guidedSetup(project,task,io,generateProposal,validateProposal,undefined,true,deferApproval);return true;
 }
 return false;
}

/** Stage an explicit design revision separately; commit it only after its new checks pass review. */
export async function simplifySavedCheck(project:string,io:Dialogue,caseId?:string,servicesFactory=simplificationServices):Promise<void>{
 if(await readArtifact(directory(project),'recipe-change.json',8*1024*1024))throw new OperatorError('A recipe migration is pending.','Resume checks use-recipe before changing another check.');
 const raw=await readArtifact(directory(project),'review-progress.json',8*1024*1024);
 if(!raw)throw new OperatorError('No saved check review to simplify.','Use harness checks setup.');
 const record=JSON.parse(raw), task=await currentTask(project,record.taskId), p=parseProposal(record.proposal,task);
 const pendingRaw=await readArtifact(directory(project),'simplification.json',8*1024*1024);
 const pending=pendingRaw?JSON.parse(pendingRaw):undefined;
 const current=async()=>{
  if(record.taskDigest!==taskDigest(await currentTask(project,task.id))||record.sourceDigest!==await sourceDigest(project))throw new OperatorError('Saved checks describe older source or requirements.','Use harness checks setup.');
 };
 await current();
 if(pending&&(pending.taskDigest!==record.taskDigest||pending.sourceDigest!==record.sourceDigest))throw new OperatorError('Saved simplification describes older source or requirements.');
 const ledger=record.ledger as ReviewLedger;
 if(ledger?.version!==1||!Array.isArray(ledger.entries))throw new OperatorError('No scoped review history to simplify.');
 const ids=blockedScopes(task,p,ledger);
 let scope=caseId??pending?.scope;
 if(pending&&caseId&&caseId!==pending.scope)throw new OperatorError('Another check simplification is pending.','Resume harness checks simplify before selecting another check.');
 if(!scope){
  if(!ids.length)throw new OperatorError('No blocked check to simplify.','Use harness checks review.');
  const index=await choose(io,'Which blocked check should be simplified?',ids.map(id=>p.manifest.cases.find(c=>c.id===id)!.description!));
  if(index<0)return;scope=ids[index]!;
 }
 if(!pending&&!ids.includes(scope))throw new OperatorError('Select a blocked check.');
 const selected:string=scope;
 await withWriter(project,'checks simplify',async()=>{
  await current();
  if(await readArtifact(directory(project),'review-progress.json',8*1024*1024)!==raw||await readArtifact(directory(project),'simplification.json',8*1024*1024)!==pendingRaw)throw new OperatorError('Saved checks changed during selection. Run checks simplify again.');
  const approval=(await readApproval(project))?.digest??null;
  if(pending&&pending.approvalDigest!==approval)throw new OperatorError('Approvals changed during simplification.');
  if(pending?.completedDigest===proposalDigest(p)){
   await rm(path.join(directory(project),'simplification.json'),{force:true});return;
  }
  if(pending&&pending.baseDigest!==proposalDigest(p))throw new OperatorError('The original check draft changed during simplification.');
  const history=path.join(directory(project),'review-history');await mkdir(history,{recursive:true,mode:0o700});
  if(!pending)await atomicWrite(path.join(history,`${Date.now()}-${randomUUID()}-before-simplification.json`),raw);
  const header={version:1,taskId:task.id,taskDigest:record.taskDigest,sourceDigest:record.sourceDigest,baseDigest:proposalDigest(p),approvalDigest:approval,scope:selected};
  const save=async(state:SimplificationState)=>{await current();if(((await readApproval(project))?.digest??null)!==approval)throw new OperatorError('Approvals changed during simplification.');await atomicWrite(path.join(directory(project),'simplification.json'),JSON.stringify({...header,state},null,2)+'\n');};
  const findings=ledger.entries.find(e=>e.scope===selected)?.review?.issues??ledger.entries.find(e=>e.scope===selected)?.previousIssues??[];
  io.write(pending?'Resuming saved simplification; completed stages are reused.':'Simplifying one blocked design. Other checks and approvals remain unchanged.');
  let result:Awaited<ReturnType<typeof simplifyInParts>>;
  try{result=await simplifyInParts(task,p,selected,ledger,servicesFactory(project,task,p,selected,findings,save,io.write),pending?.state);}
  catch(error){
   if(error instanceof CheckBudgetExceeded)throw error;
   const e=error as Error&{remedy?:string};
   throw new OperatorError(e.message,[e.remedy,'Simplification progress is saved; the original draft and approvals are unchanged. After a provider interruption, resume with harness checks simplify. If the design or its budget is exhausted, use checks setup and Prepare again with changes.'].filter(Boolean).join('\n'));
  }
  await current();
  if(((await readApproval(project))?.digest??null)!==approval||await readArtifact(directory(project),'review-progress.json',8*1024*1024)!==raw)throw new OperatorError('Checks or approvals changed during simplification.');
  const checkpoint=JSON.parse((await readArtifact(directory(project),'simplification.json',8*1024*1024))!);
  await atomicWrite(path.join(directory(project),'simplification.json'),JSON.stringify({...checkpoint,completedDigest:proposalDigest(result.proposal)},null,2)+'\n');
  const oldDraft=await readArtifact(directory(project),'guided-draft.json',8*1024*1024);
  if(oldDraft&&JSON.parse(oldDraft).taskId===task.id){await atomicWrite(path.join(history,`${Date.now()}-${randomUUID()}-guided-draft.json`),oldDraft);await rm(path.join(directory(project),'guided-draft.json'));}
  const updated={...record,proposal:result.proposal,ledger:result.ledger,issues:[...(result.ledger.previousIssues??[]),...result.ledger.entries.flatMap(e=>e.review?.issues??[])],simplified:{scope:selected,at:new Date().toISOString()}};
  const text=JSON.stringify(updated,null,2)+'\n';await atomicWrite(path.join(history,`${Date.now()}-${randomUUID()}-simplified.json`),text);
  await atomicWrite(path.join(directory(project),'review-progress.json'),text);await rm(path.join(directory(project),'simplification.json'),{force:true});
 });
 io.write('The smaller checks passed design review. No application work or approval was performed.');
 io.write('Next: harness checks review. Review all stated evidence limits before approving.');
}

/** The operator chooses a fresh bounded attempt; ordinary resume never resets budgets. */
export async function repairSavedCheck(project:string,io:Dialogue,caseId?:string,repair=repairScopeInIsolation):Promise<void>{
 if(caseId&&repair===repairScopeInIsolation){const raw=await readArtifact(directory(project),'review-progress.json',8*1024*1024);const c=raw?JSON.parse(raw).proposal?.manifest?.cases?.find((c:{id:string})=>c.id===caseId):undefined;if(c&&(c.steps.some((s:{recipe?:unknown})=>s.recipe)||recipeForDescription(c.description??'')))return useRecipeSavedCheck(project,io,caseId);}
 if(await readArtifact(directory(project),'simplification.json',8*1024*1024))throw new OperatorError('A design simplification is pending.','Resume harness checks simplify, or use checks setup to prepare again with changes.');
 const file=path.join(directory(project),'review-progress.json');
 const raw=await readArtifact(directory(project),'review-progress.json',8*1024*1024);
 if(!raw)throw new OperatorError('No saved check review to repair.','Run harness checks setup.');
 const record=JSON.parse(raw);const task=await currentTask(project,record.taskId);
 const proposal=parseProposal(record.proposal,task);
 const checkCurrent=async()=>{
  if(record.taskDigest!==taskDigest(await currentTask(project,task.id))||record.sourceDigest!==await sourceDigest(project))throw new OperatorError('Saved checks describe older source or requirements.','Use harness checks setup to prepare a current draft.');
 };
 await checkCurrent();
 const ledger=record.ledger as ReviewLedger;
 if(ledger?.version!==1||!Array.isArray(ledger.entries))throw new OperatorError('This draft has no scoped review history.','Use harness checks review first.');
 const ids=blockedScopes(task,proposal,ledger);
 if(!ids.length)throw new OperatorError('No check has an interrupted or exhausted repair.','Use harness checks review to resume saved work.');
 io.write('Repair one blocked check with a fresh, bounded attempt. Existing findings are retained; other checks and approvals are preserved.');
 let selected=caseId;
 if(!selected){const index=await choose(io,'Which blocked check should be repaired?',ids.map(id=>proposal.manifest.cases.find(c=>c.id===id)!.description!));if(index<0)return;selected=ids[index]!;}
 if(!ids.includes(selected))throw new OperatorError('Select one of the blocked checks.');
 const scope=selected;
 if(repair===repairScopeInIsolation){const c=proposal.manifest.cases.find(c=>c.id===scope)!;if(c.steps.some(s=>s.recipe)||recipeForDescription(c.description??''))return useRecipeSavedCheck(project,io,scope);}
 await withWriter(project,'checks repair',async()=>{
  await checkCurrent();
  if(await readArtifact(directory(project),'review-progress.json',8*1024*1024)!==raw)throw new OperatorError('Saved checks changed during selection. Run harness checks repair again.');
  const approval=(await readApproval(project))?.digest;
  const history=path.join(directory(project),'review-history');await mkdir(history,{recursive:true,mode:0o700});
  await atomicWrite(path.join(history,`${Date.now()}-${randomUUID()}-before-targeted-repair.json`),raw);
  const save=async(p:Proposal,current:ReviewLedger)=>{
   const updated={...record,proposal:p,ledger:current,issues:[...(current.previousIssues??[]),...current.entries.flatMap(e=>e.review?.issues??[])],targetedRetry:{scope,at:new Date().toISOString()}};
   const text=JSON.stringify(updated,null,2)+'\n';
   await atomicWrite(path.join(history,`${Date.now()}-${randomUUID()}.json`),text);await atomicWrite(file,text);
  };
  const renewed=renewScope(task,proposal,ledger,scope);
  await save(proposal,renewed);
  // A prior full-draft receipt cannot authorize subsequently repaired code.
  const oldDraft=await readArtifact(directory(project),'guided-draft.json',8*1024*1024);
  if(oldDraft&&JSON.parse(oldDraft).taskId===task.id){await atomicWrite(path.join(history,`${Date.now()}-${randomUUID()}-guided-draft.json`),oldDraft);await rm(path.join(directory(project),'guided-draft.json'));}
  await repair(project,task,proposal,scope,renewed,save,io.write);
  await checkCurrent();
  if((await readApproval(project))?.digest!==approval)throw new OperatorError('Approvals changed during repair. Review the current draft again.');
 });
 io.write('The selected check passed design review. Other generated checks are retained; the application has not been tested or changed.');
 io.write('Next: harness checks review. Nothing was approved.');
}

/** Replace a generated implementation with settings for tested infrastructure; approval stays separate. */
export async function useRecipeSavedCheck(project:string,io:Dialogue,caseId?:string,options:{settings?:unknown;resume?:boolean;reviewer?:(project:string,task:Feature,p:Proposal,scope:string)=>Promise<import('./repair.ts').DraftReview>}={}):Promise<void>{
 if(await readArtifact(directory(project),'simplification.json',8*1024*1024))throw new OperatorError('A simplification is pending.','Resume checks simplify or archive it through checks setup before switching paths.');
 const {recipeForDescription,inferWebRecipe,recipeCase,recipeDescription,compileRecipe}=await import('./recipes/catalog.ts');
 const {requestScopedReview}=await import('./scoped-review.ts');
 const {parseDraftReview}=await import('./repair.ts');
 const raw=await readArtifact(directory(project),'review-progress.json',8*1024*1024);
 if(!raw)throw new OperatorError('No saved check to convert.','Use harness checks setup. Supported new behaviours use recipes automatically.');
 const record=JSON.parse(raw),task=await currentTask(project,record.taskId),p=parseProposal(record.proposal,task);
 const pendingRaw=await readArtifact(directory(project),'recipe-change.json',8*1024*1024),pending=pendingRaw?JSON.parse(pendingRaw):undefined;
 const current=async()=>{if(record.taskDigest!==taskDigest(await currentTask(project,task.id))||record.sourceDigest!==await sourceDigest(project))throw new OperatorError('Saved recipe inputs changed.','Use checks setup to prepare from current source and requirements.');};
 await current();
 if(pending?.committedDigest===digest(raw)){await withWriter(project,'checks recipe',()=>rm(path.join(directory(project),'recipe-change.json')));io.write('The recipe migration was already saved. Next: harness checks review.');return;}
 const candidates=p.manifest.cases.filter(c=>c.steps.some(s=>s.recipe)||recipeForDescription(c.description??''));
 let scope=caseId??pending?.scope;
 if(!scope){const index=await choose(io,'Use a tested recipe for which check?',candidates.map(c=>c.description??c.id));if(index<0)return;scope=candidates[index]!.id;}
 const selected=candidates.find(c=>c.id===scope);if(!selected)throw new OperatorError('No supported recipe matches this selected behaviour.','This release supports Node web assets and SQLite database boundaries; other behaviours keep their existing review path.');
 const existing=selected.steps.find(s=>s.recipe)?.recipe;
 let settings=options.settings??pending?.settings??existing??inferWebRecipe(p.contract);
 if(options.settings===undefined&&!options.resume){
  if(settings){io.write(recipeDescription(compileRecipe(settings).recipe!));const action=await choose(io,'Recipe settings',['Use settings from the saved contract','Edit the project settings']);if(action<0)return;if(action===1)settings=undefined;}
  if(!settings){const old=pending?.settings??existing??inferWebRecipe(p.contract);const ask=async(label:string,value:string)=>((await io.ask(`${label}${value?' ['+value+']':''}:`)).trim()||value);
   settings={kind:'node-web-sqlite',version:1,entry:await ask('Node entry file',old?.entry??''),databaseEnv:await ask('Database environment variable',old?.databaseEnv??''),portEnv:await ask('Port environment variable',old?.portEnv??'PORT'),readinessPrefix:(await io.ask(`Literal text before the ready URL, including trailing spaces [${JSON.stringify(old?.readinessPrefix??'Listening at ')}]:`))||(old?.readinessPrefix??'Listening at '),entryPath:await ask('Application path',old?.entryPath??'/'),publicPaths:(await ask('Public read paths, comma-separated',old?.publicPaths.join(',')??'')).split(',').map(x=>x.trim()),rejectHost:Number(await ask('Wrong Host response status',String(old?.rejectHost??403))),rejectOrigin:Number(await ask('Wrong Origin response status',String(old?.rejectOrigin??403)))};
  }
 }
 if(!settings)throw new OperatorError('The saved contract does not unambiguously specify recipe settings.','Use harness checks use-recipe to enter the short project settings; no probe code is needed.');
 const replacement=recipeCase({id:selected.id,description:selected.description!},task.id,settings);settings=replacement.steps[0]!.recipe;
 const candidate=parseProposal({...p,manifest:{...p.manifest,cases:p.manifest.cases.map(c=>c.id===scope?replacement:c)}},task);
 const changed=!!pending&&JSON.stringify(pending.settings)!==JSON.stringify(settings);
 if(pending&&!changed&&pending.candidateDigest!==proposalDigest(candidate))throw new OperatorError('Recipe implementation changed during preparation.','Use checks setup to prepare with the current recipe version.');
 if(pending&&(pending.baseDigest!==digest(raw)||pending.taskDigest!==record.taskDigest||pending.sourceDigest!==record.sourceDigest||pending.scope!==scope))throw new OperatorError('Pending recipe settings describe different inputs.','Use checks setup and Prepare again with changes to archive stale preparation.');
 io.write(recipeDescription(replacement.steps[0]!.recipe!));
 await withWriter(project,'checks recipe',async()=>{
  await current();if(await readArtifact(directory(project),'review-progress.json',8*1024*1024)!==raw)throw new OperatorError('Saved checks changed during recipe selection.');
  const approval=(await readApproval(project))?.digest??null;
  if(changed){const history=path.join(directory(project),'review-history');await mkdir(history,{recursive:true,mode:0o700});await atomicWrite(path.join(history,`${Date.now()}-${randomUUID()}-recipe-settings.json`),pendingRaw!);}
  const state=(!changed?pending:undefined)??{version:1,candidateDigest:proposalDigest(candidate),baseDigest:digest(raw),taskDigest:record.taskDigest,sourceDigest:record.sourceDigest,scope,settings,approvalDigest:approval,reviewStarted:false};
  if(state.approvalDigest!==approval)throw new OperatorError('Approvals changed during recipe preparation.');
  const save=()=>atomicWrite(path.join(directory(project),'recipe-change.json'),JSON.stringify(state,null,2)+'\n');await save();
  if(!state.review){
   if(state.reviewStarted&&options.resume)throw new OperatorError('The recipe settings review was interrupted.','Use harness checks use-recipe for one explicit retry. The candidate and previous checks are saved.');
   ensureCheckBudget();state.reviewStarted=true;await save();io.write('Reviewing only recipe settings and requirement coverage; no probe generation or code repair.');
   try {state.review=parseDraftReview(await (options.reviewer??((project,task,p,scope)=>requestScopedReview(project,task,p,scope,[],io.write)))(project,task,candidate,scope!));}catch(error){if(error instanceof CheckBudgetExceeded){state.reviewStarted=false;await save();}throw error;}await save();
  }
  const review=parseDraftReview(state.review);
  if(review.verdict!=='pass')throw new OperatorError('Recipe settings need attention.',review.issues.join('\n')+'\nNo code-repair loop was started. Use harness checks use-recipe to edit the settings. The original draft and approval remain unchanged.');
  await current();if((await readApproval(project))?.digest!== (approval??undefined))throw new OperatorError('Approvals changed during recipe review.');
  const ledger:ReviewLedger=record.ledger??{version:1,entries:[]};
  const updated={...record,proposal:candidate,ledger:{...ledger,entries:[...ledger.entries.filter(e=>e.scope!==scope),{scope:scope!,digest:scopeDigest(task,candidate,scope!),repairs:0,syntaxRepairs:0,review}]},recipeMigration:{scope,kind:'node-web-sqlite',at:new Date().toISOString()}};
  const text=JSON.stringify(updated,null,2)+'\n';state.committedDigest=digest(text);await save();
  const history=path.join(directory(project),'review-history');await mkdir(history,{recursive:true,mode:0o700});await atomicWrite(path.join(history,`${Date.now()}-${randomUUID()}-before-recipe.json`),raw);
  const draft=await readArtifact(directory(project),'guided-draft.json',8*1024*1024);if(draft&&JSON.parse(draft).taskId===task.id){await atomicWrite(path.join(history,`${Date.now()}-${randomUUID()}-guided-draft.json`),draft);await rm(path.join(directory(project),'guided-draft.json'));}
  await atomicWrite(path.join(directory(project),'review-progress.json'),text);await rm(path.join(directory(project),'recipe-change.json'));
 });
 io.write('The generated check is replaced by a reviewed recipe configuration. Other checks are retained.');io.write('Next: harness checks review. Nothing was approved; application behaviour still needs verification after implementation.');
}
