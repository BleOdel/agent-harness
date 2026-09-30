import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,realpath,mkdir,writeFile,rm,readFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {draftProduct,approveProduct} from '../src/product/spec.ts';import {productReport,recordAssessment} from '../src/product/report.ts';import {approveSecurity,saveRun,parseApproval,type SecurityRun} from '../src/security/store.ts';import {securityReport,recordSecurityAssessment,acceptSecurityRisk} from '../src/security/report.ts';import {putArtifact,sha256,saveJson} from '../src/artifacts/store.ts';import {securitySetup} from '../src/verbs/security.ts';
import {scope,good} from './security-fixture.ts';
const image='sha256:'+'a'.repeat(64),source='b'.repeat(64);
async function fixture(fn:(f:any)=>Promise<void>,consequence:'prototype'|'sensitive'='prototype'){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'security-fixture-'))),project=root+'/app';await mkdir(project);await writeFile(project+'/package.json','{"name":"fixture","type":"module"}');await writeFile(project+'/features.json',JSON.stringify([{id:'service',title:'Service',priority:'must',status:'done',criteria:['Protect private content'],dependsOn:[]} ]));
 try{const product=await draftProduct(project,'api',consequence,[]);await approveProduct(project,product);const a=await approveSecurity(project,scope,image),context={source,product:product.digest,consequence,acceptance:[]};
 const save=async(obs:any,at='2026-09-29T10:00:00.000Z',id='security-run-11111111-1111-4111-8111-111111111111')=>{const identity=sha256(JSON.stringify({source,approval:a.digest,image,protocol:a.protocol})),artifact=await putArtifact(project,'security-observations.json',Buffer.from(JSON.stringify(obs)),{producer:id,input:source,environment:identity,verification:'unverified'});const r:SecurityRun={version:1,id,at,approval:a.digest,product:a.product,protocol:a.protocol,image,docker:'/fixture/docker',token:'11111111-1111-4111-8111-111111111111',status:'passed',containers:[],source,identity,report:artifact.id,message:'Synthetic fixture'};await saveRun(project,r);return {r,artifact};};await fn({project,a,context,save,root});
 }finally{await rm(root,{recursive:true,force:true});}}
test('scoped report rechecks observations and requires its own assessment; counts and findings never expose raw keys',async()=>fixture(async f=>{
 await f.save(good);let r=await securityReport(f.project,f.context);assert.equal(r.status,'missing');assert.equal(r.requirements.find(x=>x.id==='probes')?.status,'passed');await recordSecurityAssessment(f.project,r,true,'Reviewed synthetic authorization/privacy scope and remaining runtime limits.');r=await securityReport(f.project,f.context);assert.equal(r.status,'passed');assert.equal(r.complete,true);assert.ok(!JSON.stringify(r).includes('rawBody'));
 const stale=await securityReport(f.project,{...f.context,source:'c'.repeat(64)});assert.equal(stale.status,'stale');assert.equal(stale.complete,false);
}));
test('new incomplete current attempt prevents fallback to an old passed observation',async()=>fixture(async f=>{
 await f.save(good);const {r}=await f.save(good,'2026-09-29T10:01:00.000Z','security-run-22222222-2222-4222-8222-222222222222');delete r.source;delete r.report;r.status='running';await saveRun(f.project,r);const report=await securityReport(f.project,f.context);assert.equal(report.status,'failed');assert.ok(report.next.includes('recover'));
}));
test('risk acceptance is distinct from passed checks and cannot waive high severity or sensitive product findings',async()=>fixture(async f=>{
 await f.save({...good,statuses:{...good.statuses,origin:200}});let report=await securityReport(f.project,f.context);assert.equal(report.findings[0]?.severity,'medium');await acceptSecurityRisk(f.project,report,'prototype','origin','Local prototype risk reviewed; no deployment or third-party exposure approved.');await recordSecurityAssessment(f.project,report,true,'Reviewed the origin finding and bounded synthetic-only prototype scope.');report=await securityReport(f.project,f.context);assert.equal(report.status,'accepted-risk');assert.equal(report.findings[0]?.disposition,'accepted-risk');
 await assert.rejects(acceptSecurityRisk(f.project,report,'sensitive','origin','This must not waive a sensitive product finding.'),/cannot|policy/);
 await f.save({...good,keyLeaks:1},'2026-09-29T10:02:00.000Z','security-run-33333333-3333-4333-8333-333333333333');report=await securityReport(f.project,f.context);assert.equal(report.status,'failed');await assert.rejects(acceptSecurityRisk(f.project,report,'prototype','privacy','This high severity finding must remain an open blocker.'),/cannot/);
}));
for(const mode of ['observation','blob','provenance','cleanup','scope'])test('security report rejects '+mode+' tampering',async()=>fixture(async f=>{
 const {r,artifact}=await f.save(good);
 if(mode==='observation'){await writeFile(f.project+'-harness/artifacts/blobs/'+artifact.sha256,'{"version":1,"passed":true}');}
 if(mode==='blob')await rm(f.project+'-harness/artifacts/blobs/'+artifact.sha256);
 if(mode==='provenance'){artifact.producer='other';await saveJson(f.project+'-harness/artifacts/manifests',artifact.id+'.json',artifact);}
 if(mode==='cleanup'){r.containers=['harness-security-11111111-1111-4111-8111-111111111111'];await saveRun(f.project,r);}
 if(mode==='scope')await writeFile(f.project+'-harness/security/approved.json','{"secret":"must-not-leak"}');
 const report=await securityReport(f.project,f.context);assert.equal(report.complete,false);assert.equal(report.status,'failed');assert.ok(!JSON.stringify(report).includes('must-not-leak'));if(mode==='scope'){const full=await productReport(f.project);assert.equal(full.checks.find(c=>c.id==='security')?.status,'failed');}
}));
test('unavailable dependency intelligence and declared dependencies never turn into a clean scan',async()=>fixture(async f=>{
 await f.save(good);await writeFile(f.project+'/package.json','{"dependencies":{"some-package":"1.0.0"}}');const r=await securityReport(f.project,f.context);assert.equal(r.status,'unavailable');assert.equal(r.complete,false);
}));
test('general product assessment does not clear missing security or performance for sensitive products',async()=>fixture(async f=>{
 const r=await productReport(f.project);await recordAssessment(f.project,r.source!,r.spec!,true,'General usability review only; no security or performance waiver.');const after=await productReport(f.project);assert.notEqual(after.checks.find(c=>c.id==='security')?.status,'passed');assert.equal(after.checks.find(c=>c.id==='performance')?.status,'missing');assert.equal(after.ready,false);
},'sensitive'));
test('guided security scope previews synthetic fields and budget before saving; Enter reuses saved endpoints',async()=>fixture(async f=>{
 const answers=['','','','','1','2','','','','','','','','1','y','','n','y'],lines:string[]=[];await securitySetup(f.project,{ask:async()=>{assert.ok(answers.length);return answers.shift()!;},write:s=>lines.push(s)});assert.ok(lines.some(l=>l.includes('512 MiB')));assert.ok(lines.some(l=>l.includes('Security scope saved')));assert.equal(answers.length,0);
}));

test('changed rules and scope invalidate security assessments; selected acceptance evidence is bound to signoff',async()=>fixture(async f=>{
 const a=await approveSecurity(f.project,{...scope,acceptanceTasks:['service']},image);
 const first={...f.context,acceptance:[{id:'acceptance:service',status:'passed',detail:'passed: first-proof.json'}]};
 let report=await securityReport(f.project,first);await recordSecurityAssessment(f.project,report,true,'Reviewed the selected authorization and lifecycle acceptance evidence.');
 const changed=await securityReport(f.project,{...first,acceptance:[{id:'acceptance:service',status:'passed',detail:'passed: second-proof.json'}]});assert.notEqual(changed.evidenceDigest,report.evidenceDigest);assert.equal(changed.requirements.find(r=>r.id==='security-assessment')?.status,'stale');
 const missing=await securityReport(f.project,f.context);assert.equal(missing.requirements.find(r=>r.id==='acceptance:service')?.status,'missing');
 const {digest,...body}=a;body.protocol='e'.repeat(64);const old=parseApproval({...body,digest:sha256(JSON.stringify(body))});await saveJson(f.project+'-harness/security','approved.json',old);assert.equal((await securityReport(f.project,first)).status,'stale');
}));

test('risk disposition cannot substitute prototype policy for an approved sensitive product',async()=>fixture(async f=>{
 await f.save({...good,statuses:{...good.statuses,origin:200}});const report=await securityReport(f.project,f.context);
 await assert.rejects(acceptSecurityRisk(f.project,report,'prototype','origin','Do not substitute a weaker product consequence at the write boundary.'),/policy/);
},'sensitive'));
