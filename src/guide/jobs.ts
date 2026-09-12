import { listJobs } from '../jobs/state.ts';
import { listArtifacts } from '../artifacts/store.ts';
import { choose, confirmed, type Dialogue } from './dialogue.ts';
import type { GuideCommand } from '../verbs/guide.ts';
export async function guideJobs(project:string,io:Dialogue,command:GuideCommand):Promise<void>{
 for(;;){
  const jobs=await listJobs(project),artifacts=await listArtifacts(project);
  const options=[...jobs.map(j=>`${j.spec.title}: ${j.status}; checkpoint ${j.completed??'none'}`),'Create a saved job','Inspect or export retained output','Clean unreferenced artifact bytes'];
  const choice=await choose(io,'Jobs and outputs',options);if(choice<0)return;
  const run=async(...args:string[])=>{if(await command(project,args)!==0)io.write('That action stopped. Saved state remains available; review the explanation above.');};
  if(choice===jobs.length){await run('job','setup');continue;}
  if(choice===jobs.length+2){await run('artifacts','cleanup');continue;}
  if(choice===jobs.length+1){
   const selected=await choose(io,'Retained output (export checks its hash; it does not publish)',artifacts.map(a=>`${a.name}: ${a.size} bytes; ${a.verification}`));if(selected<0)continue;
   const artifact=artifacts[selected]!;await run('artifacts','inspect',artifact.id);
   const action=await choose(io,'Output action',['Export to a new local file','Release this producer’s retained outputs']);
   if(action===0){const destination=(await io.ask('New output file path outside the project:')).trim();if(destination)await run('artifacts','export',artifact.id,destination);}
   if(action===1&&await confirmed(io,`Release all outputs from ${artifact.producer}? Saved jobs must be retired first.`))await run('artifacts','release',artifact.producer,'--yes');continue;
  }
  const job=jobs[choice]!;io.write(`${job.spec.title}: ${job.events.at(-1)!.message}\nAttempt budget ${job.attempts}/${job.spec.limits.maxAttempts}; execution reservation ${job.reservedSeconds}/${job.spec.limits.totalSeconds}s. Compute cost unknown.`);
  const actions=[{label:'Inspect progress and retained evidence',verb:'inspect'}];
  if(['preparing','running'].includes(job.status))actions.push({label:'Request cancellation (keep last valid checkpoint)',verb:'cancel'},{label:'Recover resources after the owner has ended',verb:'recover'});
  else if(!['succeeded','released'].includes(job.status))actions.push({label:job.status==='ready'?'Run this saved job':'Resume from the compatible checkpoint',verb:'run'});
  if(!['preparing','running','released'].includes(job.status))actions.push({label:'Retire job and release its recovery outputs',verb:'release'});
  const action=await choose(io,'Job action',actions.map(a=>a.label));if(action<0)continue;
  const verb=actions[action]!.verb;
  if(verb==='release'){if(await confirmed(io,`Retire ${job.spec.title}? Its checkpoints and outputs will be released and it cannot resume.`))await run('job',verb,job.id,'--yes');}
  else{if(verb==='run')io.write('Runs offline with bounded resources. Results stay in the artifact store; source is not applied and nothing is published.');await run('job',verb,job.id);}
 }
}
