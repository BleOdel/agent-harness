import path from 'node:path';
import {findWorkCheckpoint} from '../workspace/work-checkpoints.ts';
import {canonicalProject,withWriter} from '../workspace/writer-lock.ts';
import {assertInspectedSource,browserBinding,loadBrowserEvidence,saveBrowserEvidence} from '../review/browser-evidence.ts';
import {confirmed,terminalDialogue,type Dialogue} from '../guide/dialogue.ts';
import {OperatorError,say} from './io.ts';

export async function evidenceCommand(project:string,args:readonly string[],io?:Dialogue):Promise<void> {
 if(args.length!==2||!['setup','show'].includes(args[0]!)||!/^r[1-9][0-9]*$/.test(args[1]!))throw new OperatorError('Use: harness evidence setup <run-id> or harness evidence show <run-id>.');
 project=await canonicalProject(project);
 await withWriter(project,'browser evidence',async()=>{
  const c=(await findWorkCheckpoint(project,undefined,args[1]!))!;
  const write=io?.write??say;
  if(args[0]==='show') {const receipt=await loadBrowserEvidence(project,browserBinding(c));write(receipt?JSON.stringify(receipt,null,2):'No browser observations recorded for this exact checkpoint.');return;}
  io??=terminalDialogue();
  io.write(`Record browser observations for ${c.goal}, ${c.runId}. No browser or model will be launched.`);
  io.write(`Saved source: ${path.join(c.directory,'source')}\nSource digest: ${c.partial.digest}`);
  io.write('Inspect a disposable copy of this source with isolated data. Do not edit the saved checkpoint. This records your observations, not an automatic accessibility pass.');
  const directory=(await io.ask('Path to the source copy you actually tested (blank to cancel):')).trim();if(!directory)return;
  await assertInspectedSource(c,directory);
  const environment=(await io.ask('Browser/version, operating system and tested viewport sizes:')).trim();
  const observations=(await io.ask('What did you observe? Include criterion numbers, actions, results and any failures:')).trim();
  const limitations=(await io.ask('What was not tested or remains uncertain? Enter explicit limitations:')).trim();
  io.write(`Environment: ${environment}\nObservations: ${observations}\nLimitations: ${limitations}`);
  io.write('These observations apply only to this exact source and verification setup. They do not waive criteria, independent review or acceptance checks.');
  if(!await confirmed(io,'Confirm these are your observations of this source?'))return;
  await saveBrowserEvidence(c,directory,{environment,observations,limitations});
  io.write(`Browser observations saved outside project source. Nothing was applied or approved as passing.\nNext: harness work --resume ${c.runId}\nAny source change makes these observations inapplicable and requires fresh evidence.`);
 });
}
