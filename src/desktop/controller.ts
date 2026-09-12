import {randomUUID} from 'node:crypto';
import {mkdir,rm,writeFile,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {ARTIFACT_LIMITS,artifactBytes,listArtifacts,putArtifact,releaseArtifacts,sha256} from '../artifacts/store.ts';
import {run} from '../run.ts';
import {runContained,withContainmentSignal} from '../containment/process.ts';
import {buildVerificationArguments} from '../containment/sandbox.ts';
import {stopContainer} from '../containment/stop.ts';
import {captureBaseline,copySource,assertSnapshot,assertLiveBaseline} from '../workspace/candidate.ts';
import {withWriter,canonicalProject} from '../workspace/writer-lock.ts';
import {OperatorError} from '../verbs/io.ts';
import {listJobs} from '../jobs/state.ts';
import {desktopDocker,desktopLayout,inspectDesktop} from './runtime.ts';
import {actionRequest,assessJourney,validateApp} from './schema.ts';
import {boundedOutput,validatePng} from './output.ts';
import {listDesktopRuns,newRun,readApproval,readDesktopRun,runRoot,saveDesktopRun,type DesktopRun} from './store.ts';
const fail=(message:string):never=>{throw new OperatorError(message);};
async function stopOwned(j:DesktopRun):Promise<void>{
 if(!j.container)return;
 const result=await run(j.docker,['inspect',j.container],{timeoutMs:10000,maxOutputBytes:1024*1024});
 if(result.code!==0){if(!result.timedOut&&/no such (object|container)/iu.test(result.stderr))return;fail('Cannot inspect desktop resources. Recover this run before continuing.');}
 const metadata=JSON.parse(result.stdout)[0];
 if(metadata?.Image!==j.runtime.image||metadata?.Config?.Labels?.['harness.desktop']!==j.id||metadata?.Config?.Labels?.['harness.token']!==j.token)fail('Desktop container ownership mismatch; refusing to stop another resource.');
 await stopContainer(j.docker,j.container);
}
async function cleanWork(project:string,j:DesktopRun):Promise<void>{const root=await runRoot(project,j.id);for(const name of ['source','pack-1','pack-2','ui','checks'])await rm(path.join(root,name),{recursive:true,force:true});}
export async function recoverDesktop(project:string,id:string):Promise<void>{return withWriter(project,'desktop recover',async()=>{
 const j=await readDesktopRun(project,id);if(!['preparing','running'].includes(j.status))return;
 await stopOwned(j);delete j.container;await cleanWork(project,j);j.status='interrupted';j.message='Owned resources removed. Run the approved journey again from a fresh app; partial UI sessions are not resumed.';await saveDesktopRun(project,j);
});}
export async function verifyDesktop(project:string,id:string,notify:(message:string)=>void=()=>{}):Promise<DesktopRun>{return withWriter(project,'desktop verify',async()=>{
 if((await listDesktopRuns(project)).some(j=>['preparing','running'].includes(j.status)))fail('Recover the interrupted desktop run before starting another. Use harness guide.');
 if((await listJobs(project)).some(j=>['preparing','running'].includes(j.status)))fail('Recover or finish the active job before desktop verification.');
 const a=await readApproval(project,id),docker=desktopDocker(),runtime=await inspectDesktop(docker);
 if(JSON.stringify(runtime)!==JSON.stringify(a.runtime))fail('Desktop runtime or verification protocol changed. Re-approve the journey for the new environment, or restore the approved image.');
 const j=await newRun(project,a,docker),root=await runRoot(project,j.id),abort=new AbortController();
 const cancel=()=>abort.abort(new Error('Desktop verification interrupted.'));process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
 const phase=async(name:string,command:string[],seconds:number,checks=false)=>{
  abort.signal.throwIfAborted();j.container=`harness-desktop-${randomUUID()}`;j.status='running';j.message=name;await saveDesktopRun(project,j);notify(`${name}: ${name==='ui'?'Launching the packaged app and checking the approved UI journey.':'Packaging source with fixed tools.'}`);
  const directory=path.join(root,name);await mkdir(directory,{recursive:true});
  const layout={...desktopLayout(docker,runtime.image,directory,j.container),labels:{'harness.desktop':j.id,'harness.token':j.token},...(checks?{checksDirectory:path.join(root,'checks')}:{})};
  const started=Date.now(),progress=setInterval(()=>notify(`${name}: ${Math.floor((Date.now()-started)/1000)}s elapsed; ${seconds}s phase limit.`),10000);
  const result=await withContainmentSignal(abort.signal,()=>runContained(layout,buildVerificationArguments(layout,'none',['timeout','-k','3',String(seconds),...command]),{timeoutMs:(seconds+5)*1000,maxOutputBytes:256*1024})).finally(()=>clearInterval(progress));
  const log=await putArtifact(project,`${name}.log`,Buffer.from(result.stdout+'\n'+result.stderr),{producer:j.id,input:j.source!,environment:j.identity!,verification:'unverified'});j.artifacts.push(log.id);await saveDesktopRun(project,j);
  if(result.timedOut||result.code===124||result.code===137)fail(`${name} timed out. Inspect the saved log; retry starts a fresh app.`);
  if(result.code!==0||result.outputLimited)fail(`${name} failed. ${result.stderr.slice(-1500)}`);
  delete j.container;return directory;
 };
 try{
  const baseline=await captureBaseline(project,path.join(root,'source'));
  const main=validateApp(JSON.parse(await readFile(path.join(baseline.directory,'package.json'),'utf8')));
  if(!Object.hasOwn(baseline.files,main))fail('Desktop main entry is missing from the safe source snapshot.');
  let sourceBytes=0;for(const file of Object.keys(baseline.files)){sourceBytes+=(await boundedOutput(baseline.directory,file,2*1024*1024)).length;if(sourceBytes>16*1024*1024)fail('Desktop source exceeds the 16 MiB packaging limit.');}
  j.source=baseline.digest;j.identity=sha256(JSON.stringify({source:j.source,approval:a.digest,runtime}));await saveDesktopRun(project,j);
  let packaged:Buffer|undefined;
  for(const name of ['pack-1','pack-2']){
   await copySource(baseline.directory,path.join(root,name,'app'));
   const directory=await phase(name,['node','/harness-instrumentation/package.mjs'],60);
   const bytes=await boundedOutput(directory,'app.asar');if(packaged&&!bytes.equals(packaged))fail('Desktop packaging is not deterministic.');packaged=bytes;
  }
  if(!packaged?.length)fail('Desktop package is empty.');
  const input=await putArtifact(project,'app.asar',packaged!,{producer:j.id,input:j.source,environment:j.identity,verification:'unverified'});j.artifacts.push(input.id);await saveDesktopRun(project,j);
  await mkdir(path.join(root,'checks'));await writeFile(path.join(root,'checks','app.asar'),packaged!);await writeFile(path.join(root,'checks','actions.json'),JSON.stringify(actionRequest(a.journey)));
  const directory=await phase('ui',['xvfb-run','-a','node','/harness-instrumentation/driver.mjs'],a.journey.timeoutSeconds,true);
  const observations=await boundedOutput(directory,'observations.json',1024*1024),assessment=assessJourney(a.journey,JSON.parse(observations.toString()));
  const report=await putArtifact(project,'observations.json',observations,{producer:j.id,input:j.source,environment:j.identity,verification:'unverified'});j.report=report.id;j.artifacts.push(report.id);j.assessment=assessment;
  let total=packaged!.length+observations.length;
  for(const file of assessment.screenshots){const bytes=await boundedOutput(directory,file);validatePng(bytes);total+=bytes.length;if(total>ARTIFACT_LIMITS.batch)fail('Desktop outputs exceed 64 MiB batch limit.');const screen=await putArtifact(project,file,bytes,{producer:j.id,input:j.source,environment:j.identity,verification:'unverified'});j.artifacts.push(screen.id);}
  await assertSnapshot(baseline);await assertLiveBaseline(project,baseline);
  if(!assessment.passed)fail(assessment.failures.join('\n'));
  const verified=await putArtifact(project,'app.asar',packaged!,{producer:j.id,input:j.source,environment:j.identity,verification:'diagnostics-passed'});j.package=verified.id;j.artifacts.push(verified.id);j.status='passed';j.message=`${assessment.checks} UI checks passed; packaged app retained. GUI observations are diagnostics, not independent source acceptance.`;
 }catch(error){j.status=abort.signal.aborted?'interrupted':'failed';j.message=(error as Error).message;}
 finally{
  process.off('SIGINT',cancel);process.off('SIGTERM',cancel);
  try{await stopOwned(j);}catch(error){j.status='running';j.message=`Cleanup needs recovery: ${(error as Error).message}`;await saveDesktopRun(project,j);throw error;}
  delete j.container;await cleanWork(project,j);await saveDesktopRun(project,j);notify(`${j.status}: ${j.message}`);
 }
 return j;
});}
export async function exportDesktop(project:string,id:string,destination:string):Promise<void>{return withWriter(project,'desktop export',async()=>{
 const j=await readDesktopRun(project,id);if(j.status!=='passed'||!j.package||!j.report)fail('Only a passed, retained desktop run can be exported.');
 const a=await readApproval(project,j.approval),identity=sha256(JSON.stringify({source:j.source,approval:a.digest,runtime:j.runtime}));
 if(a.digest!==j.approvalDigest||JSON.stringify(a.runtime)!==JSON.stringify(j.runtime)||identity!==j.identity)fail('Desktop result identity changed.');
 const artifacts=await listArtifacts(project),files=new Map<string,Buffer>();
 for(const artifactId of [j.package!,j.report!,...j.artifacts.filter(id=>artifacts.find(a=>a.id===id)?.name.endsWith('.png'))]){
  const a=artifacts.find(a=>a.id===artifactId);if(!a||a.producer!==j.id||a.input!==j.source||a.environment!==j.identity)fail('Desktop artifact provenance changed.');files.set(a!.name,await artifactBytes(project,artifactId));
 }
 if(!files.has('app.asar')||!files.has('observations.json')||artifacts.find(a=>a.id===j.package)?.verification!=='diagnostics-passed')fail('Desktop package/report is unavailable.');
 const assessment=assessJourney(a.journey,JSON.parse(files.get('observations.json')!.toString()));if(!assessment.passed)fail('Saved desktop observations no longer pass.');
 for(const file of assessment.screenshots){const bytes=files.get(file);if(!bytes)fail('Desktop screenshot is unavailable.');validatePng(bytes!);}
 files.set('runtime.json',Buffer.from(JSON.stringify({version:1,runtime:j.runtime,source:j.source,approval:a.digest,packageSha256:sha256(files.get('app.asar')!),reportSha256:sha256(files.get('observations.json')!),format:'asar-with-external-electron-runtime',executable:'harness-app',limitations:'Linux only; external pinned Electron runtime required. GUI diagnostics do not prove hostile application behaviour or native OS compatibility.'},null,2)+'\n'));
 const parent=await realpath(path.dirname(path.resolve(destination))),target=path.join(parent,path.basename(destination)),live=await canonicalProject(project);
 if([live,`${live}-harness`].some(root=>target===root||target.startsWith(root+path.sep)))fail('Export to a new folder outside source and harness state.');
 await mkdir(target);try{for(const [file,bytes]of files)await writeFile(path.join(target,file),bytes,{flag:'wx',mode:0o600});}catch(error){await rm(target,{recursive:true,force:true});throw error;}
});}
export async function releaseDesktop(project:string,id:string):Promise<void>{return withWriter(project,'desktop release',async()=>{
 const j=await readDesktopRun(project,id);if(['preparing','running'].includes(j.status))fail('Recover the desktop run before releasing its outputs.');await stopOwned(j);j.status='released';j.artifacts=[];delete j.package;delete j.report;await saveDesktopRun(project,j);await releaseArtifacts(project,id,new Set());
});}
