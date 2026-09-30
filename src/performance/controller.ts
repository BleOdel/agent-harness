import {randomUUID} from 'node:crypto';import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';import path from 'node:path';
import {run} from '../run.ts';import {withWriter} from '../workspace/writer-lock.ts';import {captureBaseline,assertLiveBaseline,assertSnapshot} from '../workspace/candidate.ts';import {assertProductCurrent} from '../product/spec.ts';import {sha256,putArtifact} from '../artifacts/store.ts';import {boundedOutput} from '../desktop/output.ts';import {EvidenceReader} from '../product/evidence/reader.ts';import {uuidId} from '../product/evidence/schema.ts';
import {compare,parseObservation,canonicalHash,type Profile} from './schema.ts';
import {validateBaseline} from './evidence.ts';import {resources,readPerformance,performanceProtocol,parseRun,saveRun,performanceRoot,runIdentity,inspectEnvironment,type PerformanceRun} from './store.ts';
export function common(r:PerformanceRun,name:string){return ['run','--pull=never','--init','--name',name,'--label',`harness.performance=${r.id}`,'--label',`harness.token=${r.token}`,'--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',name===r.containers[0]?'--cpus=2':'--cpus=1','--memory=512m','--pids-limit=128','--user',`${process.getuid?.()??501}:${process.getgid?.()??20}`,'--tmpfs','/tmp:rw,nosuid,nodev,size=64m','--env','HOME=/tmp','--log-driver','none','--entrypoint','timeout'];}
export function appArguments(r:PerformanceRun,name:string,source:string,s:Profile){return [...common(r,name),'--detach','--network=none','--tmpfs','/work:rw,nosuid,nodev,mode=1777,size=128m','--mount',`type=bind,src=${source},dst=/app,readonly`,'--workdir','/app','--env',`PORT=${s.port}`,...(s.databaseEnv?['--env',`${s.databaseEnv}=/work/performance.sqlite`]:[]),r.image,'-k','3',String(s.maxSeconds+30),'node',s.entry];}
export function probeArguments(r:PerformanceRun,name:string,app:string,root:string,s:Profile){return [...common(r,name),'--network',`container:${app}`,'--mount',`type=bind,src=${resources}/instrumentation,dst=/harness-instrumentation,readonly`,'--mount',`type=bind,src=${root}/checks,dst=/harness-checks,readonly`,'--mount',`type=bind,src=${root}/output,dst=/work`,'--workdir','/work',r.image,'-k','3',String(s.maxSeconds),'node','/harness-instrumentation/probe.mjs'];}
async function owned(r:PerformanceRun,name:string){const v=await run(r.docker,['inspect',name],{timeoutMs:10000,maxOutputBytes:1024*1024});if(v.code!==0){if(!v.timedOut&&!v.outputLimited&&/no such (object|container)/iu.test(v.stderr))return false;throw Error('Cannot inspect owned performance containers.');}if(v.timedOut||v.outputLimited)throw Error('Container inspection incomplete.');const m=JSON.parse(v.stdout)[0];if(m?.Image!==r.image||m?.Config?.Labels?.['harness.performance']!==r.id||m?.Config?.Labels?.['harness.token']!==r.token)throw Error('Performance container ownership mismatch.');return true;}
async function cleanup(r:PerformanceRun){for(const n of [...r.containers].reverse())if(await owned(r,n)){const result=await run(r.docker,['rm','-f',n],{timeoutMs:15000,maxOutputBytes:10000});if(result.code!==0||result.timedOut)throw Error('Performance cleanup needs recovery.');if(await owned(r,n))throw Error('Performance container still exists.');}r.containers=[];}
async function files(root:string){for(const part of ['source','checks','output'])await rm(path.join(root,part),{recursive:true,force:true});}
async function retainSamples(project:string,r:PerformanceRun,root:string){
 if(!r.source||!r.identity||r.report)return;
 try{const bytes=await boundedOutput(root+'/output','samples.json',2*1024*1024);parseObservation(JSON.parse(bytes.toString()));const artifact=await putArtifact(project,'performance-samples.json',bytes,{producer:r.id,input:r.source,environment:r.identity,verification:'unverified'});r.report=artifact.id;}catch{if(r.status==='passed')throw Error('Completed benchmark observations missing.');}
}
export async function recoverPerformance(project:string,id:string){
 if(!uuidId(id,'performance-run'))throw Error('Invalid performance run ID.');
 return withWriter(project,'performance recover',async()=>{const reader=new EvidenceReader(project+'-harness'),r=parseRun(await reader.json(`performance/runs/${id}/state.json`));if(r.id!==id)throw Error('Performance run identity changed.');if(!['running','preparing'].includes(r.status))return;
 const root=(await performanceRoot(project))+'/runs/'+id;await cleanup(r);r.status='interrupted';await retainSamples(project,r,root);await files(root);r.message='Owned benchmark resources removed; partial samples retained when available. Start a fresh bounded trial.';await saveRun(project,r);});
}
export async function verifyPerformance(project:string,notify:(s:string)=>void=()=>{},docker=process.env.HARNESS_DOCKER?.trim()||'/usr/local/bin/docker'){
 return withWriter(project,'performance verify',async()=>{
 const a=await readPerformance(project),product=await assertProductCurrent(project);if(!a)throw Error('Approve a performance profile first: harness performance setup.');if(a.product!==product?.digest||a.protocol!==await performanceProtocol())throw Error('Performance scope or rules changed. Review performance setup.');
 const reader=new EvidenceReader(project+'-harness');await validateBaseline(reader,a);await reader.assertUnchanged();
 for(const id of await reader.names('performance/runs')){if(id.startsWith('.'))continue;const r=parseRun(await reader.json(`performance/runs/${id}/state.json`));if(['preparing','running'].includes(r.status))throw Error('Recover the unfinished benchmark first: harness performance recover '+r.id);}
 const r:PerformanceRun={version:1,id:'performance-run-'+randomUUID(),at:new Date().toISOString(),approval:a.digest,approvalId:a.id,product:a.product,protocol:a.protocol,image:a.environment.image,docker,token:randomUUID(),status:'preparing',containers:[],message:'Preparing isolated performance trial.'};await saveRun(project,r);
 const root=(await performanceRoot(project))+'/runs/'+r.id,s=a.profile,abort=new AbortController(),cancel=()=>abort.abort();process.on('SIGINT',cancel);process.on('SIGTERM',cancel);let stage='source preparation';
 try{
  if(root.includes(','))throw Error('Mount path unsupported.');
  const snapshot=await captureBaseline(project,root+'/source');if(!Object.hasOwn(snapshot.files,s.entry))throw Error('Server entry missing.');
  const pkg=JSON.parse(await readFile(snapshot.directory+'/package.json','utf8'));if(pkg.workspaces||['dependencies','optionalDependencies'].some(k=>Object.keys(pkg[k]??{}).length))throw Error('Performance recipe requires a dependency-free Node server.');
  let total=0;for(const f of Object.keys(snapshot.files)){total+=(await boundedOutput(snapshot.directory,f,4*1024*1024)).length;if(total>32*1024*1024)throw Error('Source limit exceeded.');}
  r.source=snapshot.digest;r.identity=runIdentity(r.source,a);stage='runtime validation';
  if(canonicalHash(await inspectEnvironment(docker,a.environment.image))!==canonicalHash(a.environment))throw Error('Docker runtime changed.');
  await mkdir(root+'/checks');await mkdir(root+'/output');
  const actions={port:s.port,path:s.path,warmup:s.warmup,repetitions:s.repetitions,samples:s.samples,requestTimeoutMs:s.requestTimeoutMs,maxSeconds:s.maxSeconds};await writeFile(root+'/checks/request.json',JSON.stringify(actions),{mode:0o600});
  const app='harness-performance-'+randomUUID(),probe='harness-performance-'+randomUUID();r.containers=[app,probe];r.status='running';r.message='Running approved warm-up and repeated measurements in an offline disposable app.';await saveRun(project,r);notify(r.message);
  stage='application startup';const start=await run(docker,appArguments(r,app,snapshot.directory,s),{timeoutMs:15000,maxOutputBytes:10000,signal:abort.signal});if(start.code!==0||start.timedOut||start.outputLimited)throw Error('App failed to start.');
  const timer=setInterval(()=>notify('Performance samples running; '+s.maxSeconds+' second limit.'),10000);
  stage='measurement';const result=await run(docker,probeArguments(r,probe,app,root,s),{timeoutMs:(s.maxSeconds+5)*1000,maxOutputBytes:10000,signal:abort.signal}).finally(()=>clearInterval(timer));if(result.code!==0||result.timedOut||result.outputLimited)throw Error('Measurement did not complete.');
  stage='observation collection';const observed=parseObservation(JSON.parse((await boundedOutput(root+'/output','samples.json',2*1024*1024)).toString()));
  await assertSnapshot(snapshot);await assertLiveBaseline(project,snapshot);if((await readPerformance(project))?.digest!==a.digest||await performanceProtocol()!==a.protocol||canonicalHash(await inspectEnvironment(docker,a.environment.image))!==canonicalHash(a.environment))throw Error('Benchmark authority or runtime changed.');
  await validateBaseline(new EvidenceReader(project+'-harness'),a);
  const compared=compare(s,observed,a.baseline);r.verified=true;r.status=compared.passed?'passed':'failed';r.message=compared.passed?'Approved timing, correctness and stability comparisons matched.': 'Benchmark failed: '+compared.failures.join(', ');await retainSamples(project,r,root);
 }catch{r.status=abort.signal.aborted?'interrupted':'failed';r.message=abort.signal.aborted?'Performance trial interrupted; partial measurements cannot pass.':`Benchmark incomplete at ${stage}. Review entry, workload, budget and runtime.`;}
 finally{
  process.off('SIGINT',cancel);process.off('SIGTERM',cancel);
  try{await cleanup(r);}catch{r.status='running';r.message='Performance cleanup needs recovery.';await saveRun(project,r);throw Error('Run harness performance recover '+r.id);}
  await retainSamples(project,r,root);await files(root);await saveRun(project,r);notify(r.status+': '+r.message);
 }
 return r;
 });
}
