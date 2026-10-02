import {createHash} from 'node:crypto';
import {proposalDigest} from '../src/acceptance/repair.ts';
import test from 'node:test';import assert from 'node:assert/strict';
import {parseRoutedCase,IncompleteBrowserBlocker,EvidenceCapabilityGap,browserCapabilityDigest,browserDesignPrompt,browserBlockerPrompt} from '../src/acceptance/browser-design.ts';
import {draftInParts,parseBlueprint,outlineFingerprint,initializePreparation,blueprintProposal,type Preparation} from '../src/acceptance/preparation.ts';
import {CheckRequestInterrupted} from '../src/acceptance/request-failure.ts';
import {withCheckBudget,type CheckSpend} from '../src/acceptance/budget.ts';
const task={id:'ui',title:'UI',priority:'must' as const,status:'todo' as const,dependsOn:[],criteria:['Observe live title counts on typing, pasting and deleting.']};
const selected={id:'counts',kind:'browser' as const,description:task.criteria[0]!};
const b=parseBlueprint({version:1,contract:'Use Title and Story accessible labels.',cases:[selected],coverage:[{criterion:1,cases:['counts']}]},task);
const pass={verdict:'pass' as const,issues:[],limitations:[]};
const journey={...selected,tasks:['ui'],steps:[],browser:{version:1,title:'Counts',entry:'server.js',port:4173,timeoutSeconds:30,steps:[{action:'goto',path:'/'},{action:'fill',selector:'#title',value:'Hi'},{action:'text',selector:'#count',expected:'2'}]}};
const blocker={blocker:'contract-choice',observation:'Observe live title counts',reason:'The contract has no agreed counter format or counter label; exact text checks would invent a required presentation.',requiredResolution:'Define a semantic counter anchor and expected observable representation in the unapproved interface.'};
const saved=():Preparation=>({version:1,blueprint:b,cases:[],outlineReview:{digest:outlineFingerprint(task,b),review:pass},pendingCase:{id:selected.id,raw:{blocker:'capability needed'},repairs:0}});
test('generic, mixed and ungrounded blockers are incomplete diagnoses, not manual evidence',()=>{
 for(const raw of [{blocker:'capability needed'},{blocker:'Some capability is missing'},{...blocker,steps:[]},{...blocker,observation:'Other requirement'},{...blocker,requiredResolution:''}])assert.throws(()=>parseRoutedCase(raw,task.id,selected),IncompleteBrowserBlocker);
 assert.throws(()=>parseRoutedCase(blocker,task.id,selected),(e:unknown)=>e instanceof EvidenceCapabilityGap&&/contract-choice/.test(e.message)&&/counter format/.test(e.message)&&!!e.remedy?.includes('Define a semantic counter')&&!e.remedy.includes('revise this behaviour as manual'));
});
test('real typing changes the capability fingerprint and is included in design instructions',()=>{
 assert.notEqual(browserCapabilityDigest(),'564661ba21ae989ace46811848a46d861666d14af414438216dfc4776a277ff6');
 assert.match(browserDesignPrompt(),/type \{selector,value\} sends 1\.\.256 printable ASCII/);
 assert.doesNotMatch(browserDesignPrompt(),/return \{blocker:"capability needed"\}/);
 const prompt=browserBlockerPrompt(task.id,b.contract,selected,{blocker:'capability needed'},'Missing diagnosis');
 assert.match(prompt,/requiredResolution/);assert.match(prompt,/without changing/);assert.match(prompt,/exact quotation/);assert.match(prompt,/supported actions/);
});
test('saved placeholder is clarified once without regenerating or re-reviewing the outline',async()=>{
 let state:Preparation=saved(),calls=0;
 const p=await draftInParts(task,{plan:async()=>{throw Error('no replanning');},generate:async()=>{throw Error('no regeneration');},reviewOutline:async()=>{throw Error('reuse review');},clarifyBlocker:async()=>{calls++;return journey;},save:async s=>{state=structuredClone(s);}},state);
 assert.equal(calls,1);assert.equal(p.manifest.cases[0]!.kind,'browser');assert.equal(state.pendingCase,undefined);assert.deepEqual(state.retiredCases![0]!.raw,{blocker:'capability needed'});
});
test('specific diagnostic is retained and displayed without retrying, changing kind or substituting HTTP',async()=>{
 let state:Preparation=saved(),calls=0;
 const services={plan:async()=>b,generate:async()=>{throw Error('no generation');},clarifyBlocker:async()=>{calls++;return blocker;},repairCase:async()=>{throw Error('no format repair');},save:async(s:Preparation)=>{state=structuredClone(s);}};
 await assert.rejects(draftInParts(task,services,state),EvidenceCapabilityGap);assert.equal(calls,1);assert.deepEqual(state.pendingCase!.raw,blocker);assert.equal(state.blueprint.cases[0]!.kind,'browser');assert.equal(state.cases.length,0);
 await assert.rejects(draftInParts(task,services,state),EvidenceCapabilityGap);assert.equal(calls,1);
});
test('clarification timeout and exhausted allowance keep the original response and reusable clarification',async()=>{
 let state:Preparation=saved(),calls=0;
 const services={plan:async()=>b,generate:async()=>journey,clarifyBlocker:async()=>{calls++;throw new CheckRequestInterrupted('timeout','provider timeout');},save:async(s:Preparation)=>{state=structuredClone(s);}};
 const spend:CheckSpend={requests:1};
 await assert.rejects(withCheckBudget({maxRequests:1,maxSeconds:60,requestSeconds:30},spend,async()=>{},()=>{},()=>draftInParts(task,services,state)),/limit/i);assert.equal(calls,0);
 await assert.rejects(draftInParts(task,services,state),/provider timeout/);assert.equal(state.pendingCase!.blockerClarifications,0);assert.equal(state.pendingCase!.repairs,0);assert.deepEqual(state.pendingCase!.raw,{blocker:'capability needed'});
});
test('a second vague reply stops and cannot spend another clarification on resume',async()=>{
 let state:Preparation=saved(),calls=0;
 const services={plan:async()=>b,generate:async()=>journey,clarifyBlocker:async()=>{calls++;return {blocker:'still unclear'};},repairCase:async()=>{throw Error('must not retry via generic repair');},save:async(s:Preparation)=>{state=structuredClone(s);}};
 await assert.rejects(draftInParts(task,services,state),/usable browser diagnosis/);assert.equal(calls,1);assert.equal(state.pendingCase!.blockerClarifications,1);
 await assert.rejects(draftInParts(task,services,state),/usable browser diagnosis/);assert.equal(calls,1);assert.equal(state.cases.length,0);
});

const oldCapabilities='564661ba21ae989ace46811848a46d861666d14af414438216dfc4776a277ff6';
const missingAction={...blocker,blocker:'missing-action',reason:'Typing printable characters is not available in the supported action set.',requiredResolution:'Add a real keyboard typing action that produces character keyboard events.'};
function oldState():Preparation{return {...saved(),outlineReview:{digest:createHash('sha256').update(proposalDigest(blueprintProposal(task,b))+oldCapabilities).digest('hex'),review:pass},pendingCase:{id:selected.id,raw:missingAction,repairs:1}};}
test('known legacy capability blocker is archived once; a new independent outline review precedes regeneration',async()=>{
 let state=oldState();const calls:string[]=[];
 await draftInParts(task,{plan:async()=>{throw Error('no replanning');},reviewOutline:async()=>{calls.push('review');return pass;},generate:async()=>{calls.push('generate');return journey;},save:async s=>{state=structuredClone(s);}},state);
 assert.deepEqual(calls,['review','generate']);assert.deepEqual(state.retiredCases![0]!.raw,missingAction);assert.equal(state.retiredCases![0]!.repairs,1);
 assert.equal(state.browserCapabilities,browserCapabilityDigest());assert.equal(state.cases.length,1);
});
test('capability migration preserves contract blockers, unknown legacy states and current-version failures',()=>{
 const unknown=oldState();unknown.outlineReview!.digest='f'.repeat(64);
 assert.deepEqual(initializePreparation(task,b,unknown).pendingCase,unknown.pendingCase);
 const contract=oldState();contract.pendingCase!.raw=blocker;
 assert.deepEqual(initializePreparation(task,b,contract).pendingCase,contract.pendingCase);
 const current={...oldState(),browserCapabilities:browserCapabilityDigest()};
 assert.deepEqual(initializePreparation(task,b,current).pendingCase,current.pendingCase);
 const migrated=initializePreparation(task,b,oldState());assert.equal(migrated.pendingCase,undefined);assert.equal(migrated.outlineReview,undefined);
 assert.equal(initializePreparation(task,b,migrated).retiredCases!.length,1);
 const stamped={...oldState(),browserCapabilities:oldCapabilities};delete stamped.outlineReview;
 assert.equal(initializePreparation(task,b,stamped).pendingCase,undefined);
 assert.throws(()=>initializePreparation(task,b,{...stamped,browserCapabilities:'invalid'}),/capability/);
});
