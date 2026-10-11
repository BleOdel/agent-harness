import test from 'node:test';import assert from 'node:assert/strict';
import {parseJourney,actionRequest,assessJourney} from '../src/browser/schema.ts';
const base={version:1,title:'Timing',entry:'server.js',port:4173,timeoutSeconds:20};
const positive={action:'text',selector:'#state',expected:'Complete',observation:{mode:'eventually',milliseconds:1000}};
const timed=(samples:any[],mode='eventually',milliseconds=1000)=>({action:samples[0].observation.action,timing:{mode,milliseconds,samples}});
const sample=(at:number,observation:unknown)=>({at,observation});
test('positive timing remains bounded and expected values never enter driver actions',()=>{
 const j=parseJourney({...base,steps:[positive]});const request=actionRequest(j);assert.doesNotMatch(JSON.stringify(request),/Complete|expected/);assert.deepEqual(request.steps[0]!.observation,positive.observation);
 for(const milliseconds of [0,-1,10001,Infinity])assert.throws(()=>parseJourney({...base,steps:[{...positive,observation:{mode:'eventually',milliseconds}}]}));
 for(const step of [{action:'count',selector:'.private',expected:0},{action:'requestCount',path:'/forbidden',method:'POST',expected:0}])assert.throws(()=>parseJourney({...base,steps:[step]}),/window|during/);
});
test('host compares positive samples and reports last value and elapsed time on timeout',()=>{
 const j=parseJourney({...base,steps:[positive]});const observe=(at:number,value:string)=>sample(at,{action:'text',values:[value]});
 assert.equal(assessJourney(j,{version:2,errors:[],steps:[timed([observe(0,'Idle'),observe(750,'Complete')])]}).passed,true);
 const failed=assessJourney(j,{version:2,errors:[],steps:[timed([observe(0,'Idle'),observe(1000,'Idle')])]});assert.equal(failed.passed,false);assert.match(failed.failures.join(' '),/1000.*Idle/);
 assert.throws(()=>assessJourney(j,{version:1,errors:[],steps:[{action:'text',values:['Complete']}]}),/observations|version/);
});
test('negative request evidence needs the complete approved window and observes late forbidden events',()=>{
 const j=parseJourney({...base,steps:[{action:'requestCount',method:'POST',path:'/forbidden',expected:0,observation:{mode:'during',milliseconds:1000}}]});
 const observe=(at:number,value:number)=>sample(at,{action:'requestCount',value});
 const assess=(samples:any[])=>assessJourney(j,{version:2,errors:[],steps:[timed(samples,'during')]});
 assert.equal(assess([observe(0,0),observe(1000,0)]).passed,true);
 assert.equal(assess([observe(0,0),observe(400,1),observe(1000,1)]).passed,false);
 assert.equal(assess([observe(0,0),observe(999,0)]).passed,false);
 assert.throws(()=>assess([observe(100,0),observe(90,0)]),/timestamp|order/);
});
import {BrowserObservationBroker} from '../src/browser/observation-broker.ts';
test('host broker waits, retains timestamps, and only releases the next action after host comparison',()=>{
 let clock=0;const b=new BrowserObservationBroker(parseJourney({...base,steps:[positive]}),()=>clock);
 const frame=(sequence:number,at:number,value:string)=>({version:1,sequence,step:0,at,observation:{action:'text',values:[value]}});
 assert.equal(b.consume(frame(1,0,'Idle'))!.decision,'retry');clock=750;
 assert.equal(b.consume(frame(2,750,'Complete'))!.decision,'next');
 const report=b.finish({version:2,errors:[],steps:[{action:'text',values:['Complete']}]});assert.equal(assessJourney(parseJourney({...base,steps:[positive]}),report).passed,true);
 assert.throws(()=>b.consume(frame(4,800,'Complete')),/sequence|order/);
 assert.throws(()=>b.finish({version:2,errors:[],steps:[{action:'text',values:['fabricated']}]}),/differ/);
});
test('host broker requires wall time and complete negative window; early shutdown is incomplete',()=>{
 let clock=0;const spec=parseJourney({...base,steps:[{action:'requestCount',path:'/forbidden',method:'POST',expected:0,observation:{mode:'during',milliseconds:1000}}]});const b=new BrowserObservationBroker(spec,()=>clock);
 const frame=(sequence:number,at:number,value:number)=>({version:1,sequence,step:0,at,observation:{action:'requestCount',value}});
 assert.equal(b.consume(frame(1,0,0))!.decision,'retry');assert.equal(b.consume(frame(2,1000,0))!.decision,'retry');
 assert.throws(()=>b.finish({version:2,errors:[],steps:[]}),/incomplete/i);
 clock=1000;assert.equal(b.consume(frame(3,1100,1))!.decision,'next');assert.equal(assessJourney(spec,b.finish({version:2,errors:[],steps:[{action:'requestCount',value:1}]})).passed,false);
});

test('a during interval cannot erase an observed transient violation or a renderer error',()=>{
 const j=parseJourney({...base,steps:[{action:'count',selector:'.private',expected:0,observation:{mode:'during',milliseconds:1000}}]});
 const steps=[timed([sample(0,{action:'count',value:0}),sample(400,{action:'count',value:1}),sample(1000,{action:'count',value:0})],'during')];
 assert.equal(assessJourney(j,{version:2,steps,errors:[]}).passed,false);
 const p=parseJourney({...base,steps:[positive]});assert.equal(assessJourney(p,{version:2,steps:[timed([sample(0,{action:'text',values:['Complete']})])],errors:['late renderer failure']}).passed,false);
});
test('broker refuses repeated-frame substitution, invalid timestamps and finite observation exhaustion',()=>{
 const j=parseJourney({...base,steps:[positive]}),b=new BrowserObservationBroker(j,()=>0),f={version:1,sequence:1,step:0,at:0,observation:{action:'text',values:['Idle']}};
 b.consume(f);assert.equal(b.consume(f),undefined);assert.throws(()=>b.consume({...f,observation:{action:'text',values:['Complete']}}),/changed/);
 assert.throws(()=>b.consume({...f,sequence:2,at:-1}),/Invalid/);
 for(let n=2;n<=200;n++)b.consume({...f,sequence:n,at:n});assert.throws(()=>b.consume({...f,sequence:201,at:201}),/limit/);
});
