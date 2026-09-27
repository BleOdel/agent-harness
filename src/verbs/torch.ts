import {prepareTorchBytes,provisionTorch} from '../torch/provision.ts';
import {probeMacTorch,recoverMacProbe} from '../torch/mac-probe.ts';
import {readFile} from 'node:fs/promises';import {withWriter} from '../workspace/writer-lock.ts';import {say,OperatorError} from './io.ts';
import {configureTorch,readTorchRuntime,torchTrial} from '../torch/runtime.ts';
import {approveTorch,listTorch,readTorchState} from '../torch/store.ts';import {torchSetup} from '../guide/torch.ts';
import {trainTorch,evaluateTorch,exportTorch,releaseTorch} from '../torch/workflow.ts';import {recoverJob,requestCancel} from '../jobs/controller.ts';
async function executeTorch(project:string,args:readonly string[]){const [action,id,extra,...rest]=args;if(rest.length)throw new OperatorError('Too many PyTorch arguments.');
 if(action==='provision'&&!id){say(JSON.stringify(await provisionTorch(say)));return;}
 if(action==='probe-mac'&&!extra){const r=await probeMacTorch(id??await prepareTorchBytes('mac',say),say);if(!r.passed)throw new OperatorError('The tested PyTorch MPS operations did not all qualify in this VM. CPU training remains available; see saved GPU evidence.');return;}
 if(action==='recover-mac-probe'&&!id){await recoverMacProbe();return;}
 if(action==='configure'&&id&&!extra){say(JSON.stringify(await configureTorch(id)));return;}
 if(action==='doctor'&&!id){const r=await readTorchRuntime();await configureTorch(r.image);say(`Ready: PyTorch ${r.versions.torch}, CPU, 2 CPUs/2 GiB, offline. Next: harness torch setup.`);return;}
 if(action==='setup'&&!id)return torchSetup(project);
 if(action==='validate'&&!id){say('Running offline recovery and optimizer-reset control (up to 5 minutes; no model tokens).');say(JSON.stringify(await torchTrial(project,'recovery'),null,2));return;}
 if(action==='trial-llm'&&!extra){say('Running bounded SmolLM2 LoRA trial offline on CPU (up to 5 minutes).');say(JSON.stringify(await torchTrial(project,'llm',id??await prepareTorchBytes('model',say)),null,2));return;}
 if(action==='approve'&&id&&extra){const r=await readTorchRuntime(),raw=JSON.parse(await readFile(id,'utf8'));const a=await withWriter(project,'PyTorch approval',()=>approveTorch(project,extra,raw,r.image));say(a.id);return;}
 if((!action||action==='list')&&!id){for(const value of await listTorch(project))say(JSON.stringify(await readTorchState(project,value)));return;}
 if(action==='inspect'&&id&&!extra){say(JSON.stringify(await readTorchState(project,id),null,2));return;}
 if((action==='train'||action==='resume')&&id&&!extra){const j=await trainTorch(project,id,say);const message=j.status==='succeeded'?`Next: harness torch evaluate ${id}`:`Training ${j.status}. Job: ${j.id}. Resume with harness torch resume ${id}; recover active resources first if needed.`;if(['failed','timed-out'].includes(j.status))throw new OperatorError(message);say(message);return;}
 if((action==='recover'||action==='cancel')&&id&&!extra){const s=await readTorchState(project,id);if(!s.jobId)throw Error('No training job yet.');if(action==='recover')await recoverJob(project,s.jobId);else await requestCancel(project,s.jobId);return;}
 if(action==='evaluate'&&id&&!extra){const report=await evaluateTorch(project,id);say(JSON.stringify(report,null,2));if(!report.passed)throw new OperatorError('Quality goal failed. Saved evidence is retained.');return;}
 if(action==='export'&&id&&extra){await exportTorch(project,id,extra);say('Exported evaluated JSON model.');return;}
 if(action==='release'&&id&&extra==='--yes'){await releaseTorch(project,id);say('Workflow retired.');return;}
 throw new OperatorError('Use harness torch provision | probe-mac [bundle] | recover-mac-probe | configure <image-id> | doctor | setup | approve <spec.json> <external-data.json> | list | inspect <id> | train/resume <id> | cancel/recover <id> | evaluate <id> | export <id> <new-file> | release <id> --yes | validate | trial-llm <pinned-model-directory>.');
}

export async function torchCommand(project:string,args:readonly string[]){try{return await executeTorch(project,args);}catch(e){if(e instanceof OperatorError)throw e;throw new OperatorError((e as Error).message);}}
