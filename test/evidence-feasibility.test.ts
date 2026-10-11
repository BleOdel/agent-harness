import test from 'node:test';import assert from 'node:assert/strict';
import {routeIssues,atomicObligations,discoverEvidence,type EvidenceCheckpoint} from '../src/acceptance/feasibility.ts';
import {defaultProfile} from '../src/project/profile.ts';
const task={id:'author',title:'Author',priority:'must' as const,status:'todo' as const,dependsOn:[],criteria:['Content notes have categories and an explanation for Other.','Neither compose nor preview offers author name or upload controls.']};
const blueprint={version:1 as const,contract:'Native select #note is labelled Content note. The compose form is #compose and preview is #preview.',coverage:[{criterion:1,cases:['notes']},{criterion:2,cases:['fields']}],cases:[{id:'notes',description:task.criteria[0]!,kind:'browser' as const},{id:'fields',description:task.criteria[1]!,kind:'browser' as const}]};
const atom=(caseId:string,observation:string,anchors:any[],capabilities=['browser.count'])=>({caseId,observation,anchors,capabilities});
const anchor=(name:string,quote:string|null)=>({name,quote});
test('known unsupported route combinations stop before any semantic request and retain distinct gap categories',async()=>{
 for(const profile of [{...defaultProfile(),requirements:{...defaultProfile().requirements,gpu:true}},defaultProfile('python-pip')]){
  let requests=0;const issues=routeIssues({profile,dependencies:false,kinds:['browser'],sensitive:false});assert.ok(issues.some(i=>i.kind==='unsupported-capability'));
  await assert.rejects(discoverEvidence(task,blueprint,{profile,dependencies:false,kinds:['browser'],sensitive:false},{request:async()=>{requests++;},save:async()=>{}}),/feasibility/i);assert.equal(requests,0);
 }
 assert.ok(routeIssues({profile:defaultProfile(),dependencies:true,kinds:['browser'],sensitive:false}).some(i=>i.stage==='preview'));
 assert.ok(routeIssues({profile:defaultProfile(),dependencies:false,kinds:['command'],sensitive:true}).some(i=>i.stage==='securityPerformance'));
 assert.equal(routeIssues({profile:defaultProfile(),dependencies:false,kinds:['command'],sensitive:false}).length,0);
});
test('author semantic discovery collects missing controls, error anchors and forbidden-field scopes together before generation',async()=>{
 let saved:EvidenceCheckpoint|undefined,requests=0;
 const input={profile:defaultProfile(),dependencies:false,kinds:['browser' as const],sensitive:false};
 await assert.rejects(discoverEvidence(task,blueprint,input,{request:async n=>{requests++;return {version:1,criterion:n,observations:n===1?[atom('notes','Other requires nonempty explanatory text',[anchor('category','Native select #note'),anchor('explanation',null),anchor('validation error',null)],['browser.select','browser.fill','browser.text'])]:[atom('fields','Expanded compose and preview contain no author-name or upload control',[anchor('compose','#compose'),anchor('preview','#preview'),anchor('expanded-controls scope',null)])]};},save:async state=>{saved=structuredClone(state);}}),(error:any)=>{assert.match(error.remedy,/explanation[\s\S]*validation error[\s\S]*expanded-controls scope/);return true;});
 assert.equal(requests,2);assert.equal(saved!.criteria.length,2);assert.equal(saved!.obligations.length,2);assert.equal(saved!.issues.length,3);
 await assert.rejects(discoverEvidence(task,blueprint,input,{request:async()=>{throw Error('Do not regenerate');},save:async()=>{}},saved),/feasibility/i);
});
test('atomic evidence IDs are stable and unknown anchors/capabilities cannot masquerade as executable proof',()=>{
 const raw={version:1,criterion:1,observations:[atom('notes','Choose a category',[anchor('category','Native select #note')],['browser.select'])]};
 const first=atomicObligations(task,blueprint,1,raw);assert.deepEqual(first,atomicObligations(task,blueprint,1,raw));assert.match(first[0]!.id,/^ob-/);
 assert.throws(()=>atomicObligations(task,blueprint,1,{...raw,observations:[atom('fields','wrong scope',[])]}),/case/);
 const bad=atomicObligations(task,blueprint,1,{...raw,observations:[atom('notes','Unsupported gesture',[anchor('invented','#missing')],['browser.drag-and-drop'])]});assert.ok(bad[0]!.gaps.some(g=>g.kind==='missing-interface'));assert.ok(bad[0]!.gaps.some(g=>g.kind==='unsupported-capability'));
});
test('provider interruption resumes only the missing criterion and manual observations remain unresolved',async()=>{
 const b={...blueprint,cases:[blueprint.cases[0]!,{...blueprint.cases[1]!,kind:'manual' as const}]};let saved:EvidenceCheckpoint|undefined,calls:number[]=[];
 const input={profile:defaultProfile(),dependencies:false,kinds:['browser' as const,'manual' as const],sensitive:false};const answer=(n:number)=>({version:1,criterion:n,observations:[atom(n===1?'notes':'fields',n===1?'Select category':'Human assesses clarity',n===1?[anchor('category','Native select #note')]:[],n===1?['browser.select']:['human.observe'])]});
 await assert.rejects(discoverEvidence(task,b,input,{request:async n=>{calls.push(n);if(n===2)throw Error('provider timeout');return answer(n);},save:async s=>{saved=structuredClone(s);}}),/provider timeout/);
 const done=await discoverEvidence(task,b,input,{request:async n=>{calls.push(n);return answer(n);},save:async()=>{}},saved);assert.deepEqual(calls,[1,2,2]);assert.equal(done.obligations[1]!.kind,'manual');assert.equal(done.unresolved.length,1);assert.equal(done.status,'design-ready');assert.equal(done.applicationVerified,false);
});
import {draftInParts,outlineFingerprint} from '../src/acceptance/preparation.ts';
test('new generation and a retained passing outline both stop at the feasibility gate',async()=>{
 for(const cached of [false,true]){let generated=0,reviewed=0,gate=0;const saved=cached?{version:1 as const,blueprint,cases:[],outlineReview:{digest:outlineFingerprint(task,blueprint),review:{verdict:'pass' as const,issues:[],limitations:[]}}}:undefined;
 await assert.rejects(draftInParts(task,{plan:async()=>blueprint,generate:async()=>{generated++;},reviewOutline:async()=>{reviewed++;return {verdict:'pass',issues:[],limitations:[]};},feasibility:async()=>{gate++;throw Error('all missing anchors need resolution');},save:async()=>{}},saved),/missing anchors/);assert.equal(gate,1);assert.equal(generated,0);assert.equal(reviewed,0);}
});
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {prepareEvidence} from '../src/acceptance/feasibility-project.ts';
test('missing installations and unqualified runtimes are retained without spending semantic requests',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'evidence-runtime-')),project=root+'/project';await mkdir(project);await writeFile(project+'/package.json','{"type":"module"}');
 try{let calls=0;for(const kind of ['missing-installation','unqualified-runtime'] as const){await assert.rejects(prepareEvidence(project,task,blueprint,()=>{},{runtime:async()=>[{kind,stage:'ui',detail:'fixture runtime unavailable'}],request:async()=>{calls++;}}),/not ready/);const saved=JSON.parse(await readFile(project+'-harness/acceptance/evidence-runtime.json','utf8'));assert.equal(saved.issues[0].kind,kind);}assert.equal(calls,0);}finally{await rm(root,{recursive:true,force:true});}
});
test('a criterion without automated coverage stays a named unresolved obligation',async()=>{
 const b={...blueprint,coverage:[blueprint.coverage[0]!,{criterion:2,cases:[],limitation:'Human source review still required.'}]};
 const result=await discoverEvidence(task,b,{profile:defaultProfile(),dependencies:false,kinds:['browser'],sensitive:false},{request:async()=>({version:1,criterion:1,observations:[atom('notes','Choose a category',[anchor('category','Native select #note')],['browser.select'])]}),save:async()=>{}});
 assert.equal(result.unresolved.length,1);assert.equal(result.unresolved[0]!.criterion,2);assert.equal(result.unresolved[0]!.kind,'manual');assert.equal(result.applicationVerified,false);
});
test('changed atomic evidence invalidates interface review, while unchanged discovery reuses it',async()=>{
 let saved:any,reviewed=0,generated=0,digest='a'.repeat(64);
 const services={plan:async()=>blueprint,feasibility:async()=>({digest}),reviewOutline:async()=>{reviewed++;return {verdict:'pass' as const,issues:[],limitations:[]};},generate:async(id:string)=>{generated++;return {id,tasks:[task.id],kind:'browser',description:blueprint.cases.find(c=>c.id===id)!.description,steps:[],browser:{version:1,title:'Observation',entry:'server.js',port:4173,timeoutSeconds:20,steps:[{action:'text',selector:'#note',expected:'Content note'}]}};},save:async(s:any)=>{saved=structuredClone(s);}};
 await draftInParts(task,services);assert.equal(reviewed,1);assert.equal(generated,2);
 await draftInParts(task,services,saved);assert.equal(reviewed,1);assert.equal(generated,2);
 digest='b'.repeat(64);await draftInParts(task,services,saved);assert.equal(reviewed,2);assert.equal(generated,2);
});
test('one bounded schema correction retains the malformed reply and does not consume repeated usable attempts',async()=>{
 const one={...task,criteria:[task.criteria[0]!]},b={...blueprint,cases:[blueprint.cases[0]!],coverage:[blueprint.coverage[0]!]};let calls=0,saved:EvidenceCheckpoint|undefined;
 const result=await discoverEvidence(one,b,{profile:defaultProfile(),dependencies:false,kinds:['browser'],sensitive:false},{request:async()=>{calls++;return calls===1?{version:1,criterion:1,observations:[]}:{version:1,criterion:1,observations:[atom('notes','Choose a category',[anchor('category','Native select #note')],['browser.select'])]};},save:async s=>{saved=structuredClone(s);}});
 assert.equal(calls,2);assert.equal(result.obligations.length,1);assert.equal((saved!.criteria[0] as any).previousReplies.length,1);
 await discoverEvidence(one,b,{profile:defaultProfile(),dependencies:false,kinds:['browser'],sensitive:false},{request:async()=>{throw Error('Do not reissue');},save:async()=>{}},saved);
});
