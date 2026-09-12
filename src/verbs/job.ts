import path from 'node:path';
import { readJson } from '../artifacts/store.ts';
import { choose, confirmed, terminalDialogue, type Dialogue } from '../guide/dialogue.ts';
import { createJob, listJobs, readJob } from '../jobs/state.ts';
import { parseJobSpec } from '../jobs/schema.ts';
import { recoverJob, releaseJob, requestCancel, runJob } from '../jobs/controller.ts';
import { withWriter } from '../workspace/writer-lock.ts';
import { OperatorError, say } from './io.ts';
export async function setupJob(project:string,io:Dialogue):Promise<void>{
 io.write('Save a command to run in an offline Docker job. It must already exist in your project. Outputs go in .harness-output; jobs never apply source or publish results.');
 const title=(await io.ask('Job title (blank to cancel):')).trim();if(!title)return;
 const command=(await io.ask('Command to run inside the job:')).trim();if(!command)return;
 const outputs=(await io.ask('Output file names, separated by commas (blank for logs only):')).split(',').map(v=>v.trim()).filter(Boolean);
 const steps=(await io.ask('Checkpoint steps (blank if the program does not support json-step@1):')).trim();
 const timeout=Number((await io.ask('Seconds per attempt [300]:')).trim()||300);
 const attempts=Number((await io.ask('Maximum attempts [2]:')).trim()||2);
 const spec=parseJobSpec({version:1,title,command:['sh','-c',command],outputs,...(steps?{checkpoint:{protocol:'json-step@1',total:Number(steps)}}:{}),limits:{timeoutSeconds:timeout,totalSeconds:timeout*attempts,maxAttempts:attempts}});
 io.write(`${title}: ${command}\nOutputs: ${outputs.join(', ')||'logs only'}; ${timeout}s per attempt, ${attempts} attempts, ${timeout*attempts}s total execution reservation. 2 CPUs / 2 GiB RAM / 512 MiB workspace. Compute cost unknown.`);
 if(await confirmed(io,'Save these job settings?')){const j=await withWriter(project,'job create',()=>createJob(project,spec));io.write(`Saved ${j.spec.title}. Continue through harness guide, or run: harness job run ${j.id}`);}
}
export async function jobCommand(project:string,args:readonly string[]):Promise<void>{
 const [action,id,extra,...rest]=args;
 if(action==='setup'&&!id)return setupJob(project,terminalDialogue());
 if(action==='create'&&id&&!extra){const absolute=path.resolve(id),raw=await readJson(path.dirname(absolute),path.basename(absolute));const j=await withWriter(project,'job create',()=>createJob(project,raw));say(`Saved ${j.spec.title}: ${j.id}. Start with harness job run ${j.id}`);return;}
 if((!action||action==='list')&&(!id||id==='--json')&&!extra){const jobs=await listJobs(project);if(id==='--json')say(JSON.stringify(jobs));else {for(const j of jobs)say(`${j.id} · ${j.spec.title} · ${j.status} · checkpoint ${j.completed??'none'} · cost unknown`);if(!jobs.length)say('No jobs saved. Use harness job setup.');}return;}
 if(action==='inspect'&&id&&(!extra||extra==='--json')&&!rest.length){const j=await readJob(project,id);if(extra==='--json')say(JSON.stringify(j));else{say(`${j.spec.title} · ${j.status}\n${j.id}\nCommand: ${JSON.stringify(j.spec.command)}\nAttempts: ${j.attempts}/${j.spec.limits.maxAttempts}; reserved ${j.reservedSeconds}/${j.spec.limits.totalSeconds}s; observed execution ${j.elapsedSeconds.toFixed(1)}s; cost unknown.`);j.events.forEach(e=>say(`${e.at} · ${e.phase}: ${e.message}`));say('Outputs are unverified job results. Inspect or export through harness artifacts.');}return;}
 if(id&&!extra){
  if(action==='run'||action==='resume'){const j=await runJob(project,id,say);if(j.status!=='succeeded')throw new OperatorError(`Job ${j.status}. Saved progress remains available.`, `Use harness job inspect ${id} or harness guide.`);return;}
  if(action==='cancel'){await requestCancel(project,id);say('Cancellation requested. The controller will stop the job and keep its last valid checkpoint. During preparation it finishes the current bounded step first.');return;}
  if(action==='recover'){const j=await recoverJob(project,id);say(`${j.spec.title}: ${j.status}. Owned resources reconciled.`);return;}
 }
 if(action==='release'&&id&&extra==='--yes'&&!rest.length){await releaseJob(project,id);say('Job retired; recovery and output references released. Run harness artifacts cleanup to reclaim unreferenced bytes.');return;}
 throw new OperatorError('Use: harness job setup | create <file> | list [--json] | inspect <id> [--json] | run/resume/cancel/recover <id> | release <id> --yes');
}
