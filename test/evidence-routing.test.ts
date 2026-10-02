import test from 'node:test';import assert from 'node:assert/strict';
import {routeBlueprint,caseKind,parseEvidenceKind} from '../src/acceptance/evidence-kind.ts';
import {parseChecks} from '../src/acceptance/checks.ts';
import {parseBlueprint,draftInParts,type Preparation} from '../src/acceptance/preparation.ts';
const task={id:'ui',title:'UI',priority:'must' as const,status:'todo' as const,dependsOn:[],criteria:['Live title counts.']};
const journey={version:1,title:'Title counts',entry:'src/server.js',port:4173,timeoutSeconds:30,steps:[{action:'goto',path:'/#share'},{action:'fill',selector:'#title',value:'hello'},{action:'text',selector:'#count',expected:'5'}]};
const legacy={version:1 as const,contract:'GET / serves the app.',coverage:[{criterion:1,cases:['counts'],limitation:'All cases require separately recorded real-browser evidence and cannot be satisfied by HTTP checks.'}],cases:[{id:'counts',description:'Observe the live title count.'}]};
const http={id:'counts',description:legacy.cases[0]!.description,tasks:['ui'],steps:[{command:['node','-e','console.log("HTTP only")'],exitCode:0,stdout:'HTTP only\n'}]};
test('legacy browser evidence migrates explicitly; command-only files remain compatible and unknown evidence fails',()=>{
 const b=routeBlueprint(legacy);assert.equal(caseKind(b.cases[0]! as {kind?:'browser'}), 'browser');assert.equal(caseKind({}), 'command');assert.throws(()=>parseEvidenceKind('magic'),/evidence/i);
 assert.throws(()=>parseChecks({version:1,cases:[{...http,kind:'browser'}]}),/browser/i);
 assert.throws(()=>parseChecks({version:1,cases:[{...http,kind:'command',browser:journey}]}),/browser|mixed/i);
 assert.equal(parseChecks({version:1,cases:[{...http,kind:'browser',steps:[],browser:journey}]}).cases[0]!.steps.length,0);
});
test('browser preparation retires a legacy HTTP substitute and invalidates reviews before routing a typed journey',async()=>{
 let saved:Preparation|undefined,generated=0,reviewed=0;
 const b=parseBlueprint(legacy,task);
 const result=await draftInParts(task,{plan:async()=>{throw Error('must not replan');},generate:async(_,outline)=>{generated++;assert.equal(outline.cases[0]!.kind,'browser');return {...http,kind:'browser',steps:[],browser:journey};},save:async s=>{saved=structuredClone(s);},reviewOutline:async()=>{reviewed++;return {verdict:'pass',issues:[],limitations:[]};}}, {version:1,blueprint:b,cases:[http],outlineReview:{digest:'old',review:{verdict:'pass',issues:[],limitations:[]}}});
 assert.equal(generated,1);assert.equal(reviewed,1);assert.equal(result.manifest.cases[0]!.kind,'browser');assert.ok(saved!.retiredCases!.some(c=>JSON.stringify(c.raw).includes('HTTP only')));
});
test('browser format repair cannot substitute HTTP evidence; manual cases never dispatch to a model generator',async()=>{
 const b={...legacy,cases:[{...legacy.cases[0]!,kind:'browser' as const}]};let calls=0;
 await assert.rejects(draftInParts(task,{plan:async()=>b,generate:async()=>{calls++;return http;},save:async()=>{}}),/could not prepare/i);assert.equal(calls,1);
 const m={...legacy,cases:[{...legacy.cases[0]!,kind:'manual' as const}]};
 const p=await draftInParts(task,{plan:async()=>m,generate:async()=>{throw Error('Manual cannot generate commands');},save:async()=>{}});
 assert.equal(p.manifest.cases[0]!.kind,'manual');assert.deepEqual(p.manifest.cases[0]!.steps,[]);
});

test('unsupported browser capability stops without format repairs or HTTP substitutions',async()=>{
 let repairs=0;let state:Preparation|undefined;
 await assert.rejects(draftInParts(task,{plan:async()=>({...legacy,cases:[{...legacy.cases[0]!,kind:'browser'}]}),generate:async()=>({blocker:'Independent browser contexts are unavailable.'}),repairCase:async()=>{repairs++;return http;},save:async s=>{state=structuredClone(s);}}),/capability requires manual/);
 assert.equal(repairs,0);assert.equal(state!.pendingCase!.repairs,0);assert.ok(JSON.stringify(state!.pendingCase!.raw).includes('contexts'));
});
