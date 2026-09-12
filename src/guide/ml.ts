import { listMl, readMlState } from '../ml/store.ts';
import { readJob } from '../jobs/state.ts';
import { choose, confirmed, type Dialogue } from './dialogue.ts';
import type { GuideCommand } from '../verbs/guide.ts';
export async function guideMl(project:string,io:Dialogue,command:GuideCommand):Promise<void>{
 const run=async(...args:string[])=>{if(await command(project,args)!==0)io.write('That step stopped. Review the reason above; approved data and saved progress remain available.');};
 for(;;){
  const approvals=await listMl(project),states=await Promise.all(approvals.map(a=>readMlState(project,a.id)));
  const choice=await choose(io,'CPU ML workflows',[...approvals.map((a,i)=>`${a.spec.title}: ${states[i]!.status}`),'Set up a numeric regression workflow']);if(choice<0)return;
  if(choice===approvals.length){await run('ml','setup');continue;}
  const a=approvals[choice]!,state=states[choice]!,job=state.jobId?await readJob(project,state.jobId):undefined;
  io.write(`${a.spec.title}: ${state.status}. RMSE <= ${a.spec.maxRmse}; minimum ${a.spec.minImprovement*100}% improvement over the training mean baseline.`);
  if(job)io.write(`Training: ${job.status}; saved epoch ${job.completed??0}/${a.spec.epochs}; ${job.attempts}/${job.spec.limits.maxAttempts} attempts. Compute cost unknown.`);
  const actions=[{label:'Inspect the approved scope and evaluation',verb:'inspect'}];
  if(state.status!=='released'){
   if(job&&['preparing','running'].includes(job.status))actions.push({label:'Request cancellation (keep the validated checkpoint)',verb:'cancel'},{label:'Recover training resources after the owner ended',verb:'recover'});
   else if(!state.candidateHash)actions.push({label:job?'Continue saved training and evaluate':'Train and evaluate the approved model',verb:'train'});
   else if(state.status==='evaluating')actions.push({label:'Continue evaluation of the same model',verb:'evaluate'});
   if(state.status==='passed')actions.push({label:'Export the evaluated model to a new local file',verb:'export'});
   if(!job||!['preparing','running'].includes(job.status))actions.push({label:'Retire this workflow and release output references',verb:'release'});
  }
  const selected=await choose(io,'ML action',actions.map(a=>a.label));if(selected<0)continue;const verb=actions[selected]!.verb;
  if(verb==='export'){const destination=(await io.ask('New model file path outside the project:')).trim();if(destination)await run('ml','export',a.id,destination);}
  else if(verb==='release'){if(await confirmed(io,`Retire ${a.spec.title}? Training cannot resume and model/checkpoint references will be released. Approved data and audit records stay saved.`))await run('ml','release',a.id,'--yes');}
  else await run('ml',verb,a.id);
 }
}
