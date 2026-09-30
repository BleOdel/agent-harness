import {spawn} from 'node:child_process';
import path from 'node:path';
import {choose,confirmed,terminalDialogue,type Dialogue} from './dialogue.ts';
import {productReport,type ProductReport} from '../product/report.ts';
import {verificationActions,type VerificationAction} from '../product/actions.ts';
import {EvidenceReader} from '../product/evidence/reader.ts';
import {readSecurity} from '../security/store.ts';
import {readPerformance} from '../performance/store.ts';
import {loadConfig} from '../config.ts';
import {readApproval} from '../acceptance/checks.ts';
import {sha256} from '../artifacts/store.ts';
import type {GuideCommand} from '../verbs/guide.ts';
const execute:GuideCommand=(project,args)=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.resolve(import.meta.dirname,'../cli.ts'),...args],{stdio:'inherit',env:{...process.env,HARNESS_PROJECT:project}});child.once('error',reject);child.once('close',code=>resolve(code??1));});
export interface ActionPreview {description:string;identity:string;}
export async function previewAction(project:string,a:VerificationAction):Promise<ActionPreview>{
 let description='',authority:unknown=a.args;
 if(a.command==='harness product verify --checks'){
  const config=loadConfig({...process.env,HARNESS_PROJECT:project}),approval=await readApproval(project),steps=approval?.manifest.cases.reduce((n,c)=>n+c.steps.length,0)??0;
  description=`Runs offline project diagnostics and ${steps} approved acceptance step(s). Each project gate and acceptance step is limited to ${config.gateTimeoutMs/1000}s; the ${steps} acceptance steps have a combined command ceiling of ${steps*config.gateTimeoutMs/1000}s, plus setup/cleanup. No model requests or source application. Valid evidence is reused by the report; this action explicitly reruns diagnostics/acceptance.`;
  authority={gate:config.gateTimeoutMs,image:config.imageId,acceptance:approval?.digest};
 }else if(a.command==='harness security verify'){
  const scope=await readSecurity(project);if(!scope?.scope.recipe)throw Error('Review security setup first.');authority=scope.digest;
  description=`Approved synthetic API probes: assets ${scope.scope.assets}; boundaries ${scope.scope.boundaries}; ${scope.scope.recipe.createPath}, ${scope.scope.recipe.privatePath}, ${scope.scope.recipe.publicPath}. Expected create ${scope.scope.recipe.createStatus}, unauthorized ${scope.scope.recipe.deniedStatus}, Host ${scope.scope.recipe.hostStatus}, Origin ${scope.scope.recipe.originStatus}; zero observed key/private-data disclosures. ${scope.scope.recipe.timeoutSeconds}s observer limit, plus bounded startup/cleanup; app and observer each 2 CPUs/512 MiB; offline, no provider call. Saved matching checks are not regenerated.`;
 }else if(a.command==='harness performance verify'){
  const scope=await readPerformance(project);if(!scope)throw Error('Review performance setup first.');authority=scope.digest;const p=scope.profile;
  description=`Approved benchmark: GET ${p.path} via ${p.entry}; status ${p.expectedStatus} and the frozen JSON response. Thresholds: mean ≤ ${p.meanMs} ms, throughput ≥ ${p.minRps} requests/s, errors ≤ ${p.maxErrorPercent}%, spread ≤ ${p.maxSpreadPercent}%${scope.baseline?`, regression ≤ ${p.maxRegressionPercent}% against ${scope.baseline.run}`:"; no baseline selected"}. ${p.repetitions} repetitions × ${p.samples} measured requests, ${p.warmup} warm-ups each; ${p.requestTimeoutMs} ms/request; ${p.maxSeconds}s observation limit plus bounded startup/cleanup. App 2 CPUs, observer 1 CPU, 512 MiB each. Offline; no model call. Baseline and thresholds remain fixed.`;
 }else if(a.kind==='verify'){
  const [lane,,id]=a.args,folders:Record<string,string>={desktop:'desktop',browser:'browser',macos:'macos-gui','macos-native':'apple-gui'},folder=folders[lane!];if(!folder||!id)throw Error('Use the relevant runner guide to review execution limits.');
  const reader=new EvidenceReader(project+'-harness'),raw=await reader.json(`${folder}/approvals/${id}.json`) as any;
  if(!raw||raw.id!==id||typeof raw.digest!=='string'||!Number.isInteger(raw.journey?.timeoutSeconds))throw Error('Journey budget is unavailable; review its saved approval first.');authority=raw;await reader.assertUnchanged();
  description=`Approved ${lane} journey: ${raw.journey.timeoutSeconds}s observation limit, plus runner packaging/startup/cleanup limits. ${lane==='macos'||lane==='macos-native'?'Starts the isolated Mac VM (2 CPUs, 4096 MiB).':'Starts the approved offline Docker runtime.'} No model call; no source changes are applied. Existing approval is reused.`;
 }else if(a.kind==='configure')description='Opens the existing setup flow. Review its scope, runtime and budgets before saving; no existing passing evidence is silently reapproved. Acceptance-check preparation may make bounded provider calls shown by that command.';
 else if(a.kind==='assess')description='Records only your separate assessment against current evidence. It cannot waive missing or failed checks and starts no model or runtime.';
 else if(a.kind==='recover')description='Reconciles only the selected owned run and cleans up its resources. Inspect/recover an ended writer lock first if instructed. This does not make incomplete evidence pass.';
 else if(a.kind==='guide')description='Opens the saved project guide. Any build, training or new execution has its own scope and budget preview; nothing is started just by reading evidence.';
 else description='Reads retained records only; no model, benchmark, container or VM starts.';
 return {description,identity:sha256(JSON.stringify(authority))};
}
export async function guideProduct(project:string,io:Dialogue=terminalDialogue(),command:GuideCommand=execute,read:()=>Promise<ProductReport>=()=>productReport(project),preview:(a:VerificationAction)=>Promise<ActionPreview>=a=>previewAction(project,a)){
 for(;;){
  const report=await read(),actions=verificationActions(report);io.write(report.ready?'Evidence complete for the approved scope; this is not release approval.':'Product evidence needs attention. Passing evidence is reused.');
  report.checks.forEach(c=>io.write(`${c.status}: ${c.id} — ${c.detail}`));
  if(!actions.length){io.write('No missing action. Use explicit runner commands only if you intentionally want a new trial.');return;}
  const choice=await choose(io,'Choose the next evidence step',actions.map(a=>`${a.title} — ${a.command}`));if(choice<0)return;
  const action=actions[choice]!;
  try{
   const budget=await preview(action);io.write(budget.description);io.write('Command: '+action.command);
   if(action.kind!=='read'&&!await confirmed(io,'Continue with this step and its stated limits?'))continue;
   const fresh=await read(),next=verificationActions(fresh).find(a=>a.command===action.command);
   if(sha256(JSON.stringify(fresh))!==sha256(JSON.stringify(report))||!next||(await preview(next)).identity!==budget.identity){io.write('Evidence or execution scope changed. Review the refreshed choices before continuing.');continue;}
   const code=await command(project,action.args);if(code!==0)io.write('That step stopped. Saved evidence remains available; review its message before retrying.');
  }catch(e){io.write(`Needs attention: ${(e as Error).message}`);}
 }
}
