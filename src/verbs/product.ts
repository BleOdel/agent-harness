import {choose,confirmed,terminalDialogue,type Dialogue} from '../guide/dialogue.ts';
import {withWriter} from '../workspace/writer-lock.ts';
import {approveProduct,draftProduct,kinds,readProduct,verificationPlan} from '../product/spec.ts';
import {productReport,recordAssessment} from '../product/report.ts';
import {verify} from './verify.ts';
import {mlChoices} from '../product/evidence/ml.ts';
import {desktopChoices} from '../product/evidence/desktop.ts';
import type {EvidenceScope} from '../product/evidence/schema.ts';
import {say,OperatorError} from './io.ts';
export async function productSetup(project:string,io:Dialogue):Promise<void>{
 const selected=await choose(io,'What are you building?',['Command-line tool or library','API or service','Website or web app','Desktop app','ML or deep learning project']);if(selected<0)return;
 const risk=await choose(io,'Consequences of failure',['Prototype or ordinary local use','Sensitive data or consequential use']);if(risk<0)return;
 const previous=await readProduct(project);
 const input=(await io.ask(`Additional product documents to protect (relative paths, comma-separated; Enter for ${Object.keys(previous?.documents??{}).join(', ')||'none'}):`)).trim();
 const documents=input?input.split(',').map(s=>s.trim()):Object.keys(previous?.documents??{});
 let evidence:EvidenceScope|undefined=previous&&previous.kind===kinds[selected]?previous.evidence:undefined;
 if(kinds[selected]==='desktop'||kinds[selected]==='ml'){
  const choices=await (kinds[selected]==='ml'?mlChoices:desktopChoices)(project);
  io.write(kinds[selected]==='ml'?'Select required ML workflows. Quality, checkpoints, demonstrated recovery and application integration remain separate. CPU regression becomes selectable once its job captures a runtime.':'Required desktop evidence: select every target journey this product needs. Linux Electron, macOS Electron and SwiftUI/AppKit are distinct targets.');
  choices.forEach((c,i)=>io.write(`  ${i+1}. ${c.title} [${c.target.provider}] (${c.target.approval})`));
  const existing=evidence?.targets??[];
  io.write(`Current selection: ${existing.map(t=>t.provider+':'+t.approval).join(', ')||'none; desktop evidence remains incomplete'}`);
  const answer=(await io.ask('Required workflow or journey numbers, comma-separated (Enter to keep; none to clear):')).trim();
  if(answer==='none')evidence={version:1,targets:[]};
  else if(answer){const indexes=answer.split(',').map(s=>Number(s.trim())-1);if(indexes.some(i=>!Number.isInteger(i)||i<0||i>=choices.length)||new Set(indexes).size!==indexes.length)throw new OperatorError('Use unique listed numbers from the list. No settings saved.');evidence={version:1,targets:indexes.map(i=>choices[i]!.target)};}
 }
 const draft=await draftProduct(project,kinds[selected]!,risk===0?'prototype':'sensitive',documents,evidence);
 io.write('Product specification uses the accepted work items, their saved plans and approved interface contracts.');
 for(const task of draft.requirements.tasks as {id:string;criteria:string[]}[]){io.write(task.id);task.criteria.forEach(c=>io.write(`  ${c}`));}
 io.write(`Saved interface contracts: ${draft.requirements.interfaces.length}. Protected documents: ${documents.join(', ')||'none'}.`);
 for(const contract of draft.requirements.interfaces)io.write(`${contract.tasks.join(', ')}: ${contract.contract}`);
 io.write('Required verification:');verificationPlan(draft.kind,draft.consequence).forEach(c=>io.write(`  ${c}`));
 for(const t of draft.evidence?.targets??[])io.write(`Required evidence: ${t.provider} / ${t.approval}. Approval and runtime are pinned; unrelated experiments are excluded.`);
 io.write('Changed requirements require renewed approval. Builders cannot edit protected documents. Setup does not run checks or approve a release.');
 if(await confirmed(io,'Approve this product specification?')){
  await withWriter(project,'product setup',()=>approveProduct(project,draft));
  io.write('Product specification saved outside source. Next: harness product report');
 }
}
export async function productCommand(project:string,args:readonly string[]):Promise<void>{
 if(args[0]==='setup'&&args.length===1)return productSetup(project,terminalDialogue());
 if(args[0]==='verify'&&args.length===1)return verify(project,['--acceptance']);
 if(args[0]==='assess'&&args.length===1){
  const io=terminalDialogue(),report=await productReport(project);
  if(!report.source||!report.spec)throw new OperatorError('Approve a current product specification first.','Run harness product setup.');
  for(const check of report.checks)io.write(`${check.status}: ${check.id} — ${check.detail}`);
  io.write('This records your assessment only. It cannot override missing or failed automated checks, native/ML evidence gaps, or separate security and performance assessments.');
  const notes=await io.ask('Describe what you inspected, the evidence used and remaining limits:');
  const passed=await confirmed(io,'Does your human assessment pass?');
  if(await confirmed(io,'Save this assessment for the current source and specification?'))await withWriter(project,'product assess',()=>recordAssessment(project,report.source!,report.spec!,passed,notes,report.evidenceDigest));
  return;
 }
 if((!args.length||args[0]==='report')&&args.length<=2&&(!args[1]||args[1]==='--json')){
  const report=await productReport(project);
  if(args[1]==='--json')say(JSON.stringify(report,null,2));
  else{say(`Product evidence: ${report.ready?'complete for the approved scope':'needs attention'}`);for(const c of report.checks)say(`${c.status}: ${c.id} — ${c.detail}`);const next=report.checks.find(c=>c.status!=='passed'&&c.status!=='skipped'&&c.next);if(next?.next)say(`Next: ${next.next}`);say('This report is not release approval or a guarantee of correctness. Environment readiness: harness doctor.');}
  if(!report.ready)process.exitCode=1;return;
 }
 throw new OperatorError('Use: harness product setup | report [--json] | verify | assess');
}
