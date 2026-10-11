import {browserProtocol} from '../browser/runtime.ts';
import {withCheckBudget,type CheckSpend} from './budget.ts';
/** Explicit draft migration. Original bytes and approvals remain authority until renewed review. */
import {randomUUID} from 'node:crypto';import path from 'node:path';import {mkdir,readdir,rm} from 'node:fs/promises';
import {refreshHelperPins} from './helper-pins.ts';import {parseChecks,type AcceptanceCase} from './checks.ts';
import {assertServerRuntimes} from './server-runtime.ts';import {observationWindow} from '../browser/timing.ts';
import {readArtifact,atomicWrite} from '../planning/store.ts';import {harnessDirectory} from '../record/record.ts';import {withWriter} from '../workspace/writer-lock.ts';import {OperatorError} from '../verbs/io.ts';
import {syntaxIssues} from './repair.ts';import {requestScopedReview} from './scoped-review.ts';import {readFeatures,type Feature} from '../features.ts';import type {Proposal} from './draft.ts';
export interface MigrationChange {id:string;reasons:string[];entry:AcceptanceCase;}
export function migrationDocument(raw:any,negativeWindow?:number,protocol?:string){
 if(negativeWindow!==undefined&&(!Number.isSafeInteger(negativeWindow)||negativeWindow<100||negativeWindow>10000))throw new OperatorError('Choose a negative observation window between 100 and 10000 ms.');
 const next=structuredClone(raw),changes:MigrationChange[]=[],blocked:{id:string;reason:string}[]=[];
 let visited=0;
 const walk=(node:any,depth=0)=>{
  if(!node||typeof node!=='object')return;if(++visited>20000||depth>40)throw new OperatorError('Migration document exceeds structural limits.');
  if(typeof node.id==='string'&&Array.isArray(node.tasks)&&Array.isArray(node.steps)){
   const before=JSON.stringify(node),reasons:string[]=[];
   try{
    if(node.kind==='browser'){
     if(protocol&&raw.browserRuntime?.protocol!==protocol)reasons.push(`Browser observation semantics require independent review for protocol ${protocol}; original approval stays unchanged.`);
     for(const step of node.browser?.steps??[]){
      if(step.observation!==undefined)continue;
      try{const window=observationWindow(step);if(window){step.observation=window;reasons.push('Explicit bounded positive timing; renewed review required.');}}
      catch{if(negativeWindow===undefined)throw new OperatorError('An explicit negative observation window is required.');step.observation={mode:'during',milliseconds:negativeWindow};reasons.push(`Negative observation now covers ${negativeWindow} ms; renewed approval required.`);}
     }
    }else{
     const updated=refreshHelperPins({version:1,contract:'migration context',coverage:[],manifest:{version:1,cases:[node]}},node.id).manifest.cases[0]!;
     if(JSON.stringify(updated)!==before){Object.assign(node,updated);reasons.push('Helper or recipe fingerprint changed; independent review required.');}
    }
    parseChecks({version:1,cases:[node]});assertServerRuntimes({version:1,cases:[node]});
    if((JSON.stringify(node)!==before||reasons.length>0)&&!changes.some(c=>c.id===node.id))changes.push({id:node.id,reasons,entry:structuredClone(node)});
   }catch(error){Object.keys(node).forEach(k=>delete node[k]);Object.assign(node,JSON.parse(before));blocked.push({id:node.id,reason:(error as Error).message});}
   return;
  }
  // Retained replies and retired designs are historical input, never migration targets.
  for(const key of ['proposal','manifest','state','cases','pendingRefinement'])if(node[key]!==undefined)walk(node[key],depth+1);
  if(Array.isArray(node))for(const value of node)walk(value,depth+1);
 };
 walk(next);
 const affected=new Set(changes.map(c=>c.id));
 const invalidate=(node:any)=>{if(!node||typeof node!=='object')return;
  if(Array.isArray(node.entries))node.entries=node.entries.filter((e:any)=>!affected.has(e?.scope));
  if(affected.size){delete node.validation;}
  for(const key of ['proposal','manifest','state','ledger','reviewLedger'])if(node[key])invalidate(node[key]);
 };
 if(affected.size)invalidate(next);
 return {next,changes,blocked,requiresApproval:changes.length>0};
}
const documents=['approved.json','guided-draft.json','review-progress.json','preparation.json','draft.json'] as const;
interface DocumentChange {file:string;before:string;after:string;changes:MigrationChange[];blocked:{id:string;reason:string}[];reviewed:string[];written?:boolean;}
interface Journal {version:1;protocol:string;negativeWindow?:number;documents:DocumentChange[];status:'pending'|'prepared';}
export async function migrationReport(project:string,negativeWindow?:number){
 const root=path.join(harnessDirectory(project),'acceptance'),result:DocumentChange[]=[],protocol=await browserProtocol();
 for(const file of documents){const before=await readArtifact(root,file,8*1024*1024);if(!before)continue;const raw=JSON.parse(before);if(raw.version!==1)throw new OperatorError(`${file}: unsupported version; retained unchanged.`);
  const change=migrationDocument(raw,negativeWindow,protocol);result.push({file,before,after:JSON.stringify(change.next,null,2)+'\n',changes:change.changes,blocked:change.blocked,reviewed:[]});}
 return result;
}
export type MigrationReviewer=(change:MigrationChange,document:DocumentChange)=>Promise<void>;
/** Callers hold the project writer lock. Each saved phase is replay-safe after host interruption. */
export async function prepareMigration(project:string,options:{negativeWindow?:number;maxCases?:number;restart?:boolean;review:MigrationReviewer;checkpoint?:(phase:string)=>Promise<void>}){
 const root=path.join(harnessDirectory(project),'acceptance'),dir=path.join(root,'migration');await mkdir(dir,{recursive:true,mode:0o700});
 let saved=await readArtifact(dir,'journal.json',48*1024*1024);
 if(saved&&options.restart){await mkdir(dir+'/history',{recursive:true,mode:0o700});await atomicWrite(dir+'/history/'+randomUUID()+'.json',saved);await rm(dir+'/journal.json');saved=undefined;}
 let journal:Journal=saved?JSON.parse(saved):{version:1,protocol:await browserProtocol(),...(options.negativeWindow===undefined?{}:{negativeWindow:options.negativeWindow}),documents:await migrationReport(project,options.negativeWindow),status:'pending'};
 if(journal.version!==1||!Array.isArray(journal.documents)||journal.documents.length>5||journal.documents.some(d=>!documents.includes(d.file as typeof documents[number])))throw new OperatorError('Invalid migration journal.');
 if(journal.protocol!==await browserProtocol())throw new OperatorError('Runner semantics changed during migration; saved originals remain retained. Use checks migrate --prepare --restart to start a new reviewed migration.');
 if(saved&&journal.negativeWindow===undefined&&options.negativeWindow!==undefined&&journal.documents.every(d=>!d.reviewed.length&&!d.written)){journal={version:1,protocol:journal.protocol,negativeWindow:options.negativeWindow,documents:await migrationReport(project,options.negativeWindow),status:'pending'};await atomicWrite(dir+'/journal.json',JSON.stringify(journal,null,2)+'\n');}
 if(saved&&options.negativeWindow!==undefined&&options.negativeWindow!==journal.negativeWindow)throw new OperatorError('A saved migration uses a different window. Finish or inspect it before choosing another.');
 const save=()=>{const bytes=JSON.stringify(journal,null,2)+'\n';if(Buffer.byteLength(bytes)>48*1024*1024)throw new OperatorError('Migration journal exceeds 48 MiB.');return atomicWrite(dir+'/journal.json',bytes);};
 if(!saved)await save();
 // Recompute proposed changes from retained original bytes. Journal edits cannot forge review authority.
 for(const d of journal.documents){const expected=migrationDocument(JSON.parse(d.before),journal.negativeWindow,journal.protocol);if(d.after!==JSON.stringify(expected.next,null,2)+'\n'||JSON.stringify(d.changes)!==JSON.stringify(expected.changes)||JSON.stringify(d.blocked)!==JSON.stringify(expected.blocked))throw new OperatorError('Migration proposal changed. Inspect the retained originals.');
  const now=await readArtifact(root,d.file,8*1024*1024);if(now!==d.before&&!(d.file!=='approved.json'&&now===d.after))throw new OperatorError(`${d.file} changed during migration; no newer work was overwritten.`);}
 if(journal.documents.some(d=>d.blocked.length))throw new OperatorError('Migration needs a window or unsupported-format decision.',journal.documents.flatMap(d=>d.blocked.map(b=>`${d.file} / ${b.id}: ${b.reason}`)).join('\n'));
 const max=options.maxCases??4;if(!Number.isSafeInteger(max)||max<1||max>100)throw new OperatorError('Migration batch must contain 1–100 cases.');let reviewed=0;
 for(const d of journal.documents){
  for(const c of d.changes){if(d.reviewed.includes(c.id))continue;if(reviewed>=max)return journal;
   await options.review(c,d);d.reviewed.push(c.id);reviewed++;await save();await options.checkpoint?.('reviewed');}
  if(!d.changes.length)continue;
  for(const other of journal.documents){const now=await readArtifact(root,other.file,8*1024*1024);if(now!==other.before&&!(other.file!=='approved.json'&&now===other.after))throw new OperatorError(`${other.file} changed during migration; no newer work was overwritten.`);}
  if(d.written)continue;
  // Archive exact original bytes before publication; old approvals are never replaced here.
  await atomicWrite(dir+'/'+d.file+'.original',d.before);
  const target=d.file==='approved.json'?dir+'/approval-proposal.json':root+'/'+d.file;
  const output=d.file==='approved.json'?JSON.stringify(JSON.parse(d.after).manifest,null,2)+'\n':d.after;
  await atomicWrite(target,output);await options.checkpoint?.('written');d.written=true;await save();
 }
 journal.status='prepared';await save();return journal;
}
export async function migrateChecks(project:string,prepare:boolean,negativeWindow:number|undefined,write:(s:string)=>void,restart=false){
 const report=await migrationReport(project,negativeWindow);
 for(const d of report){for(const c of d.changes)write(`${d.file} / ${c.id}: ${c.reasons.join(' ')}`);for(const b of d.blocked)write(`${d.file} / ${b.id}: decision needed: ${b.reason}`);}
 for(const impact of await migrationImpact(project))write(impact);
 write('Prior approvals and staged evidence remain unchanged. Changed timing/helper receipts cannot authorize a new candidate; affected staged work needs fresh verification.');
 if(!prepare)return;
 const features=await readFeatures(project);if(!features?.ok)throw new OperatorError('Migration needs the saved task requirements.');
 const state=await withWriter(project,'checks migrate',async()=>{const dir=path.join(harnessDirectory(project),'acceptance','migration');await mkdir(dir,{recursive:true,mode:0o700});const spend:CheckSpend={requests:0},allowance=dir+'/allowance-'+randomUUID()+'.json';return withCheckBudget({maxRequests:4,maxSeconds:600,requestSeconds:180},spend,()=>atomicWrite(allowance,JSON.stringify(spend,null,2)+'\n'),write,()=>prepareMigration(project,{restart,...(negativeWindow===undefined?{}:{negativeWindow}),review:async(c,d)=>{
  const tasks=features.features.filter(t=>c.entry.tasks.includes(t.id)||c.entry.tasks.includes('*'));if(!tasks.length)throw new OperatorError(`${c.id}: task requirements are missing.`);
  const task:Feature={...tasks[0]!,criteria:tasks.flatMap(t=>t.criteria)};
  const saved=JSON.parse(d.after),contract=c.entry.contract??saved.proposal?.contract??saved.state?.blueprint?.contract;
  if(typeof contract!=='string'||!contract.trim())throw new OperatorError(`${c.id}: no saved interface contract for independent migration review.`);
  const p:Proposal={version:1,contract,coverage:task.criteria.map((_,i)=>({criterion:i+1,cases:[],limitation:'This migration reviews only the selected case and its existing promised observations. Other criteria retain their separate evidence obligations.'})),manifest:{version:1,cases:[c.entry]}};
  const syntax=await syntaxIssues(p);if(syntax.length)throw new OperatorError(`${c.id}: ${syntax.join('; ')}`);
  const review=await requestScopedReview(project,task,p,c.id,c.reasons,write);if(review.verdict!=='pass')throw new OperatorError(`${c.id}: migration requires repair.`,review.issues.join('\n'));
 } }));});
 write(state.status==='prepared'?'Migration drafts prepared. Review the saved draft; use checks migrate --approve for the retained approval proposal. New application verification remains required.':'Migration batch paused; completed independent reviews are saved. Resume checks migrate --prepare.');
}

/** Historical records are reported, never rewritten or relabelled as new evidence. */
export async function migrationImpact(project:string):Promise<string[]>{
 const root=harnessDirectory(project),protocol=await browserProtocol(),messages:string[]=[];
 const pending=await readArtifact(root+'/acceptance','simplification.json',8*1024*1024);
 if(pending){const change=migrationDocument(JSON.parse(pending),undefined,protocol);for(const c of [...change.changes,...change.blocked])messages.push(`Pending simplification / ${c.id}: retains its original source/review identity; resume or explicitly revise this transaction before it can supply migrated evidence.`);}
 if(await readArtifact(root+'/acceptance','recipe-change.json',8*1024*1024))messages.push('Pending recipe configuration retained: resume its settings review against the current recipe before approval.');
 const list=async(directory:string)=>{const names=await readdir(directory).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return [];throw e;});if(names.length>2000)throw new OperatorError('Migration inventory exceeds 2000 retained entries.');return names.sort();};
 for(const name of await list(root+'/browser/approvals')){if(!/^web-journey-[a-f0-9-]{36}\.json$/.test(name))continue;const raw=await readArtifact(root+'/browser/approvals',name,1024*1024);if(!raw)continue;const value=JSON.parse(raw);if(value.runtime?.protocol!==protocol)messages.push(`Browser approval ${name}: stale observation protocol; retained for history, requires renewed approval and execution.`);}
 for(const id of await list(root+'/staging')){if(!/^r[1-9][0-9]*$/.test(id))continue;const raw=await readArtifact(root+'/staging/'+id,'state.json',8*1024*1024);if(!raw)continue;const state=JSON.parse(raw);if(['pending','applying'].includes(state.status))messages.push(`Staged ${id}: retained candidate and approval ${state.acceptance?.approvalDigest??'unknown'}; revalidate affected checks before application. Migration does not rewrite staged receipts.`);}
 return messages;
}

/** Approval is a separate operator action; migration cannot mint application evidence. */
export async function approveMigration(project:string,io:import('../guide/dialogue.ts').Dialogue,approve:(project:string,file:string)=>Promise<unknown>=async(p,f)=>(await import('./checks.ts')).approveChecks(p,f)){
 const dir=path.join(harnessDirectory(project),'acceptance','migration');
 const journal=await readArtifact(dir,'journal.json',48*1024*1024),proposal=await readArtifact(dir,'approval-proposal.json',8*1024*1024);
 if(!journal||!proposal||JSON.parse(journal).status!=='prepared')throw new OperatorError('Finish checks migrate --prepare before approving migrated expectations.');
 const saved=JSON.parse(journal) as Journal,approved=saved.documents.find(d=>d.file==='approved.json');
 if(!approved||proposal!==JSON.stringify(JSON.parse(approved.after).manifest,null,2)+'\n')throw new OperatorError('Migration approval proposal changed.');
 io.write(proposal);io.write('Only these expectations are being approved. Old execution results remain historical; the application must be verified again.');
 const {confirmed}=await import('../guide/dialogue.ts');if(!await confirmed(io,'Approve these migrated expectations and their observation windows?'))return;
 await withWriter(project,'checks migrate approve',async()=>{
  if(await readArtifact(dir,'journal.json',48*1024*1024)!==journal||await readArtifact(dir,'approval-proposal.json',8*1024*1024)!==proposal)throw new OperatorError('Migration changed during approval. Review it again.');
  const current=await prepareMigration(project,{review:async()=>{throw new OperatorError('Migration still requires independent review.');}});
  if(current.status!=='prepared')throw new OperatorError('Migration still requires independent review.');
  await approve(project,dir+'/approval-proposal.json');
 });
 io.write('Migrated expectations approved. Prior approvals are retained; run verification before applying any candidate.');
}
