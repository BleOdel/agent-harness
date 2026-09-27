import {mkdir,writeFile,readFile,copyFile,rm,lstat} from 'node:fs/promises';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {withWriter,writerPath,recoverWriter} from '../../workspace/writer-lock.ts';import {captureBaseline,copySource,assertSnapshot,assertLiveBaseline} from '../../workspace/candidate.ts';
import {putArtifact,artifactBytes,listArtifacts,sha256} from '../../artifacts/store.ts';import {boundedOutput,validatePng} from '../../desktop/output.ts';import {validateApp} from '../../desktop/schema.ts';
import {approveNative,listNativeRuns} from '../store.ts';import {verifyNative,recoverNative} from '../controller.ts';
import {readGuiRuntime,guiResources} from './provision.ts';import {guiActions,assessMacJourney} from './schema.ts';
import {listGuiRuns,guiRunRoot,readGuiApproval,readGuiRun,saveGuiRun,type GuiRun,type GuiRuntime} from './store.ts';
export async function recoverGui(project:string,id:string){
 const saved=await readGuiRun(project,id);if(!['preparing','running'].includes(saved.status))return;
 const lock=await readFile(await writerPath(project),'utf8').then(s=>JSON.parse(s)).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return null;throw e;});
 if(lock){if(lock.pid!==saved.controllerPid)throw Error('Another writer owns this project.');await recoverWriter(project,lock.token);}
 return withWriter(project,'macOS GUI recovery',async()=>{const root=await guiRunRoot(project,id);for(const r of await lstat(root+'/candidate').then(()=>listNativeRuns(root+'/candidate')).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return [];throw e;}))if(['preparing','running'].includes(r.status))await recoverNative(root+'/candidate',r.id);saved.status='interrupted';saved.message='Owned VM resources recovered. Retry the saved journey from fresh source.';await saveGuiRun(project,saved);});
}
export async function verifyGui(project:string,id:string,notify:(s:string)=>void=()=>{},candidateRuntime?:GuiRuntime){return withWriter(project,'macOS GUI verification',async()=>{
 if((await listGuiRuns(project)).some(r=>['preparing','running'].includes(r.status)))throw Error('Recover the interrupted macOS GUI run before starting another.');
 const approval=await readGuiApproval(project,id),runtime=candidateRuntime??await readGuiRuntime();if(JSON.stringify(runtime)!==JSON.stringify(approval.runtime))throw Error('macOS GUI runtime changed. Review and approve the saved journey for this runtime.');
 const r:GuiRun={version:1,id:'macos-'+randomUUID(),approval:id,approvalDigest:approval.digest,runtime,at:new Date().toISOString(),controllerPid:process.pid,status:'preparing',message:'Preparing packaged macOS app.',artifacts:[]};const root=await guiRunRoot(project,r.id);await saveGuiRun(project,r);
 try{
  const baseline=await captureBaseline(project,root+'/source');r.source=baseline.digest;
  const main=validateApp(JSON.parse(await readFile(root+'/source/package.json','utf8')));if(!Object.hasOwn(baseline.files,main))throw Error('Missing desktop main entry.');
  let size=0;for(const name of Object.keys(baseline.files)){size+=(await boundedOutput(root+'/source',name,2*1024**2)).length;if(size>16*1024**2)throw Error('macOS GUI source exceeds 16 MiB.');}
  const candidate=root+'/candidate';await mkdir(candidate);await copySource(root+'/source',candidate+'/app');
  await copyFile(guiResources+'/driver.mjs',candidate+'/gui-driver.mjs');await writeFile(candidate+'/gui-actions.json',JSON.stringify(guiActions(approval.journey)));await writeFile(candidate+'/package.json','{"name":"harness-native-gui-job","private":true}');
  await writeFile(candidate+'/gui-run.sh',"set -eu\nuid=$(/usr/bin/id -u admin)\nfor attempt in {1..60}; do /bin/launchctl print gui/$uid >/dev/null 2>&1 && break; /bin/sleep 0.5; done\n/usr/bin/sudo -n /bin/launchctl asuser $uid /usr/bin/sudo -n -u admin /usr/bin/env -i HOME=/private/tmp/harness-home TMPDIR=/private/tmp PATH=/usr/bin:/bin:/usr/sbin:/sbin ELECTRON_RUN_AS_NODE=1 /usr/local/lib/harness/gui-tools/Electron.app/Contents/MacOS/Electron gui-driver.mjs\n");
  const screenshots=approval.journey.steps.flatMap((s,i)=>s.action==='screenshot'?[`screen-${i}.png`]:[]);
  const native=await approveNative(candidate,{version:1,title:approval.journey.title,entry:'gui-run.sh',timeoutSeconds:approval.journey.timeoutSeconds,expectedExit:0,stdout:'macOS GUI observations ready\n',artifacts:['observations.json','app.asar',...screenshots]},runtime.profile);
  r.status='running';await saveGuiRun(project,r);const result=await verifyNative(candidate,native.id,notify,Boolean(candidateRuntime));r.nativeRun=result.id;
  const artifacts=await listArtifacts(candidate),data=new Map<string,Buffer>();
  for(const id of result.artifacts){const a=artifacts.find(a=>a.id===id);if(!a)throw Error('Native evidence disappeared.');const bytes=await artifactBytes(candidate,id);data.set(a.name,bytes);const copy=await putArtifact(project,a.name,bytes,{producer:r.id,input:r.source,environment:sha256(JSON.stringify(runtime)),verification:'unverified'});r.artifacts.push(copy.id);}
  if(result.status!=='passed'){if(['preparing','running'].includes(result.status))r.status='running';throw Error(result.message+(data.get('stderr.txt')?.length?'\n'+data.get('stderr.txt')!.toString().slice(-1800):''));}
  const report=data.get('observations.json');if(!report)throw Error('No GUI observations were retained.');r.assessment=assessMacJourney(approval.journey,JSON.parse(report.toString()));
  for(const name of r.assessment.screenshots){const bytes=data.get(name);if(!bytes)throw Error('Missing GUI screenshot.');validatePng(bytes);}
  await assertSnapshot(baseline);await assertLiveBaseline(project,baseline);if(!r.assessment.passed)throw Error(r.assessment.failures.join('\n'));
  const assessment=await putArtifact(project,'gui-assessment.json',Buffer.from(JSON.stringify(r.assessment)),{producer:r.id,input:r.source,environment:sha256(JSON.stringify(runtime)),verification:'unverified'});r.artifacts.push(assessment.id);
  r.status='passed';r.message=`${r.assessment.checks} macOS GUI observations matched. Unsigned packaged-app diagnostics; source acceptance remains separate.`;
 }catch(e){const active=await lstat(root+'/candidate').then(()=>listNativeRuns(root+'/candidate')).then(rows=>rows.find(n=>['preparing','running'].includes(n.status))).catch(()=>undefined);r.status=active?'running':'failed';if(active)r.nativeRun=active.id;r.message=(e as Error).message;}
 finally{await saveGuiRun(project,r);notify(r.message);}
 return r;
});}
