import {readFile} from 'node:fs/promises';import {say,OperatorError} from './io.ts';import {withWriter} from '../workspace/writer-lock.ts';
import {metalSetup} from '../guide/metal.ts';import {readMetalRuntime} from '../metal/runtime.ts';import {validateMetal} from '../metal/verify.ts';import {approveMetal,listMetal,readMetalState} from '../metal/store.ts';import {trainMetal,evaluateMetal,recoverMetal,exportMetal,releaseMetal} from '../metal/workflow.ts';
export async function metalCommand(project:string,args:readonly string[]){const [action,id,extra,...rest]=args;if(rest.length)throw new OperatorError('Too many Metal arguments.');
 if(action==='doctor'&&!id){const r=await readMetalRuntime();say(`Metal ready on ${r.profile.arch}: offline Mac VM, fixed float32 regression, saved segment checkpoints. Next: harness metal setup.`);return;}
 if(action==='validate'&&!id){await validateMetal(say);return;}
 if(action==='setup'&&!id)return metalSetup(project);
 if(action==='approve'&&id&&extra){const r=await readMetalRuntime(),requireText=await readFile(id,'utf8');const a=await withWriter(project,'Metal approve',()=>approveMetal(project,extra,JSON.parse(requireText),r));say(a.id);return;
 }
 if((!action||action==='list')&&!id){const all=await listMetal(project);for(const a of all){const s=await readMetalState(project,a.id);say(`${a.id} · ${a.spec.title} · ${s.status} · epoch ${s.checkpoint?.model.completed??0}/${a.spec.epochs} · ${s.attempts.length}/${a.spec.limits.maxAttempts} segments`);}if(!all.length)say('No Metal workflows yet. Use harness metal setup.');return;}
 if(action==='inspect'&&id&&!extra){say(JSON.stringify(await readMetalState(project,id),null,2));return;}
 if((action==='train'||action==='resume')&&id&&(!extra||extra==='--one-checkpoint')){const s=await trainMetal(project,id,say,extra==='--one-checkpoint');say(s.status==='trained'?`Training complete. Next: harness metal evaluate ${id}`:`Paused at saved checkpoint. Resume: harness metal resume ${id}`);return;}
 if(action==='recover'&&id&&!extra){const s=await recoverMetal(project,id);say(s.message??s.status);return;}
 if(action==='evaluate'&&id&&!extra){const report=await evaluateMetal(project,id);say(JSON.stringify(report,null,2));if(!report.passed)throw new OperatorError('Model did not meet the approved quality goal. No evaluated model export is available.');say(`Quality goal passed. Export: harness metal export ${id} <new-file.json>`);return;}
 if(action==='release'&&id&&extra==='--yes'){await releaseMetal(project,id);say('Workflow retired. Data and checkpoint audit retained; output references released.');return;}
 if(action==='export'&&id&&extra){await exportMetal(project,id,extra);say(`Exported evaluated, inert JSON model to ${extra}. Nothing published.`);return;}
 throw new OperatorError('Use harness metal doctor | validate | setup | approve <spec.json> <external.csv> | list | inspect <id> | train/resume <id> [--one-checkpoint] | recover <id> | evaluate <id> | export <id> <new-file> | release <id> --yes.');
}
