import {mkdir,writeFile,readFile} from 'node:fs/promises';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {withWriter} from '../../workspace/writer-lock.ts';import {saveJson,sha256,listArtifacts,artifactBytes} from '../../artifacts/store.ts';
import {nativeRoot,saveNativeProfile,readNativeProfile} from '../provision.ts';import {verifyNativeBoundary} from '../verify.ts';import {readNativeRun} from '../store.ts';
import {desktopScaffold,notesJourney} from '../../desktop/scaffold.ts';
import {GUI_IMAGE,ELECTRON_SHA,ELECTRON_VERSION,guiProtocol,readGuiRuntime} from './provision.ts';
import {approveGui,type GuiRuntime} from './store.ts';import {verifyGui} from './controller.ts';
export async function guiFixture(runtime:GuiRuntime,notify:(s:string)=>void=()=>{},candidate=false){
 const project=path.join(nativeRoot,'gui-validation',randomUUID());await mkdir(project,{recursive:true});
 for(const [file,text] of await desktopScaffold()){const p=path.join(project,file);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,text);}
 const journey={...notesJourney,timeoutSeconds:180};const approval=await approveGui(project,journey,runtime);const positive=await verifyGui(project,approval.id,notify,candidate?runtime:undefined);if(positive.status!=='passed')throw Error('Packaged macOS GUI fixture failed: '+positive.message);
 const wrong=await approveGui(project,{...journey,title:'Wrong text negative control',steps:journey.steps.map(s=>s.action==='text'?{...s,expected:'not the saved note'}:s)},runtime);
 const rejected=await verifyGui(project,wrong.id,notify,candidate?runtime:undefined);if(rejected.status!=='failed'||!rejected.assessment||rejected.assessment.passed)throw Error('GUI wrong-output control was not rejected by host comparison.');
 const store=project+'/src/store.cjs',original=await readFile(store,'utf8');await writeFile(store,original+'\nmodule.exports.load = async () => [];\n');
 const lost=await verifyGui(project,approval.id,notify,candidate?runtime:undefined);if(lost.status!=='failed'||!lost.message.includes('#notes li'))throw Error('GUI persistence mutation was not rejected.');await writeFile(store,original);
 const screenshots=(await listArtifacts(project)).filter(a=>a.producer===positive.id&&a.name.endsWith('.png'));if(screenshots.length!==1||(await artifactBytes(project,screenshots[0]!.id)).length<500)throw Error('A rendered app screenshot was not retained.');
 return {version:1,at:new Date().toISOString(),project,runs:[positive.id,rejected.id,lost.id],screenshots:screenshots.map(a=>a.id),observed:['macOS packaged Electron app launch','keyboard save','restart persistence','blank-input validation','retained screenshot','wrong-expectation rejection','broken persistence rejection'],limitations:['Electron only; no SwiftUI/AppKit automation','unsigned local package; no signing/notarisation or installer','guest driver and app share a VM: diagnostics, not independent application acceptance']};
}
export async function validateGuiBase(notify:(s:string)=>void=()=>{}){
 const prepared=JSON.parse(await readFile(nativeRoot+'/gui-prepared.json','utf8'));if(prepared.image!==GUI_IMAGE||prepared.electron!==ELECTRON_VERSION||prepared.archive!==ELECTRON_SHA)throw Error('GUI preparation evidence is missing or changed.');
 const profile=await withWriter(nativeRoot,'GUI base registration',()=>saveNativeProfile(GUI_IMAGE,prepared.os));
 const runtime={profile,protocol:await guiProtocol(),electron:ELECTRON_VERSION};
 let nativeEvidence=await readFile(nativeRoot+'/boundary.json','utf8').then(s=>JSON.parse(s)).catch(()=>null);
 if(nativeEvidence?.version!==1||nativeEvidence?.profile!==sha256(JSON.stringify(profile))||!Array.isArray(nativeEvidence?.runs)||nativeEvidence.runs.length!==4)nativeEvidence=null;
 if(nativeEvidence){try{const runs=await Promise.all(nativeEvidence.runs.map((id:string)=>readNativeRun(nativeEvidence.project,id)));if(runs.map(r=>r.status).join(',')!=='passed,failed,failed,interrupted'||runs.some(r=>r.outputMounted||r.profileDigest!==nativeEvidence.profile))nativeEvidence=null;}catch{nativeEvidence=null;}}
 if(nativeEvidence)notify('Reusing completed native isolation/recovery evidence for this exact base and protocol.');
 else nativeEvidence=await verifyNativeBoundary(profile,notify,true);
 const guiEvidence=await guiFixture(runtime,notify,true);
 await withWriter(nativeRoot,'GUI base activation',async()=>{if(JSON.stringify(await readNativeProfile(false,true))!==JSON.stringify(profile)||await guiProtocol()!==runtime.protocol)throw Error('Runtime changed during GUI verification.');await saveJson(nativeRoot,'profile.json',profile);await saveJson(nativeRoot,'gui-tools.json',{version:1,profile:sha256(JSON.stringify(profile)),electron:ELECTRON_VERSION,archive:ELECTRON_SHA});await saveJson(nativeRoot,'gui-boundary.json',{nativeEvidence,guiEvidence,protocol:runtime.protocol});});
 notify('macOS GUI runtime verified and activated. Existing native script checks need approval for this new base.');return guiEvidence;
}
export async function verifyInstalledGui(notify:(s:string)=>void=()=>{}){return guiFixture(await readGuiRuntime(),notify);}
