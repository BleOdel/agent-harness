import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJourney, actionRequest, assessJourney, validateApp } from '../src/desktop/schema.ts';
const raw={version:1,title:'Save notes',timeoutSeconds:60,steps:[{action:'fill',selector:'#note',value:'First note'},{action:'click',selector:'#save'},{action:'text',selector:'#notes',expected:'First note'},{action:'restart'},{action:'count',selector:'li',expected:1},{action:'screenshot'}]};
test('desktop journeys freeze bounded actions and keep expected values off the driver request',()=>{
 const spec=parseJourney(raw),request=actionRequest(spec);assert.equal(request.steps.length,6);assert.ok(!JSON.stringify(request).includes('expected'));assert.equal(request.steps[0]!.action,'fill');
 for(const change of [{timeoutSeconds:0},{steps:[]},{steps:[{action:'execute',code:'process.exit()'}]},{steps:[{action:'text',selector:'#x',expected:3}]},{steps:[{action:'restart',command:'oops'}]}])assert.throws(()=>parseJourney({...raw,...change}));
 assert.throws(()=>parseJourney({...raw,steps:[{action:'click',selector:'x'.repeat(301)}]}));
});
test('host compares exact GUI observations, rejects incomplete/forged reports, and does not accept a claimed pass',()=>{
 const spec=parseJourney(raw),steps=[{action:'fill'},{action:'click'},{action:'text',values:['','First note']},{action:'restart'},{action:'count',value:1},{action:'screenshot',file:'screen-5.png'}];
 const report={version:1,packaged:true,steps,errors:[]};assert.equal(assessJourney(spec,report).passed,true);
 assert.equal(assessJourney(spec,{...report,steps:steps.map((s,i)=>i===2?{action:'text',values:['wrong']}:s)}).passed,false);
 assert.equal(assessJourney(spec,{...report,errors:['renderer error']}).passed,false);
 for(const bad of [{...report,passed:true},{...report,packaged:false},{...report,steps:steps.slice(0,2)},{...report,steps:steps.map((s,i)=>i===5?{action:'screenshot',file:'../escape.png'}:s)}])assert.throws(()=>assessJourney(spec,bad));
});
test('desktop packaging accepts a local main entry and refuses dependencies or unsafe entries',()=>{
 assert.equal(validateApp({name:'notes',version:'1.0.0',main:'src/main.cjs'}),'src/main.cjs');
 for(const main of ['../main.js','/main.js','src/../main.js','file:main.js'])assert.throws(()=>validateApp({name:'notes',version:'1.0.0',main}));
 assert.throws(()=>validateApp({name:'notes',version:'1.0.0',main:'main.js',dependencies:{electron:'latest'}}));
});

test('press actions accept only supported keys and invalid dependency declarations are refused',()=>{
 const spec=parseJourney({...raw,steps:[{action:'press',selector:'#note',key:'Enter'},...raw.steps]});assert.equal(spec.steps[0]!.action,'press');
 assert.throws(()=>parseJourney({...raw,steps:[{action:'press',selector:'#note',key:'unknown'},...raw.steps]}));
 for(const dependencies of [2,['electron'],null])assert.throws(()=>validateApp({name:'notes',version:'1.0.0',main:'main.js',dependencies}));
});
