import {readFile,realpath,lstat} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {randomUUID} from 'node:crypto';
import {stopContainer} from '../containment/stop.ts';
import {run} from '../run.ts';
import {saveJson,safeDirectory,sha256,stateRoot} from '../artifacts/store.ts';
import {fileHash} from '../native/provision.ts';
export const runtimeRoot=path.join(os.homedir(),'.config/harness/torch');
export async function configureTorch(image:string){
 if(!/^sha256:[a-f0-9]{64}$/u.test(image))throw Error('Use an immutable Docker image ID, not a tag.');
 const docker=process.env.HARNESS_DOCKER?.trim()||'docker';
 const r=await run(docker,['run','--rm','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--cpus=2','--memory=2g','--pids-limit=256','--tmpfs','/tmp:rw,size=64m',image,'timeout','--signal=KILL','30','python3','-I','-c','import json,torch,platform; assert torch.__version__=="2.14.0+cpu" and torch.version.cuda is None and platform.python_version()=="3.13.12"; print(json.dumps({"torch":torch.__version__,"python":platform.python_version(),"cpuOnly":True}))'],{timeoutMs:45000,maxOutputBytes:10000});
 if(r.code!==0||r.timedOut)throw Error('PyTorch image readiness failed: '+r.stderr.slice(-2000));const versions=JSON.parse(r.stdout);
 await safeDirectory(runtimeRoot);await saveJson(runtimeRoot,'runtime.json',{version:1,image,docker,versions});return {image,docker,versions};
}
export async function readTorchRuntime(){const r=JSON.parse(await readFile(runtimeRoot+'/runtime.json','utf8').catch(()=>{throw Error('Prepare containers/torch and run harness torch configure <immutable-image-id>. See PYTORCH.md.');}));if(r.version!==1||!/^sha256:[a-f0-9]{64}$/u.test(r.image)||typeof r.docker!=='string')throw Error('Invalid PyTorch runtime.');return r as {version:1;image:string;docker:string;versions:Record<string,unknown>};}
/** Fixed experiments, not arbitrary project commands. Inner timeout outlives a killed controller. */
export async function torchTrial(project:string,kind:'recovery'|'llm',modelDirectory?:string){
 const r=await readTorchRuntime(),name='harness-torch-trial-'+randomUUID(),resources=import.meta.dirname;
 const args=['run','--rm','--name',name,'--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--cpus=2','--memory=2g','--pids-limit=256','--user','65534:65534','--tmpfs','/tmp:rw,size=128m','--mount',`type=bind,src=${resources},dst=/recipe,readonly`];
 if(kind==='llm'){
  if(!modelDirectory)throw Error('Select the downloaded, pinned SmolLM2 model directory.');const root=await realpath(modelDirectory);if(root.includes(','))throw Error('Unsupported model path.');const manifest=JSON.parse(await readFile(resources+'/model-manifest.json','utf8'));
  for(const [name,entry] of Object.entries(manifest.files) as [string,{sha256:string;bytes:number}][]){const file=path.join(root,name),s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size!==entry.bytes||await fileHash(file)!==entry.sha256)throw Error('Pinned model file changed: '+name);}
  args.push('--mount',`type=bind,src=${root},dst=/model,readonly`);
 }
 args.push(r.image,'timeout','--signal=KILL','300','python3','-I',`/recipe/${kind==='llm'?'llm-trial':'recovery-test'}.py`);
 let result;try{result=await run(r.docker,args,{timeoutMs:330000,maxOutputBytes:1024*1024});}finally{await stopContainer(r.docker,name);}
 const root=path.join(await stateRoot(project),'torch-trials');await safeDirectory(root);
 const report={version:1,kind,image:r.image,recipe:sha256(await readFile(resources+`/${kind==='llm'?'llm-trial':'recovery-test'}.py`)),passed:result.code===0&&!result.timedOut&&!result.outputLimited,code:result.code,stdout:result.stdout,stderr:result.stderr};
 await saveJson(root,name+'.json',report);if(!report.passed)throw Error('Trial failed; evidence saved at '+root+'/'+name+'.json\n'+result.stderr.slice(-1500));return report;
}
