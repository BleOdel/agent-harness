import {mkdir,writeFile,readFile,copyFile,rm,lstat} from 'node:fs/promises';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {withWriter,writerPath,recoverWriter} from '../../workspace/writer-lock.ts';import {captureBaseline,copySource,assertSnapshot,assertLiveBaseline} from '../../workspace/candidate.ts';
import {putArtifact,artifactBytes,listArtifacts,sha256} from '../../artifacts/store.ts';import {boundedOutput,validatePng} from '../../desktop/output.ts';
import {approveNative,listNativeRuns} from '../store.ts';import {verifyNative,recoverNative} from '../controller.ts';
import {readAppleRuntime,appleResources} from './runtime.ts';import {appleActions,assessAppleJourney} from './schema.ts';
import {listAppleRuns,appleRunRoot,readAppleApproval,readAppleRun,saveAppleRun,type AppleRun,type AppleRuntime} from './store.ts';
export async function recoverApple(project:string,id:string){
 const saved=await readAppleRun(project,id);if(!['preparing','running'].includes(saved.status))return;
 const lock=await readFile(await writerPath(project),'utf8').then(s=>JSON.parse(s)).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return null;throw e;});
 if(lock){if(lock.pid!==saved.controllerPid)throw Error('Another writer owns this project.');await recoverWriter(project,lock.token);}
 return withWriter(project,'native UI recovery',async()=>{const root=await appleRunRoot(project,id);for(const r of await lstat(root+'/candidate').then(()=>listNativeRuns(root+'/candidate')).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return [];throw e;}))if(['preparing','running'].includes(r.status))await recoverNative(root+'/candidate',r.id);saved.status='interrupted';saved.message='Owned VM resources recovered. Retry the saved journey from fresh source.';await saveAppleRun(project,saved);});
}
export async function verifyApple(project:string,id:string,notify:(s:string)=>void=()=>{},candidateRuntime?:AppleRuntime){return withWriter(project,'native UI verification',async()=>{
 if((await listAppleRuns(project)).some(r=>['preparing','running'].includes(r.status)))throw Error('Recover the interrupted native UI run before starting another.');
 const approval=await readAppleApproval(project,id),runtime=candidateRuntime??await readAppleRuntime();if(JSON.stringify(runtime)!==JSON.stringify(approval.runtime))throw Error('native UI runtime changed. Review and approve the saved journey for this runtime.');
 const r:AppleRun={version:1,id:'apple-'+randomUUID(),approval:id,approvalDigest:approval.digest,runtime,at:new Date().toISOString(),controllerPid:process.pid,status:'preparing',message:'Preparing packaged macOS app.',artifacts:[]};const root=await appleRunRoot(project,r.id);await saveAppleRun(project,r);
 try{
  const baseline=await captureBaseline(project,root+'/source');r.source=baseline.digest;
  if(!Object.hasOwn(baseline.files,approval.journey.entry))throw Error('Missing approved build script.');
  let size=0;for(const name of Object.keys(baseline.files)){size+=(await boundedOutput(root+'/source',name,2*1024**2)).length;if(size>16*1024**2)throw Error('native UI source exceeds 16 MiB.');}
  const candidate=root+'/candidate';await mkdir(candidate);await copySource(root+'/source',candidate+'/app-source');
  await copyFile(appleResources+'/driver.swift',candidate+'/apple-driver.swift');await copyFile(appleResources+'/run.sh',candidate+'/apple-driver.sh');
  await writeFile(candidate+'/apple-actions.json',JSON.stringify(appleActions(approval.journey)));await writeFile(candidate+'/package.json','{"name":"harness-native-ui-job","private":true}');
  await writeFile(candidate+'/apple-run.sh',`set -eu\n(cd app-source; /bin/zsh -f '${approval.journey.entry}') >&2\n[[ -d 'app-source/${approval.journey.app}' && ! -L 'app-source/${approval.journey.app}' ]]\n/usr/bin/ditto -c -k --keepParent 'app-source/${approval.journey.app}' app.zip\n/bin/zsh -f apple-driver.sh\n`);
  const screenshots=approval.journey.steps.flatMap((s,i)=>s.action==='screenshot'?[`screen-${i}.png`]:[]);
  const native=await approveNative(candidate,{version:1,title:approval.journey.title,entry:'apple-run.sh',timeoutSeconds:approval.journey.timeoutSeconds,expectedExit:0,stdout:'Native UI observations ready\n',artifacts:['observations.json','app.zip',...screenshots]},runtime.profile);
  r.status='running';await saveAppleRun(project,r);const result=await verifyNative(candidate,native.id,notify,false);r.nativeRun=result.id;
  const artifacts=await listArtifacts(candidate),data=new Map<string,Buffer>();
  for(const id of result.artifacts){const a=artifacts.find(a=>a.id===id);if(!a)throw Error('Native evidence disappeared.');const bytes=await artifactBytes(candidate,id);data.set(a.name,bytes);const copy=await putArtifact(project,a.name,bytes,{producer:r.id,input:r.source,environment:sha256(JSON.stringify(runtime)),verification:'unverified'});r.artifacts.push(copy.id);}
  if(result.status!=='passed'){if(['preparing','running'].includes(result.status))r.status='running';throw Error(result.message+(data.get('stderr.txt')?.length?'\n'+data.get('stderr.txt')!.toString().slice(-1800):''));}
  const report=data.get('observations.json');if(!report)throw Error('No GUI observations were retained.');r.assessment=assessAppleJourney(approval.journey,JSON.parse(report.toString()));
  for(const name of r.assessment.screenshots){const bytes=data.get(name);if(!bytes)throw Error('Missing GUI screenshot.');validatePng(bytes);}
  await assertSnapshot(baseline);await assertLiveBaseline(project,baseline);if(!r.assessment.passed)throw Error(r.assessment.failures.join('\n'));
  const assessment=await putArtifact(project,'gui-assessment.json',Buffer.from(JSON.stringify(r.assessment)),{producer:r.id,input:r.source,environment:sha256(JSON.stringify(runtime)),verification:'unverified'});r.artifacts.push(assessment.id);
  r.status='passed';r.message=`${r.assessment.checks} native UI observations matched. Native app diagnostics; source acceptance remains separate.`;
 }catch(e){const active=await lstat(root+'/candidate').then(()=>listNativeRuns(root+'/candidate')).then(rows=>rows.find(n=>['preparing','running'].includes(n.status))).catch(()=>undefined);r.status=active?'running':'failed';if(active)r.nativeRun=active.id;r.message=(e as Error).message;}
 finally{await saveAppleRun(project,r);notify(r.message);}
 return r;
});}
