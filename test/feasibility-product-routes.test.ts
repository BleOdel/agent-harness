import test from 'node:test';
import assert from 'node:assert/strict';
import {routeIssues,discoverEvidence} from '../src/acceptance/feasibility.ts';
import {defaultProfile} from '../src/project/profile.ts';
import {inspectProductTargets} from '../src/acceptance/feasibility-targets.ts';
const digest='a'.repeat(64),runtime='b'.repeat(64);
const target={provider:'linux-electron' as const,approval:'journey-00000000-0000-4000-8000-000000000000',approvalDigest:digest,runtime};
const input={profile:defaultProfile(),dependencies:false,kinds:[],sensitive:false};
const product=(kind:'desktop'|'ml',targets:any[]=[])=>({kind,digest,targets});
test('desktop and ML routes cannot disappear behind ordinary Node capability checks',async()=>{
 const desktop=routeIssues({...input,product:product('desktop')});assert.ok(desktop.some(g=>g.kind==='missing-interface'&&g.stage==='product/ui'));
 assert.equal(routeIssues({...input,product:product('desktop',[target])}).length,0);
 const ml=routeIssues({...input,product:product('ml',[{...target,provider:'torch-cpu'}])});assert.ok(ml.some(g=>g.kind==='unsupported-capability'&&g.stage==='product/integration'));
 for(const provider of ['android','ios','windows','cuda','general-llm-training'])assert.ok(routeIssues({...input,product:product('desktop',[{...target,provider}])}).some(g=>g.kind==='unsupported-capability'));
 let requests=0;await assert.rejects(discoverEvidence({id:'app',title:'app',priority:'must',status:'todo',dependsOn:[],criteria:['UI']},{version:1,contract:'UI',coverage:[{criterion:1,cases:['ui']}],cases:[{id:'ui',kind:'manual',description:'UI'}]},{...input,product:product('desktop')},{request:async()=>{requests++;},save:async()=>{}}),/feasibility/);assert.equal(requests,0);
});
test('required delivery stages are checked and unknown stages fail closed',()=>{
 assert.equal(routeIssues({...input,requiredStages:['package','release']}).length,0);
 assert.ok(routeIssues({...input,profile:defaultProfile('python-pip'),requiredStages:['preview']}).some(g=>g.stage==='preview'));
 assert.ok(routeIssues({...input,requiredStages:['teleport' as any]}).some(g=>g.kind==='unsupported-capability'));
});
test('selected desktop approval and runtime are independently checked without running the application',async()=>{
 const selected={...input,product:product('desktop',[target])};let calls=0;
 const services={choices:async()=>[target],runtime:async()=>{calls++;return runtime;}};
 assert.deepEqual(await inspectProductTargets('/fixture',selected,services),[]);assert.equal(calls,1);
 const stale=await inspectProductTargets('/fixture',selected,{...services,choices:async()=>[{...target,approvalDigest:'c'.repeat(64)}]});assert.equal(stale.length,1);assert.equal(stale[0]!.kind,'unqualified-runtime');assert.equal(calls,1);
 const changed=await inspectProductTargets('/fixture',selected,{...services,runtime:async()=>digest});assert.equal(changed[0]!.kind,'unqualified-runtime');
 const absent=await inspectProductTargets('/fixture',selected,{...services,runtime:async()=>{throw Object.assign(Error('runtime file absent'),{code:'ENOENT'});}});assert.equal(absent[0]!.kind,'missing-installation');
});
test('target inspection collects every selected platform problem rather than failing at the first one',async()=>{
 const second={...target,provider:'macos-native' as const,approval:'apple-check-00000000-0000-4000-8000-000000000000'};
 const gaps=await inspectProductTargets('/fixture',{...input,product:product('desktop',[target,second])},{choices:async()=>[target,second],runtime:async t=>{throw Error('Runtime no longer qualified: '+t.provider);}});assert.equal(gaps.length,2);assert.ok(gaps.every(g=>g.kind==='unqualified-runtime'));
});
import {readFile} from 'node:fs/promises';
import type {EvidenceCheckpoint} from '../src/acceptance/feasibility.ts';
test('retained author outline reports content-note and expanded-field obligations together and preserves all evidence kinds',async()=>{
 const fixture=JSON.parse(await readFile(new URL('./fixtures/author-evidence-outline.json',import.meta.url),'utf8'));
 const b=fixture.blueprint;let saved:EvidenceCheckpoint|undefined,calls=0;
 await assert.rejects(discoverEvidence(fixture.task,b,{...input,kinds:['browser','manual']},{request:async n=>{
  calls++;return {version:1,criterion:n,observations:b.coverage.find((c:any)=>c.criterion===n).cases.map((id:string)=>{
   const c=b.cases.find((c:any)=>c.id===id),manual=c.kind==='manual';
   // The deterministic oracle isolates known missing choices; it does not claim
   // semantic completeness for other author interactions or execute the app.
   const anchors=id==='criterion-1-browser-notes-fields'?[{name:'category selector',quote:null},{name:'explanation control',quote:null},{name:'empty Other error',quote:null},{name:'expanded compose inspection',quote:null},{name:'expanded preview inspection',quote:null}]:manual?[]:[{name:'independent case-specific interface discovery still required',quote:null}];
   return {caseId:id,observation:c.description.slice(0,500),anchors,capabilities:[manual?'human.observe':'browser.count']};
  })};
 },save:async s=>{saved=structuredClone(s);}}),(error:any)=>{assert.match(error.remedy,/category selector[\s\S]*explanation control[\s\S]*empty Other error[\s\S]*expanded compose inspection[\s\S]*expanded preview inspection/);return true;});
 assert.equal(calls,fixture.task.criteria.length);assert.equal(saved!.criteria.length,fixture.task.criteria.length);
 for(const c of b.cases)assert.ok(saved!.obligations.some(o=>o.caseId===c.id&&o.kind===c.kind));
 await assert.rejects(discoverEvidence(fixture.task,b,{...input,kinds:['browser','manual']},{request:async()=>{throw Error('Completed discoveries must be retained');},save:async()=>{}},saved),/feasibility/);
});
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {sha256} from '../src/artifacts/store.ts';
import {selectedDesktopImage} from '../src/acceptance/feasibility-targets.ts';
test('Linux preflight resolves the approved immutable image rather than the global default',async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'selected-desktop-'))),project=root+'/app';await mkdir(project);await mkdir(project+'-harness/desktop/approvals',{recursive:true});
 try{const image='sha256:'+'c'.repeat(64),body={version:1,id:target.approval,runtime:{image}},approval={...body,digest:sha256(JSON.stringify(body))},t={...target,approvalDigest:approval.digest,runtime:sha256(JSON.stringify(body.runtime))};
  await writeFile(project+'-harness/desktop/approvals/'+t.approval+'.json',JSON.stringify(approval));
  assert.equal(await selectedDesktopImage(project,t),image);
  await assert.rejects(selectedDesktopImage(project,{...t,approvalDigest:digest}),/changed/);
  await assert.rejects(selectedDesktopImage(project,{...t,approval:'../other'}),/selection/);
 }finally{await rm(root,{recursive:true,force:true});}
});
import {projectRoute} from '../src/acceptance/feasibility-project.ts';
test('an unsupported npm workspace is rejected during planning route inspection',async()=>{
 const project=await realpath(await mkdtemp(path.join(os.tmpdir(),'workspace-route-')));
 try{await writeFile(project+'/package.json',JSON.stringify({name:'workspace',workspaces:['packages/*']}));await assert.rejects(projectRoute(project),/workspaces/);}finally{await rm(project,{recursive:true,force:true});}
});
