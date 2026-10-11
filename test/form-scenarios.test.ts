import test from 'node:test';import assert from 'node:assert/strict';
import {compileFormScenario} from '../src/acceptance/form-scenarios.ts';
import {actionRequest,parseJourney,assessJourney} from '../src/browser/schema.ts';
import {observationFixture} from './fixtures/browser-observations.ts';
const launch={title:'Form',entry:'server.js',port:4173,timeoutSeconds:90};
const base={version:1,launch,path:'/',setup:[]};
test('form templates compile bounded typing, paste, deletion and valid/invalid boundaries',()=>{
 const j=compileFormScenario({...base,kind:'text-limits',field:'#title',counter:'#count',prefix:'',suffix:' characters',minimum:5,maximum:100,overflow:'reject',advance:'#preview',invalid:{selector:'#error',text:'Invalid title'},valid:{selector:'#preview-title',text:'Preview'},requestPath:'/save'});
 assert.ok(j.steps.some(s=>s.action==='type'));assert.ok(j.steps.some(s=>s.action==='paste'));assert.ok(j.steps.some(s=>s.action==='press'&&s.key==='Backspace'));assert.ok(j.steps.some(s=>s.action==='paste'&&'valueRepeat' in s&&s.valueRepeat?.count===101));
 assert.ok(j.steps.some(s=>s.action==='text'&&s.expected==='2 characters'));assert.ok(j.steps.some(s=>s.action==='requestCount'&&s.expected===0&&s.observation?.mode==='during'));assert.ok(j.steps.length<=60);
 assert.throws(()=>compileFormScenario({...base,kind:'text-limits',field:'#a'}),/scenario/);
});
test('retention expectations remain on the host and compare exact field values after a failure',()=>{
 const j=compileFormScenario({...base,kind:'failure-retention',fields:[{selector:'#story',value:'Private draft'}],submit:'#send',requestPath:'/save',mode:'503',error:{selector:'#error',text:'Unavailable'}});
 assert.ok(j.steps.some(s=>s.action==='value'&&s.expectedFrom==='retained-0'));
 assert.doesNotMatch(JSON.stringify(actionRequest(j)),/expectedFrom|Unavailable/);
 const small=parseJourney({...launch,version:1,steps:[{action:'capture',selector:'#story',source:'value',name:'before'},{action:'value',selector:'#story',expectedFrom:'before'}]});
 for(const [value,passed] of [['Private draft',true],['',false],['Changed draft',false]] as const){const report=observationFixture(small,{version:1,errors:[],steps:[{action:'capture',values:['Private draft']},{action:'value',values:[value]}]});assert.equal(assessJourney(small,report).passed,passed);}
});
test('unknown scenarios and executable payloads cannot enter templates',()=>{
 for(const kind of ['execute','http','manual'])assert.throws(()=>compileFormScenario({...base,kind}),/scenario/);
 assert.throws(()=>compileFormScenario({...base,kind:'acknowledgement',script:'fetch(secret)'}),/scenario/);
});
import {parseRoutedCase} from '../src/acceptance/browser-design.ts';
test('generated scenario mappings use the compiler and cannot smuggle a second execution path',()=>{
 const selected={id:'retain',description:'Retain prose after failed submission',kind:'browser' as const};
 const raw={...selected,tasks:['form'],steps:[],scenario:{...base,kind:'failure-retention',fields:[{selector:'#story',value:'Draft'}],submit:'#send',requestPath:'/save',mode:'abort',error:{selector:'#error',text:'Unavailable'}}};
 const parsed=parseRoutedCase(raw,'form',selected);assert.equal(parsed.browser!.steps.some(s=>s.action==='value'),true);assert.equal('scenario' in parsed,false);
 assert.throws(()=>parseRoutedCase({...raw,browser:{steps:[]}},'form',selected),/other execution/);
 assert.throws(()=>parseRoutedCase({...raw,steps:[{command:['echo','pass']}]},'form',selected),/other execution/);
});
