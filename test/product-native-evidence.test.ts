import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {randomUUID} from 'node:crypto';
import {sha256,putArtifact} from '../src/artifacts/store.ts';
import {approveGui,saveGuiRun,type GuiRun} from '../src/native/gui/store.ts';
import {approveApple,saveAppleRun,type AppleRun} from '../src/native/apple/store.ts';
import {guiProtocol} from '../src/native/gui/provision.ts';import {appleProtocol} from '../src/native/apple/runtime.ts';
import {protocolHash,type NativeProfile} from '../src/native/provision.ts';
import {approveNative,saveNativeRun} from '../src/native/store.ts';
import {desktopChoices,collectEvidence} from '../src/product/evidence/desktop.ts';
import {evidenceStatus,parseEvidenceScope,type EvidenceTarget} from '../src/product/evidence/schema.ts';
import {draftProduct,approveProduct,readProduct} from '../src/product/spec.ts';
import {productSetup} from '../src/verbs/product.ts';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const kinds=['macos-electron','macos-native'] as const;
async function fixture(t:any,kind:typeof kinds[number]){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'native-evidence-'))),project=root+'/app';await mkdir(project);t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(project+'/package.json','{}');
 await writeFile(project+'/features.json',JSON.stringify([{id:'notes',title:'Notes',priority:'must',status:'todo',criteria:['Retain notes'],dependsOn:[]}]));
 const profile:NativeProfile={version:1,tart:'/tools/tart',tartHash:'1'.repeat(64),networkHash:'2'.repeat(64),cloneHash:'3'.repeat(64),image:'harness-macos-gui',files:{'disk.img':'4'.repeat(64),'nvram.bin':'5'.repeat(64),'config.json':'6'.repeat(64)},identities:{'disk.img':'7'.repeat(64),'nvram.bin':'8'.repeat(64),'config.json':'9'.repeat(64)},protocol:await protocolHash(),cpu:2,memoryMiB:4096,os:'26.6.2',arch:'arm64'};
 const journey={version:1,title:'Save note',timeoutSeconds:120,steps:[{action:'text',selector:'saved',expected:'Hello'},{action:'screenshot'}]};
 const a=kind==='macos-electron'?await approveGui(project,journey,{profile,protocol:await guiProtocol(),electron:'44.3.0'}):await approveApple(project,{...journey,entry:'build.sh',app:'build/Notes.app'},{profile,protocol:await appleProtocol()});
 const prefix=kind==='macos-electron'?'macos':'apple',folder=kind==='macos-electron'?'macos-gui':'apple-gui',source='b'.repeat(64),id=prefix+'-'+randomUUID(),child=project+'-harness/'+folder+'/runs/'+id+'/candidate';await mkdir(child,{recursive:true});
 const pkg=kind==='macos-electron'?'app.asar':'app.zip',entry=kind==='macos-electron'?'gui-run.sh':'apple-run.sh',stdout=kind==='macos-electron'?'macOS GUI observations ready\n':'Native UI observations ready\n';
 const na=await approveNative(child,{version:1,title:journey.title,entry,timeoutSeconds:120,expectedExit:0,stdout,artifacts:['observations.json',pkg,'screen-1.png']},profile),nativeId='native-'+randomUUID(),nativeSource='c'.repeat(64),profileDigest=sha256(JSON.stringify(profile));
 const nativeArtifacts:string[]=[],outerArtifacts:string[]=[];
 const values:[string,Buffer][]=[['stdout.txt',Buffer.from(stdout)],['stderr.txt',Buffer.alloc(0)],['assessment.json',Buffer.from(JSON.stringify({passed:true,expectedExit:0,observedExit:0,stdoutMatches:true}))],[pkg,Buffer.from('packaged fixture')],['observations.json',Buffer.from(JSON.stringify({version:1,packaged:true,steps:[{action:'text',values:['Hello']},{action:'screenshot',file:'screen-1.png'}],errors:[]}))],['screen-1.png',png]];
 for(const [name,bytes]of values){nativeArtifacts.push((await putArtifact(child,name,bytes,{producer:nativeId,input:nativeSource,environment:profileDigest,verification:'unverified'})).id);outerArtifacts.push((await putArtifact(project,name,bytes,{producer:id,input:source,environment:sha256(JSON.stringify(a.runtime)),verification:'unverified'})).id);}
 const native={version:1 as const,id:nativeId,token:randomUUID(),approval:na.id,profileDigest,status:'passed' as const,message:'Completed',at:'2026-09-20T00:00:00Z',artifacts:nativeArtifacts,source:nativeSource,outputMounted:false,vmStarted:true,controllerPid:123};await saveNativeRun(child,native);
 const r={version:1 as const,id,approval:a.id,approvalDigest:a.digest,runtime:a.runtime,at:'2026-09-20T00:00:00Z',controllerPid:123,status:'passed' as const,message:'Passed',source,artifacts:outerArtifacts,nativeRun:nativeId};
 const save=async(value:unknown)=>kind==='macos-electron'?saveGuiRun(project,value as GuiRun):saveAppleRun(project,value as AppleRun);await save(r);
 const target:EvidenceTarget={provider:kind,approval:a.id,approvalDigest:a.digest,runtime:sha256(JSON.stringify(a.runtime))},scope={version:1 as const,targets:[target]};
 const evidence=async()=>(await collectEvidence(project,source,scope)).records[0]!;
 return {root,project,kind,folder,a,r,child,native,save,source,target,scope,evidence,profile};
}
for(const kind of kinds){
 test(`${kind}: aggregates retained GUI and completed VM lineage without starting a runtime`,async t=>{
  const f=await fixture(t,kind),before=await readdir(f.project+'-harness');const e=await f.evidence();assert.equal(evidenceStatus(e),'passed',e.detail);assert.equal(e.producer,f.r.id);assert.equal(e.execution?.producer,f.native.id);assert.equal(e.execution?.source,f.native.source);assert.equal(e.subject.digest,f.source);assert.ok(e.artifacts.some(a=>a.name===(kind==='macos-native'?'app.zip':'app.asar')));assert.match(e.detail,/macOS/);assert.ok(e.limitations.length);assert.deepEqual(await readdir(f.project+'-harness'),before);
  assert.ok((await desktopChoices(f.project)).some(c=>c.target.provider===kind&&c.target.approval===f.a.id));
 });
 test(`${kind}: rejects copied artifact substitution, missing screenshots and duplicate names`,async t=>{
  for(const defect of ['producer','missing','duplicate','child-mismatch'] as const){const f=await fixture(t,kind);const id=f.r.artifacts[defect==='missing'?5:4]!,file=f.project+'-harness/artifacts/manifests/'+id+'.json',a=JSON.parse(await readFile(file,'utf8'));
   if(defect==='producer'){a.producer='another-run';await writeFile(file,JSON.stringify(a));}
   if(defect==='missing')await rm(file);
   if(defect==='duplicate'){const copy=await putArtifact(f.project,a.name,await readFile(f.project+'-harness/artifacts/blobs/'+a.sha256),{producer:f.r.id,input:f.source,environment:f.target.runtime,verification:'unverified'});await f.save({...f.r,artifacts:[...f.r.artifacts,copy.id]});}
   if(defect==='child-mismatch'){const bytes=Buffer.from(JSON.stringify({version:1,packaged:true,steps:[{action:'text',values:['Hello']},{action:'screenshot',file:'screen-1.png'}],errors:[],extra:'changed'}));a.sha256=sha256(bytes);a.size=bytes.length;await writeFile(file,JSON.stringify(a));await writeFile(f.project+'-harness/artifacts/blobs/'+a.sha256,bytes);}
   assert.notEqual(evidenceStatus(await f.evidence()),'passed',defect);
  }
 });
 test(`${kind}: a passed wrapper cannot hide unfinished cleanup or missing native execution`,async t=>{
  for(const change of [{status:'running'},{status:'failed'},{outputMounted:true},{source:undefined},{profileDigest:'0'.repeat(64)}]){const f=await fixture(t,kind);await saveNativeRun(f.child,{...f.native,...change} as any);assert.notEqual(evidenceStatus(await f.evidence()),'passed');}
  const f=await fixture(t,kind);await f.save({...f.r,nativeRun:undefined});assert.notEqual(evidenceStatus(await f.evidence()),'passed');
 });
 test(`${kind}: latest selected failure or source-less attempt supersedes a pass; other source stays historical`,async t=>{
  const f=await fixture(t,kind),newer={...f.r,id:f.r.id.split('-')[0]+'-'+randomUUID(),at:'2026-09-21T00:00:00Z',status:'failed'};await f.save(newer);assert.equal((await f.evidence()).outcome,'failed');
  await f.save({...newer,status:'preparing',source:undefined});assert.notEqual(evidenceStatus(await f.evidence()),'passed');
  await f.save({...newer,source:'d'.repeat(64)});assert.equal(evidenceStatus(await f.evidence()),'passed');
  assert.equal((await collectEvidence(f.project,'e'.repeat(64),f.scope)).records[0]!.applicability,'stale');
 });
 test(`${kind}: scope validates provider IDs and pins approvals; malformed records cannot pass`,async t=>{
  const f=await fixture(t,kind);assert.deepEqual(parseEvidenceScope(f.scope,'desktop'),f.scope);assert.throws(()=>parseEvidenceScope({...f.scope,targets:[{...f.target,approval:'journey-'+randomUUID()}]},'desktop'));
  await f.save({...f.r,at:'not-a-date'});assert.equal((await f.evidence()).applicability,'invalid');
 });
}
test('guided product setup selects a matrix of Mac targets and retains it on Enter',async t=>{
 const f=await fixture(t,'macos-native'),answers=['4','1','','1','y'];const lines:string[]=[];await productSetup(f.project,{ask:async()=>answers.shift()!,write:s=>lines.push(s)});assert.equal((await readProduct(f.project))!.evidence!.targets[0]!.provider,'macos-native');assert.ok(lines.some(s=>s.includes('macos-native')));
 const before=(await readProduct(f.project))!.digest;answers.push('4','1','','','y');await productSetup(f.project,{ask:async()=>answers.shift()!,write:()=>{}});assert.equal((await readProduct(f.project))!.digest,before);
});
test('raw native GUI failure cannot be overridden by passed assessment flags in either copy',async t=>{
 const f=await fixture(t,'macos-native'),bytes=Buffer.from(JSON.stringify({version:1,packaged:true,steps:[{action:'text',values:['Wrong']},{action:'screenshot',file:'screen-1.png'}],errors:[]}));
 for(const [project,id] of [[f.project,f.r.artifacts[4]!],[f.child,f.native.artifacts[4]!]]){const file=project+'-harness/artifacts/manifests/'+id+'.json',a=JSON.parse(await readFile(file,'utf8'));a.sha256=sha256(bytes);a.size=bytes.length;await writeFile(file,JSON.stringify(a));await writeFile(project+'-harness/artifacts/blobs/'+a.sha256,bytes);}
 await f.save({...f.r,assessment:{passed:true,checks:1,failures:[],screenshots:['screen-1.png']}});const e=await f.evidence();assert.equal(e.applicability,'current');assert.equal(e.outcome,'failed');
});
test('native script exit/output comparison is recomputed and missing execution artifacts fail closed',async t=>{
 for(const defect of ['exit','stdout','missing']){const f=await fixture(t,'macos-electron');const index=defect==='stdout'?0:2,id=f.native.artifacts[index]!,file=f.child+'-harness/artifacts/manifests/'+id+'.json';
  if(defect==='missing')await rm(file);else{const bytes=Buffer.from(defect==='exit'?JSON.stringify({passed:true,expectedExit:0,observedExit:1,stdoutMatches:true}):'unexpected stdout');
   for(const [project,artifact]of [[f.child,id],[f.project,f.r.artifacts[index]!]]){const p=project+'-harness/artifacts/manifests/'+artifact+'.json',a=JSON.parse(await readFile(p,'utf8'));a.sha256=sha256(bytes);a.size=bytes.length;await writeFile(p,JSON.stringify(a));await writeFile(project+'-harness/artifacts/blobs/'+a.sha256,bytes);}
  }assert.notEqual(evidenceStatus(await f.evidence()),'passed',defect);
 }
});
test('native runtime/protocol changes invalidate selected evidence and approval changes are refused at save',async t=>{
 const f=await fixture(t,'macos-native'),draft=await draftProduct(f.project,'desktop','prototype',[],f.scope);
 const {digest:_,...body}=f.a,newBody={...body,runtime:{...f.a.runtime,protocol:'0'.repeat(64)}};
 await writeFile(f.project+'-harness/apple-gui/approvals/'+f.a.id+'.json',JSON.stringify({...newBody,digest:sha256(JSON.stringify(newBody))}));
 assert.equal((await f.evidence()).applicability,'stale');await assert.rejects(()=>approveProduct(f.project,draft),/journey changed/);
});
test('Mac platforms cannot satisfy each other and a missing selected journey remains required',async t=>{
 const f=await fixture(t,'macos-electron');const cross={...f.target,provider:'macos-native' as const};assert.notEqual(evidenceStatus((await collectEvidence(f.project,f.source,{version:1,targets:[cross]})).records[0]!),'passed');
 const missing={...f.target,approval:'macos-check-'+randomUUID()};const e=(await collectEvidence(f.project,f.source,{version:1,targets:[missing]})).records[0]!;assert.equal(e.applicability,'missing');assert.equal(e.required,true);
});
