import {choose,confirmed,terminalDialogue,type Dialogue} from '../guide/dialogue.ts';
import {withWriter} from '../workspace/writer-lock.ts';
import {approveProduct,draftProduct,kinds,readProduct,verificationPlan} from '../product/spec.ts';
import {productReport,recordAssessment} from '../product/report.ts';
import {verify} from './verify.ts';
import {say,OperatorError} from './io.ts';
export async function productSetup(project:string,io:Dialogue):Promise<void>{
 const selected=await choose(io,'What are you building?',['Command-line tool or library','API or service','Website or web app','Desktop app','ML or deep learning project']);if(selected<0)return;
 const risk=await choose(io,'Consequences of failure',['Prototype or ordinary local use','Sensitive data or consequential use']);if(risk<0)return;
 const previous=await readProduct(project);
 const input=(await io.ask(`Additional product documents to protect (relative paths, comma-separated; Enter for ${Object.keys(previous?.documents??{}).join(', ')||'none'}):`)).trim();
 const documents=input?input.split(',').map(s=>s.trim()):Object.keys(previous?.documents??{});
 const draft=await draftProduct(project,kinds[selected]!,risk===0?'prototype':'sensitive',documents);
 io.write('Product specification uses the accepted work items, their saved plans and approved interface contracts.');
 for(const task of draft.requirements.tasks as {id:string;criteria:string[]}[]){io.write(task.id);task.criteria.forEach(c=>io.write(`  ${c}`));}
 io.write(`Saved interface contracts: ${draft.requirements.interfaces.length}. Protected documents: ${documents.join(', ')||'none'}.`);
 for(const contract of draft.requirements.interfaces)io.write(`${contract.tasks.join(', ')}: ${contract.contract}`);
 io.write('Required verification:');verificationPlan(draft.kind,draft.consequence).forEach(c=>io.write(`  ${c}`));
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
  io.write('This records your assessment only. It cannot override missing or failed automated checks, native/ML evidence gaps, or a separate security assessment.');
  const notes=await io.ask('Describe what you inspected, the evidence used and remaining limits:');
  const passed=await confirmed(io,'Does your human assessment pass?');
  if(await confirmed(io,'Save this assessment for the current source and specification?'))await withWriter(project,'product assess',()=>recordAssessment(project,report.source!,report.spec!,passed,notes));
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
