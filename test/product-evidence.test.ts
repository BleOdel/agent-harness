import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {saveApproval,newRun,saveDesktopRun} from '../src/desktop/store.ts';
import {putArtifact,sha256} from '../src/artifacts/store.ts';
import {draftProduct,approveProduct,assertProductCurrent,readProduct} from '../src/product/spec.ts';
import {productReport,recordAssessment} from '../src/product/report.ts';
import {captureBaseline} from '../src/workspace/candidate.ts';
import {desktopProtocol,desktopChoices,collectEvidence} from '../src/product/evidence/desktop.ts';
import {parseEvidenceScope,evidenceStatus} from '../src/product/evidence/schema.ts';
import {EvidenceReader} from '../src/product/evidence/reader.ts';
import {productSetup} from '../src/verbs/product.ts';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
async function fixture(t:any){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'product-evidence-'))),project=root+'/app';await mkdir(project);t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(project+'/package.json',JSON.stringify({name:'notes',version:'1.0.0',main:'main.cjs',scripts:{test:'node --test test/*.test.js'}}));await writeFile(project+'/main.cjs','// fixture source');
 await writeFile(project+'/features.json',JSON.stringify([{id:'notes',title:'Notes',priority:'must',status:'done',criteria:['Retain notes'],dependsOn:[]} ]));
 const runtime={image:'sha256:'+'a'.repeat(64),arch:'arm64',node:'v26.5.0',electron:'44.3.0',playwright:'1.63.0',asar:'4.3.0',protocol:await desktopProtocol()};
 const a=await saveApproval(project,{version:1,title:'Notes journey',timeoutSeconds:30,steps:[{action:'text',selector:'h1',expected:'Notes'},{action:'screenshot'}]},runtime);
 const source=(await captureBaseline(project,root+'/snapshot')).digest;
 const target=(await desktopChoices(project))[0]!.target,scope={version:1 as const,targets:[target]};
 await approveProduct(project,await draftProduct(project,'desktop','prototype',[],scope));
 const run=async(at='2026-09-20T00:00:00Z',status:'passed'|'failed'|'running'|'released'='passed',value='Notes')=>{
  const r=await newRun(project,a,'/usr/local/bin/docker');r.at=at;r.source=source;r.identity=sha256(JSON.stringify({source,approval:a.digest,runtime}));r.status=status;
  const provenance={producer:r.id,input:source,environment:r.identity,verification:'unverified' as const};
  const report=await putArtifact(project,'observations.json',Buffer.from(JSON.stringify({version:1,packaged:true,steps:[{action:'text',values:[value]},{action:'screenshot',file:'screen-1.png'}],errors:[]})),provenance);
  const screen=await putArtifact(project,'screen-1.png',png,provenance);
  const pkg=await putArtifact(project,'app.asar',Buffer.from('fixture packaged bytes'),{...provenance,verification:'diagnostics-passed'});
  r.report=report.id;r.package=pkg.id;r.artifacts=[report.id,screen.id,pkg.id];await saveDesktopRun(project,r);return r;
 };
 const evidence=()=>collectEvidence(project,source,scope);
 return {root,project,runtime,a,source,scope,target,run,evidence};
}
test('selected desktop evidence exposes validated subject, observations and limits',async t=>{
 const f=await fixture(t),r=await f.run(),e=await f.evidence(),record=e.records[0]!;
 assert.equal(record.outcome,'passed');assert.equal(record.applicability,'current');assert.equal(record.subject.digest,f.source);assert.equal(record.producer,r.id);assert.equal(record.artifacts.length,3);assert.ok(record.limitations.length);assert.equal(evidenceStatus(record),'passed');
 const report=await productReport(f.project);assert.equal(report.checks.find(c=>c.id.startsWith('runtime:'))?.status,'passed');assert.equal(report.ready,false);
});
test('saved passed flags cannot replace observed GUI comparisons',async t=>{
 const f=await fixture(t);await f.run(undefined,'passed','Wrong');assert.equal((await f.evidence()).records[0]!.outcome,'failed');
});
test('latest failed, interrupted or released selected run does not resurrect an older pass',async t=>{
 for(const status of ['failed','running','released'] as const){const f=await fixture(t);await f.run();await f.run('2026-09-21T00:00:00Z',status);assert.notEqual(evidenceStatus((await f.evidence()).records[0]!),'passed');}
});
test('unselected experiments and other source identities cannot shadow selected current evidence',async t=>{
 const f=await fixture(t);await f.run();const later=await f.run('2026-09-21T00:00:00Z','failed');later.source='b'.repeat(64);await saveDesktopRun(f.project,later);
 const other=await newRun(f.project,{...f.a,id:'journey-'+randomUUID()},'/usr/local/bin/docker');other.status='failed';await saveDesktopRun(f.project,other);
 assert.equal((await f.evidence()).records[0]!.outcome,'passed');
 const stale=await collectEvidence(f.project,'c'.repeat(64),f.scope);assert.equal(stale.records[0]!.applicability,'stale');assert.notEqual(evidenceStatus(stale.records[0]!),'passed');
});
test('artifact substitution, missing evidence and corrupt bytes fail closed',async t=>{
 for(const defect of ['producer','missing','blob','package','screen'] as const){
  const f=await fixture(t),r=await f.run();const artifact=defect==='package'?r.package!:defect==='screen'?r.artifacts[1]!:r.report!;
  const manifest=f.project+'-harness/artifacts/manifests/'+artifact+'.json';const a=JSON.parse(await readFile(manifest,'utf8'));
  if(defect==='producer'){a.producer='other-run';await writeFile(manifest,JSON.stringify(a));}
  else if(defect==='blob')await writeFile(f.project+'-harness/artifacts/blobs/'+a.sha256,'corrupt');
  else await rm(manifest);
  const e=await f.evidence();assert.notEqual(evidenceStatus(e.records[0]!),'passed',defect);
 }
});
test('malformed selected state and invalid approval/runtime never yield a pass',async t=>{
 for(const change of [{version:99},{at:'invalid'},{runtime:{}},{approvalDigest:'0'.repeat(64)},{identity:'0'.repeat(64)}]){
  const f=await fixture(t),r=await f.run();await writeFile(f.project+'-harness/desktop/runs/'+r.id+'/state.json',JSON.stringify({...r,...change}));assert.notEqual(evidenceStatus((await f.evidence()).records[0]!),'passed');
 }
});
test('scope parser refuses duplicates, unknown fields and inappropriate target types',async t=>{
 const f=await fixture(t);assert.throws(()=>parseEvidenceScope({...f.scope,targets:[f.target,f.target]},'desktop'));
 assert.throws(()=>parseEvidenceScope({...f.scope,targets:[{...f.target,required:false}]},'desktop'));
 assert.throws(()=>parseEvidenceScope(f.scope,'ml'));assert.throws(()=>parseEvidenceScope({...f.scope,version:2},'desktop'));
 const unavailable={...f.target,provider:'cpu-regression' as const};const e=await collectEvidence(f.project,f.source,{version:1,targets:[unavailable]});assert.equal(evidenceStatus(e.records[0]!),'unavailable');
});
test('legacy product approval stays readable and retains its missing desktop obligation',async t=>{
 const f=await fixture(t);await approveProduct(f.project,await draftProduct(f.project,'desktop','prototype',[]));const old=await readProduct(f.project);assert.equal(old?.evidence,undefined);assert.equal((await assertProductCurrent(f.project))?.digest,old?.digest);
 assert.equal((await productReport(f.project)).checks.find(c=>c.id==='runtime')?.status,'human');
});
test('reader does not create state and detects evidence changed during inspection',async t=>{
 const f=await fixture(t),r=await f.run(),reader=new EvidenceReader(f.project+'-harness');const file='desktop/runs/'+r.id+'/state.json';await reader.json(file);
 await writeFile(f.project+'-harness/'+file,JSON.stringify({...r,status:'failed'}));await assert.rejects(()=>reader.assertUnchanged(),/changed/i);
 const missing=f.root+'/absent',empty=new EvidenceReader(missing);assert.deepEqual(await empty.names('desktop/runs'),[]);await assert.rejects(()=>readdir(missing),/ENOENT/);
 const before=await readdir(f.project+'-harness');await f.evidence();assert.deepEqual(await readdir(f.project+'-harness'),before);
});
test('a selected evidence change invalidates the previous human assessment',async t=>{
 const f=await fixture(t);await f.run();let report=await productReport(f.project);
 await recordAssessment(f.project,report.source!,report.spec!,true,'Inspected packaged journey and remaining limitations.',report.evidenceDigest);
 assert.equal((await productReport(f.project)).checks.find(c=>c.id==='human-assessment')?.status,'passed');
 await f.run('2026-09-21T00:00:00Z','failed');report=await productReport(f.project);assert.equal(report.checks.find(c=>c.id==='human-assessment')?.status,'stale');
});
test('desktop setup previews selection, preserves it on Enter and cancellation saves nothing',async t=>{
 const f=await fixture(t),prior=(await readProduct(f.project))!.digest,answers=['4','1','','','n'],lines:string[]=[];
 await productSetup(f.project,{ask:async()=>answers.shift()!,write:s=>lines.push(s)});assert.equal((await readProduct(f.project))!.digest,prior);assert.ok(lines.some(l=>l.includes('Notes journey')));
});
test('a newer selected attempt without captured source blocks fallback to a previous pass',async t=>{
 const f=await fixture(t);await f.run();const r=await newRun(f.project,f.a,'/usr/local/bin/docker');r.at='2026-09-21T00:00:00Z';await saveDesktopRun(f.project,r);
 assert.notEqual(evidenceStatus((await f.evidence()).records[0]!),'passed');
});
test('selected approval changes between setup preview and saving are refused',async t=>{
 const f=await fixture(t),draft=await draftProduct(f.project,'desktop','prototype',[],f.scope);
 const {digest:_,...body}=f.a,changed={...body,journey:{...f.a.journey,title:'Revised journey'}};
 await writeFile(f.project+'-harness/desktop/approvals/'+f.a.id+'.json',JSON.stringify({...changed,digest:sha256(JSON.stringify(changed))}));
 await assert.rejects(()=>approveProduct(f.project,draft),/journey changed/i);
});
test('evidence selection participates in product protection and cannot silently clear the desktop requirement',async t=>{
 const f=await fixture(t),before=(await assertProductCurrent(f.project))!.digest;
 await approveProduct(f.project,await draftProduct(f.project,'desktop','prototype',[],{version:1,targets:[]}));
 assert.notEqual((await assertProductCurrent(f.project))!.digest,before);
 assert.equal((await productReport(f.project)).checks.find(c=>c.id==='runtime')?.status,'human');
});
test('existing scope is retained by guided setup and observations changed during sign-off are rejected',async t=>{
 const f=await fixture(t);await f.run();const answers=['4','1','','','y'];await productSetup(f.project,{ask:async()=>answers.shift()!,write:()=>{}});
 assert.deepEqual((await readProduct(f.project))!.evidence,f.scope);
 const report=await productReport(f.project);await f.run('2026-09-21T00:00:00Z','failed');
 await assert.rejects(()=>recordAssessment(f.project,report.source!,report.spec!,true,'Reviewed the GUI evidence and its scope.',report.evidenceDigest),/Evidence changed/);
});
test('bounded reader rejects links and oversized evidence and detects new run entries',async t=>{
 const f=await fixture(t),r=await f.run(),reader=new EvidenceReader(f.project+'-harness');
 await reader.names('desktop/runs');await mkdir(f.project+'-harness/desktop/runs/desktop-'+randomUUID());await assert.rejects(()=>reader.assertUnchanged(),/changed/i);
 const {symlink}=await import('node:fs/promises');await symlink(f.project+'/package.json',f.project+'-harness/alias.json');await assert.rejects(()=>new EvidenceReader(f.project+'-harness').json('alias.json'),/link/i);
 await writeFile(f.project+'-harness/large.json',' '.repeat(2*1024*1024+1));await assert.rejects(()=>new EvidenceReader(f.project+'-harness').json('large.json'),/limit/i);
 assert.ok(r.id);
});
