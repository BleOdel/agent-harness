import {mkdir,writeFile,readFile} from 'node:fs/promises';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {nativeRoot} from '../provision.ts';import {withWriter} from '../../workspace/writer-lock.ts';import {saveJson,sha256,listArtifacts,artifactBytes} from '../../artifacts/store.ts';
import {readAppleRuntime} from './runtime.ts';import {appleScaffold,appleNotesJourney} from './scaffold.ts';import {approveApple} from './store.ts';import {verifyApple} from './controller.ts';import {assessAppleJourney} from './schema.ts';
export async function validateApple(notify:(s:string)=>void=()=>{}){
 const runtime=await readAppleRuntime(false),cases=[];
 for(const framework of ['swiftui','appkit'] as const){
  const project=path.join(nativeRoot,'apple-validation',randomUUID());await mkdir(project,{recursive:true});for(const [name,text]of await appleScaffold(framework))await writeFile(project+'/'+name,text);
  const a=await approveApple(project,appleNotesJourney,runtime);notify('Checking '+framework+' keyboard, restart, validation and screenshot.');const r=await verifyApple(project,a.id,notify,runtime);if(r.status!=='passed')throw Error(framework+' native UI fixture failed: '+r.message);
  const files=(await listArtifacts(project)).filter(f=>r.artifacts.includes(f.id));const report=files.find(f=>f.name==='observations.json');if(!report)throw Error('Missing observed native journey.');
  const wrong={...appleNotesJourney,steps:appleNotesJourney.steps.map(s=>s.action==='text'?{...s,expected:'deliberately wrong'}:s)};if(assessAppleJourney(wrong,JSON.parse((await artifactBytes(project,report.id)).toString())).passed)throw Error('Wrong expected output was accepted.');
  cases.push({framework,project,run:r.id});
  if(framework==='swiftui'){
   const original=await readFile(project+'/main.swift','utf8');await writeFile(project+'/main.swift',original.replace('UserDefaults.standard.string(forKey:"note") ?? ""','""'));
   const lost=await verifyApple(project,a.id,notify,runtime);await writeFile(project+'/main.swift',original);const lostFiles=(await listArtifacts(project)).filter(f=>lost.artifacts.includes(f.id)),lostReport=lostFiles.find(f=>f.name==='observations.json');
   const observations=lostReport?JSON.parse((await artifactBytes(project,lostReport.id)).toString()):null;
   if(lost.status!=='failed'||!lost.message.includes('saved')||observations?.steps?.[4]?.action!=='restart'||!observations?.steps?.[3]?.values?.includes('My native note'))throw Error('Lost-persistence mutation did not reach a successful save and restart before failing.');cases.push({framework:'broken-persistence',project,run:lost.id});
  }
 }
 const receipt={version:1,at:new Date().toISOString(),profile:sha256(JSON.stringify(runtime.profile)),protocol:runtime.protocol,cases,observed:['SwiftUI and AppKit accessibility controls','keyboard save','restart persistence','blank input validation','app-window screenshot','wrong expected values rejected','lost persistence rejected'],limitations:['same-guest diagnostics, not adversarial source acceptance','macOS only; no iOS simulator','ad-hoc guest bundles, not signed/notarised distribution']};
 await withWriter(nativeRoot,'native UI validation',async()=>{if(JSON.stringify(await readAppleRuntime(false))!==JSON.stringify(runtime))throw Error('Native runtime changed during validation.');await saveJson(nativeRoot,'apple-boundary.json',receipt);});notify('SwiftUI/AppKit runtime validated. Next: harness macos-native setup.');return receipt;
}
