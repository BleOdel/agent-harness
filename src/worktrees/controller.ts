/** Optional host-owned Git delivery. Workers still receive snapshots without .git. */
import {randomUUID} from 'node:crypto';
import {lstat,readFile,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {run} from '../run.ts';
import {readJson,saveJson,safeDirectory,stateRoot,sha256} from '../artifacts/store.ts';
import {withWriter} from '../workspace/writer-lock.ts';
import {readFeatures} from '../features.ts';
import {readRecord,undoableRuns} from '../record/record.ts';
import {readProfile} from '../project/profile.ts';
import {getAdapter} from '../adapters/registry.ts';
import {resolveModelSettings} from '../model-settings.ts';
import {taskDigest} from '../acceptance/draft.ts';
import {requireChecks,readApproval,assertAcceptanceProof,verifyAcceptance} from '../acceptance/checks.ts';
import {assertProductCurrent} from '../product/spec.ts';
import {captureBaseline,assertLiveBaseline,sourceFiles} from '../workspace/candidate.ts';
import {loadConfig} from '../config.ts';
import {verify} from '../verbs/verify.ts';
import {OperatorError} from '../verbs/io.ts';
export interface TaskWorktree {
 version:1;id:string;project:string;task:string;branch:string;target:string;base:string;checkout:string;
 controls:string;status:'creating'|'ready'|'committed'|'merging'|'verified'|'merged'|'removed';tip?:string;
 integration?:string;targetHead?:string;mergeCommit?:string;error?:string;
}
const validId=(id:string)=>/^worktree-[a-f0-9-]{36}$/u.test(id);
const hex=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{40,64}$/u.test(v);
const absent=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT';
export async function checkedGit(project:string,args:readonly string[]):Promise<string>{
 const result=await run('git',['-C',project,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.attributesFile=/dev/null','-c','merge.default=text','-c','gc.auto=0','-c','maintenance.auto=false','-c','commit.gpgSign=false','-c','protocol.file.allow=never',...args],{
  timeoutMs:60000,maxOutputBytes:2*1024*1024,env:{...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_'))),GIT_TERMINAL_PROMPT:'0',GIT_ATTR_NOSYSTEM:'1'},
 });
 if(result.code!==0||result.timedOut||result.outputLimited)throw new OperatorError(`Git ${args[0]} failed: ${result.stderr.trim()||result.stdout.trim()||'timeout/output limit'}`);
 return result.stdout.trimEnd();
}
async function rootProject(project:string){
 project=await realpath(project);const top=await checkedGit(project,['rev-parse','--show-toplevel']);
 if(await realpath(top)!==project||!(await lstat(path.join(project,'.git'))).isDirectory())throw new OperatorError('Manage task worktrees from the primary repository root.');
 return project;
}
async function clean(project:string,ignored=false){
 const status=await checkedGit(project,['status','--porcelain','--untracked-files=all',...(ignored?['--ignored']:[])]);
 if(status)throw new OperatorError(`A clean working tree is required: ${project}. Commit or preserve your files first. No files were reset.`);
}
async function ordinaryFiles(project:string){
 const names=(await checkedGit(project,['ls-files','-z','--cached','--others','--exclude-standard'])).split('\0');
 if(names.some(n=>['.gitattributes','.gitmodules'].includes(path.posix.basename(n))))throw new OperatorError('This first worktree workflow does not support Git attributes/filters or submodules.');
 if(await checkedGit(project,['config','--type=bool','--default=false','--get','core.sparseCheckout'])==='true')throw new OperatorError('Sparse checkouts are not supported by this worktree workflow.');
 const stages=await checkedGit(project,['ls-files','--stage']);if(stages.split('\n').some(s=>s.startsWith('160000 ')))throw new OperatorError('Submodule worktrees are not supported.');
 const attributes=await checkedGit(project,['rev-parse','--git-path','info/attributes']);
 const content=await readFile(path.resolve(project,attributes)).catch(e=>{if(absent(e))return Buffer.alloc(0);throw e;});
 if(content.toString().trim())throw new OperatorError('Repository info/attributes is unsupported by the worktree workflow.');
 // Also rejects symlinks and special source files before invoking Git checkout/add.
 const profile=await readProfile(project),files=await sourceFiles(project,'',getAdapter(profile.adapter).source.generatedDirectories);
 if(Object.keys(files).some(n=>['.gitattributes','.gitmodules'].includes(path.posix.basename(n))))throw new OperatorError('Ignored Git attributes or submodule files are also unsupported.');
}
async function root(project:string){const r=path.join(await stateRoot(project),'worktrees');await safeDirectory(r);return r;}
async function directory(project:string,id:string){if(!validId(id))throw new OperatorError('Invalid worktree ID. Use harness worktree list.');return path.join(await root(project),id);}
async function save(w:TaskWorktree){await saveJson(await directory(w.project,w.id),'state.json',w);}
async function read(project:string,id:string):Promise<TaskWorktree>{
 project=await rootProject(project);const dir=await directory(project,id);await lstat(dir);await safeDirectory(dir);const w=await readJson(dir,'state.json') as TaskWorktree;
 if(w.version!==1||w.id!==id||w.project!==project||w.checkout!==path.join(dir,'checkout')||typeof w.task!=='string'||!/^harness\/[a-z0-9-]+-[a-f0-9]{8}$/u.test(w.branch)||typeof w.target!=='string'||!w.target||w.target.startsWith('-')||!hex(w.base)||!hex(w.controls)||!['creating','ready','committed','merging','verified','merged','removed'].includes(w.status)||(w.tip!==undefined&&!hex(w.tip))||(w.integration!==undefined&&(!/^integration-[a-f0-9-]{36}$/u.test(path.basename(w.integration))||path.dirname(w.integration)!==dir))||(w.mergeCommit!==undefined&&!hex(w.mergeCommit)))throw new OperatorError('Invalid managed worktree record.');
 return w;
}
async function controls(project:string){
 const list=await readFeatures(project);if(!list?.ok)throw new OperatorError('Accept work items before creating a task worktree.');
 const model=resolveModelSettings(project,{});
 const files:Record<string,unknown>={'project.json':await readProfile(project),'model.json':{version:1,...(model.provider?{provider:model.provider}:{}),...(model.model?{model:model.model}:{}),effort:model.effort}};
 const approval=await readApproval(project);if(approval)files['acceptance/approved.json']=approval;
 const product=await assertProductCurrent(project);if(product)files['product/approved.json']=product;
 const requirements=list.features.map(t=>({id:t.id,digest:taskDigest(t),priority:t.priority,scope:t.changeScope??[]})).sort((a,b)=>a.id.localeCompare(b.id));
 return {files,digest:sha256(JSON.stringify({files,requirements}))};
}
async function copyControls(project:string,checkout:string,expected:string){
 const c=await controls(project);if(c.digest!==expected)throw new OperatorError('Approved controls changed. Create a fresh worktree from the current requirements.');
 const state=await stateRoot(checkout);
 for(const [file,value]of Object.entries(c.files)){await safeDirectory(path.dirname(path.join(state,file)));await saveJson(state,file,value);}
 const approval=await readApproval(checkout);if(approval){await safeDirectory(path.join(state,'acceptance/approvals'));await saveJson(state,`acceptance/approvals/${approval.digest}.json`,approval.manifest);}
}
async function unchangedControls(w:TaskWorktree){
 if((await controls(w.project)).digest!==w.controls||(await controls(w.checkout)).digest!==w.controls)throw new OperatorError('Approved controls or requirements changed. Retain this work; create a fresh worktree with current approvals.');
}
async function registered(w:TaskWorktree){
 const registry=(await checkedGit(w.project,['worktree','list','--porcelain','-z'])).split('\0');
 if(!registry.includes(`worktree ${w.checkout}`))throw new OperatorError('Managed checkout is missing from Git. Inspect it with harness worktree recover.');
 if(await checkedGit(w.checkout,['branch','--show-current'])!==w.branch)throw new OperatorError('Task checkout branch changed; refusing to operate.');
 const common=await checkedGit(w.checkout,['rev-parse','--git-common-dir']);
 if(await realpath(path.resolve(w.checkout,common))!==await realpath(path.join(w.project,'.git')))throw new OperatorError('Task checkout belongs to a different Git repository.');
 if(await realpath(w.checkout)!==w.checkout)throw new OperatorError('Managed checkout cannot be a symlink.');
}
export async function listWorktrees(project:string){project=await rootProject(project);const all=[];for(const id of (await readdir(await root(project))).sort())if(validId(id))all.push(await read(project,id));return all;}
export async function createWorktree(project:string,task:string):Promise<TaskWorktree>{
 project=await rootProject(project);return withWriter(project,'worktree create',async()=>{
  await clean(project);await ordinaryFiles(project);const target=await checkedGit(project,['branch','--show-current']);if(!target)throw new OperatorError('Check out a target branch before creating a worktree.');
  const list=await readFeatures(project);if(!list?.ok||!list.features.some(t=>t.id===task&&t.priority!=='wont'))throw new OperatorError('Select an accepted, non-deferred task.');
  await requireChecks(project,[task]);
  if((await listWorktrees(project)).some(w=>w.task===task&&!['merged','removed'].includes(w.status)))throw new OperatorError('This task already has an unfinished worktree. Use worktree list and resume it.');
  const id=`worktree-${randomUUID()}`,dir=await directory(project,id);await safeDirectory(dir);
  const c=await controls(project),base=await checkedGit(project,['rev-parse','HEAD']);
  const branch=`harness/${task.toLowerCase().replace(/[^a-z0-9-]/gu,'-').slice(0,40)||'task'}-${id.slice(9,17)}`;
  const w:TaskWorktree={version:1,id,project,task,branch,target,base,checkout:path.join(dir,'checkout'),controls:c.digest,status:'creating'};
  await save(w);
  try{await checkedGit(project,['worktree','add','-b',branch,w.checkout,base]);await copyControls(project,w.checkout,w.controls);await unchangedControls(w);w.status='ready';await save(w);return w;}
  catch(e){w.error=(e as Error).message;await save(w);throw e;}
 });
}
export async function worktreeForWork(project:string,id:string){const w=await read(project,id);if(!['ready','committed','merging'].includes(w.status))throw new OperatorError('Recover or finish this worktree before building.');await registered(w);await unchangedControls(w);return w;}
export async function commitWorktree(project:string,id:string):Promise<TaskWorktree>{
 project=await rootProject(project);return withWriter(project,'worktree commit',async()=>{const w=await read(project,id);return withWriter(w.checkout,'worktree commit',async()=>{
  if(!['ready','committed','merging'].includes(w.status))throw new OperatorError('Worktree is not ready for a verified commit.');await registered(w);await unchangedControls(w);await ordinaryFiles(w.checkout);
  const records=await readRecord(w.checkout);if(records.malformed.length)throw new OperatorError('Malformed task run history.');
  const applied=undoableRuns(records.runs).findLast(r=>r.goal===w.task&&!r.reverses);
  if(!applied?.acceptance||applied.review?.verdict!=='pass')throw new OperatorError('An applied, independently reviewed run is required before committing this task.');
  const profile=await readProfile(w.checkout),snap=await captureBaseline(w.checkout,path.join(await directory(project,id),`commit-${randomUUID()}`),getAdapter(profile.adapter).source.generatedDirectories);
  if(snap.digest!==applied.candidateDigest)throw new OperatorError('Source differs from the verified applied candidate. Run harness work again.');
  await assertAcceptanceProof(w.checkout,snap,[w.task],applied.acceptance);
  const tasks=await readFeatures(w.checkout);if(!tasks?.ok||tasks.features.find(t=>t.id===w.task)?.status!=='done')throw new OperatorError('The task has not completed.');
  const changed=[...(await checkedGit(w.checkout,['diff','--name-only','--no-renames','-z','HEAD'])).split('\0'),...(await checkedGit(w.checkout,['ls-files','--others','--exclude-standard','-z'])).split('\0')].filter(Boolean);
  const allowed=new Set([...Object.keys(snap.files),...applied.changes.map(c=>c.file),'features.json']);
  if(changed.some(file=>!allowed.has(file)))throw new OperatorError('Unverified or excluded files are changed in the task checkout. Preserve them before committing.');
  await checkedGit(w.checkout,['add','--all']);await assertLiveBaseline(w.checkout,snap);
  await checkedGit(w.checkout,['diff','--exit-code']);
  if(await checkedGit(w.checkout,['diff','--cached','--name-only']))await checkedGit(w.checkout,['commit','--no-gpg-sign','-m',`Implement ${w.task}\n\nVerified harness run ${applied.id}; approved acceptance ${applied.acceptance.approvalDigest}.`]);
  await assertLiveBaseline(w.checkout,snap);await unchangedControls(w);w.tip=await checkedGit(w.checkout,['rev-parse','HEAD']);w.status='committed';delete w.error;await save(w);return w;
 });});
}
/** Runs existing gates; no model call or application to the primary checkout. */
export async function verifyCombined(checkout:string):Promise<void>{
 await verify(checkout);
 const tasks=await readFeatures(checkout);if(!tasks?.ok)throw new OperatorError('Missing integrated task manifest.');
 const ids=tasks.features.filter(t=>t.priority!=='wont'&&t.status==='done').map(t=>t.id);if(!ids.length)throw new OperatorError('No completed tasks to verify.');
 const approval=await requireChecks(checkout,ids),profile=await readProfile(checkout),state=await stateRoot(checkout);
 const snap=await captureBaseline(checkout,path.join(state,`integration-proof-${randomUUID()}`),getAdapter(profile.adapter).source.generatedDirectories);
 await verifyAcceptance(checkout,snap,ids,loadConfig({...process.env,HARNESS_PROJECT:checkout}),approval);await assertLiveBaseline(checkout,snap);
}
export async function mergeWorktree(project:string,id:string,verification:(checkout:string)=>Promise<void>=verifyCombined,checkpoint?:(phase:'verified'|'merged')=>Promise<void>):Promise<TaskWorktree>{
 project=await rootProject(project);return withWriter(project,'worktree merge',async()=>{const w=await read(project,id);return withWriter(w.checkout,'worktree merge',async()=>{
  if(w.status==='merged')return w;if(!['committed','merging','verified'].includes(w.status)||!w.tip)throw new OperatorError('Commit the verified task first, or recover an interrupted merge.');
  await registered(w);await unchangedControls(w);await clean(project);await clean(w.checkout);await ordinaryFiles(project);await ordinaryFiles(w.checkout);
  if(await checkedGit(project,['branch','--show-current'])!==w.target)throw new OperatorError(`Switch the primary checkout to ${w.target} first.`);
  if(await checkedGit(w.checkout,['rev-parse','HEAD'])!==w.tip)throw new OperatorError('Task branch changed after its verified commit.');
  const targetHead=await checkedGit(project,['rev-parse','HEAD']);w.targetHead=targetHead;w.integration=path.join(await directory(project,id),`integration-${randomUUID()}`);w.status='merging';delete w.error;await save(w);
  try{
   await checkedGit(project,['worktree','add','--detach',w.integration,targetHead]);
   try{await checkedGit(w.integration,['merge','--no-commit','--no-ff',w.tip]);}catch(e){throw new OperatorError(`Integration conflict or Git merge failure. Main is unchanged; retained at ${w.integration}.`,(e as Error).message);}
   await copyControls(project,w.integration,w.controls);
   const beforeTasks=await readFeatures(project),combinedTasks=await readFeatures(w.integration);
   if(!beforeTasks?.ok||!combinedTasks?.ok)throw new OperatorError('Cannot read task completion state for integration.');
   const regressed=beforeTasks.features.filter(t=>t.status==='done'&&combinedTasks.features.find(c=>c.id===t.id)?.status!=='done');
   if(regressed.length)throw new OperatorError(`Integration would regress completion status for ${regressed.map(t=>t.id).join(', ')}. Revalidate dependent work before merging.`);
   const profile=await readProfile(w.integration),snap=await captureBaseline(w.integration,path.join(await directory(project,id),`merge-proof-${randomUUID()}`),getAdapter(profile.adapter).source.generatedDirectories);
   await verification(w.integration);await assertLiveBaseline(w.integration,snap);await unchangedControls(w);
   if(await checkedGit(project,['rev-parse','HEAD'])!==targetHead||await checkedGit(w.checkout,['rev-parse','HEAD'])!==w.tip)throw new OperatorError('Target or task branch changed during verification.');
   await clean(project);await registered(w);
   if(await checkedGit(project,['branch','--show-current'])!==w.target)throw new OperatorError('Target branch changed during verification.');
   await checkedGit(w.integration,['diff','--exit-code']);
   if(await checkedGit(w.integration,['rev-parse','HEAD'])!==targetHead)throw new OperatorError('Integration history changed during verification.');
   await checkedGit(w.integration,['commit','--no-gpg-sign','-m',`Merge verified task ${w.task}`]);await assertLiveBaseline(w.integration,snap);await clean(w.integration);
   w.mergeCommit=await checkedGit(w.integration,['rev-parse','HEAD']);w.status='verified';await save(w);await checkpoint?.('verified');
   await checkedGit(project,['merge','--ff-only','--no-overwrite-ignore',w.mergeCommit]);await checkpoint?.('merged');await assertLiveBaseline(project,snap);w.status='merged';await save(w);return w;
  }catch(e){w.error=(e as Error).message;await save(w);throw e;}
 });});
}
export async function recoverWorktree(project:string,id:string):Promise<TaskWorktree>{
 project=await rootProject(project);return withWriter(project,'worktree recover',async()=>{const w=await read(project,id);return withWriter(w.checkout,'worktree recover',async()=>{
  if(w.status==='removed'||w.status==='merged')return w;
  if(w.status==='creating'){
   const exists=await lstat(w.checkout).catch(e=>{if(absent(e))return undefined;throw e;});
   if(!exists){
    let branchTip:string|undefined;try{branchTip=await checkedGit(project,['rev-parse','--verify',`refs/heads/${w.branch}`]);}catch{/* An interrupted creation may not have created its branch. */}
    if(branchTip&&branchTip!==w.base)throw new OperatorError('Interrupted task branch changed; refusing to adopt it.');
    await checkedGit(project,branchTip?['worktree','add',w.checkout,w.branch]:['worktree','add','-b',w.branch,w.checkout,w.base]);
   }
   await registered(w);await clean(w.checkout);
   if(await checkedGit(w.checkout,['rev-parse','HEAD'])!==w.base)throw new OperatorError('Interrupted creation no longer matches its base. Retain and inspect it.');
   await copyControls(project,w.checkout,w.controls);w.status='ready';delete w.error;await save(w);return w;
  }
  if(w.status==='verified'&&w.mergeCommit&&w.targetHead&&w.integration){
   await registered(w);await unchangedControls(w);await clean(project);await clean(w.checkout);await clean(w.integration);
   if(await checkedGit(project,['branch','--show-current'])!==w.target||await checkedGit(w.integration,['rev-parse','HEAD'])!==w.mergeCommit||await checkedGit(w.checkout,['rev-parse','HEAD'])!==w.tip)throw new OperatorError('Verified integration identity changed.');
   const head=await checkedGit(project,['rev-parse','HEAD']);if(head!==w.mergeCommit){if(head===w.targetHead)await checkedGit(project,['merge','--ff-only','--no-overwrite-ignore',w.mergeCommit]);else {try{await checkedGit(project,['merge-base','--is-ancestor',w.mergeCommit,'HEAD']);}catch{throw new OperatorError('Target moved; retry worktree merge to run new integration verification.');}}}
   w.status='merged';delete w.error;await save(w);return w;
  }
  if(w.status==='merging')throw new OperatorError(`Interrupted or failed integration retained at ${w.integration}. Retry harness worktree merge ${w.id}; conflicts require a new verified task commit.`);
  await registered(w);return w;
 });});
}
export async function removeWorktree(project:string,id:string):Promise<TaskWorktree>{
 project=await rootProject(project);return withWriter(project,'worktree remove',async()=>{const w=await read(project,id);return withWriter(w.checkout,'worktree remove',async()=>{
  if(w.status==='removed')return w;if(w.status!=='merged'||!w.tip||!w.mergeCommit)throw new OperatorError('Unfinished worktree: only merged work can be removed.');
  await checkedGit(project,['merge-base','--is-ancestor',w.tip,w.target]);await checkedGit(project,['merge-base','--is-ancestor',w.mergeCommit,w.target]);
  const dir=await directory(project,id);
  const registeredPaths=(await checkedGit(project,['worktree','list','--porcelain','-z'])).split('\0').filter(s=>s.startsWith('worktree ')).map(s=>s.slice(9));
  const owned=registeredPaths.filter(p=>p===w.checkout||(path.dirname(p)===dir&&/^integration-[a-f0-9-]{36}$/u.test(path.basename(p))));
  if(owned.includes(w.checkout)){await registered(w);if(await checkedGit(w.checkout,['rev-parse','HEAD'])!==w.tip)throw new OperatorError('Task branch contains additional unfinished commits; checkout retained.');}
  for(const p of owned)await clean(p,true);
  for(const p of owned)await checkedGit(project,['worktree','remove',p]);
  w.status='removed';await save(w);return w;
 });});
}
