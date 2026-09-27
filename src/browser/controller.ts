import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';import path from 'node:path';
import {run} from '../run.ts';import {OperatorError} from '../verbs/io.ts';
import {withWriter} from '../workspace/writer-lock.ts';
import {captureBaseline,assertSnapshot,assertLiveBaseline} from '../workspace/candidate.ts';
import {putArtifact,sha256} from '../artifacts/store.ts';
import {boundedOutput,validatePng} from '../desktop/output.ts';
import {browserDocker,browserResources,inspectBrowser} from './runtime.ts';
import {actionRequest,assessJourney,type Journey} from './schema.ts';
import {newRun,readApproval,readBrowserRun,listBrowserRuns,runRoot,saveBrowserRun,type BrowserRun} from './store.ts';
const fail=(m:string):never=>{throw new OperatorError(m);};
export function containerArguments(j:BrowserRun,name:string):string[]{
 return ['run','--init','--name',name,'--label',`harness.browser=${j.id}`,'--label',`harness.token=${j.token}`,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--cpus','2','--memory','1536m','--pids-limit','256','--user',`${process.getuid?.()??501}:${process.getgid?.()??20}`,'--tmpfs','/tmp:rw,nosuid,nodev,size=268435456','--env','HOME=/tmp','--log-driver','local','--log-opt','max-size=1m','--log-opt','max-file=1','--log-opt','compress=false','--entrypoint','timeout'];
}
export function appArguments(j:BrowserRun,name:string,source:string,s:Journey):string[]{return [...containerArguments(j,name),'--detach','--network','none','--tmpfs','/work:rw,nosuid,nodev,mode=1777,size=134217728','--mount',`type=bind,src=${source},dst=/app,readonly`,'--workdir','/app','--env',`PORT=${s.port}`,...(s.databaseEnv?['--env',`${s.databaseEnv}=/work/app.sqlite`]:[]),j.runtime.image,'-k','3',String(s.timeoutSeconds+30),'node',s.entry];}
export function driverArguments(j:BrowserRun,name:string,app:string,root:string,s:Journey):string[]{return [...containerArguments(j,name),'--network',`container:${app}`,'--mount',`type=bind,src=${browserResources},dst=/harness-instrumentation,readonly`,'--mount',`type=bind,src=${root}/checks,dst=/harness-checks,readonly`,'--mount',`type=bind,src=${root}/output,dst=/work`,'--workdir','/work',j.runtime.image,'-k','3',String(s.timeoutSeconds),'node','/harness-instrumentation/driver.mjs'];}
async function cleanContainers(j:BrowserRun):Promise<void>{
 for(const name of [...j.containers].reverse()){
  const r=await run(j.docker,['inspect',name],{timeoutMs:10000,maxOutputBytes:1024*1024});
  if(r.code!==0){if(!r.timedOut&&/no such (object|container)/iu.test(r.stderr))continue;fail('Cannot inspect browser resources; recover this run.');}
  const m=JSON.parse(r.stdout)[0];if(m?.Image!==j.runtime.image||m?.Config?.Labels?.['harness.browser']!==j.id||m?.Config?.Labels?.['harness.token']!==j.token)fail('Browser resource ownership mismatch; refusing cleanup.');
  const removed=await run(j.docker,['rm','-f',name],{timeoutMs:10000,maxOutputBytes:10000});if(removed.code!==0&&!/no such container/iu.test(removed.stderr))fail('Browser cleanup failed; recover this run.');
 }
 j.containers=[];
}
async function cleanFiles(project:string,j:BrowserRun):Promise<void>{const root=await runRoot(project,j.id);for(const part of ['source','checks','output'])await rm(path.join(root,part),{recursive:true,force:true});}
export async function recoverBrowser(project:string,id:string):Promise<void>{return withWriter(project,'browser recover',async()=>{const j=await readBrowserRun(project,id);if(!['preparing','running'].includes(j.status))return;await cleanContainers(j);await cleanFiles(project,j);j.status='interrupted';j.message='Owned resources removed. Verify the saved journey again from fresh source.';await saveBrowserRun(project,j);});}
export async function verifyBrowser(project:string,id:string,notify:(m:string)=>void=()=>{}):Promise<BrowserRun>{return withWriter(project,'browser verify',async()=>{
 if((await listBrowserRuns(project)).some(j=>['preparing','running'].includes(j.status)))fail('Recover the previous browser run before starting another.');
 const a=await readApproval(project,id),docker=browserDocker(),runtime=await inspectBrowser(docker);
 if(JSON.stringify(runtime)!==JSON.stringify(a.runtime))fail('Browser runtime or protocol changed. Review and approve the journey for the current environment.');
 const j=await newRun(project,a,docker),root=await runRoot(project,j.id),abort=new AbortController();
 const cancel=()=>abort.abort();process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
 try{
  const baseline=await captureBaseline(project,path.join(root,'source'));
  if(!Object.hasOwn(baseline.files,a.journey.entry))fail('The approved server entry is absent from the safe source snapshot.');
  const pkg=JSON.parse(await readFile(path.join(baseline.directory,'package.json'),'utf8'));
  if(pkg.workspaces||['dependencies','optionalDependencies'].some(k=>Object.keys(pkg[k]??{}).length))fail('This browser lane supports dependency-free Node servers. Dependency preparation is not implemented in this lane.');
  let size=0;for(const file of Object.keys(baseline.files)){size+=(await boundedOutput(baseline.directory,file,4*1024*1024)).length;if(size>32*1024*1024)fail('Browser source snapshot exceeds 32 MiB.');}
  j.source=baseline.digest;j.identity=sha256(JSON.stringify({source:j.source,approval:a.digest,runtime}));
  await mkdir(root+'/checks');await mkdir(root+'/output');await writeFile(root+'/checks/actions.json',JSON.stringify(actionRequest(a.journey)));
  const app=`harness-browser-${randomUUID()}`,driver=`harness-browser-${randomUUID()}`;
  j.containers=[app,driver];j.status='running';j.message='Starting isolated app and Chromium.';await saveBrowserRun(project,j);
  const started=await run(docker,appArguments(j,app,baseline.directory,a.journey),{timeoutMs:15000,maxOutputBytes:10000,signal:abort.signal});
  if(started.code!==0||started.timedOut||started.outputLimited)fail(`App container failed to start: ${started.stderr.slice(-1500)}`);
  const began=Date.now(),progress=setInterval(()=>notify(`Browser journey: ${Math.floor((Date.now()-began)/1000)}s elapsed; ${a.journey.timeoutSeconds}s limit.`),10000);
  const result=await run(docker,driverArguments(j,driver,app,root,a.journey),{timeoutMs:(a.journey.timeoutSeconds+5)*1000,maxOutputBytes:128*1024,signal:abort.signal}).finally(()=>clearInterval(progress));
  const log=await putArtifact(project,'browser.log',Buffer.from(result.stdout+'\n'+result.stderr),{producer:j.id,input:j.source,environment:j.identity,verification:'unverified'});j.artifacts.push(log.id);await saveBrowserRun(project,j);
  if(result.timedOut||result.code===124||result.code===137)fail('Browser journey timed out. Saved diagnostics remain available; retry starts fresh.');
  if(result.code!==0||result.outputLimited)fail(`Browser driver failed. ${result.stderr.slice(-1500)}`);
  const bytes=await boundedOutput(root+'/output','observations.json',1024*1024),observations=JSON.parse(bytes.toString());
  const report=await putArtifact(project,'browser-observations.json',bytes,{producer:j.id,input:j.source,environment:j.identity,verification:'unverified'});j.report=report.id;j.artifacts.push(report.id);
  j.assessment=assessJourney(a.journey,observations);let total=bytes.length;
  const files=[...j.assessment.screenshots,...a.journey.steps.flatMap((s,i)=>s.action==='accessibility'?[`axe-${i}.json`]:[])];
  for(const file of files){const content=await boundedOutput(root+'/output',file,4*1024*1024);if(file.endsWith('.png'))validatePng(content);total+=content.length;if(total>32*1024*1024)fail('Browser outputs exceed 32 MiB.');const artifact=await putArtifact(project,file,content,{producer:j.id,input:j.source,environment:j.identity,verification:'unverified'});j.artifacts.push(artifact.id);}
  await assertSnapshot(baseline);await assertLiveBaseline(project,baseline);
  if(!j.assessment.passed)fail(j.assessment.failures.join('\n'));
  j.status='passed';j.message=`${j.assessment.checks} browser checks passed. These observations do not establish complete accessibility or replace source acceptance.`;
 }catch(e){j.status=abort.signal.aborted?'interrupted':'failed';j.message=(e as Error).message;}
 finally{
  process.off('SIGINT',cancel);process.off('SIGTERM',cancel);
  if(j.source&&j.identity&&j.containers[0]){
   const logs=await run(j.docker,['logs','--tail','300',j.containers[0]],{timeoutMs:5000,maxOutputBytes:128*1024});
   if(logs.code===0&&!logs.outputLimited){try{const a=await putArtifact(project,'app.log',Buffer.from(logs.stdout+'\n'+logs.stderr),{producer:j.id,input:j.source,environment:j.identity,verification:'unverified'});j.artifacts.push(a.id);}catch{/* Cleanup takes priority if artifact storage is full. */}}
  }
  try{await cleanContainers(j);}catch(e){j.status='running';j.message=`Cleanup needs recovery: ${(e as Error).message}`;await saveBrowserRun(project,j);throw e;}
  await cleanFiles(project,j);await saveBrowserRun(project,j);notify(`${j.status}: ${j.message}`);
 }
 return j;
});}
