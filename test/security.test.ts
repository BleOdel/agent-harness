import test from 'node:test';import assert from 'node:assert/strict';
import {parseScope,assess,parseObservations} from '../src/security/schema.ts';
const scope={version:1,assets:'Private drafts and anonymous management keys',interfaces:'Local HTTP API',boundaries:'Unauthenticated reader versus story owner',dependencyReview:{mode:'unavailable',rationale:'No pinned vulnerability feed configured'},acceptanceTasks:['service'],recipe:{entry:'src/server.js',port:3847,timeoutSeconds:60,databaseEnv:'APP_DB',createPath:'/api/stories',privatePath:'/api/author/story',publicPath:'/api/stories',keyField:'managementKey',fields:{title:'Synthetic check',body:'$MARKER',contentNote:null},createStatus:201,deniedStatus:401,originStatus:403,hostStatus:403,pendingPrivate:true}};
const good={version:1,statuses:{public:200,create1:201,create2:201,authorized1:200,authorized2:200,missing:401,invalid:401,origin:403,host:403,media:415,publicAfter:200},keysDistinct:true,ownMarkers:[1,1],otherMarkers:[0,0],keyLeaks:0,privateLeaks:0,logKeyLeaks:0,logBodyLeaks:0,logsComplete:true};
test('security scope rejects external targets, executable configuration and missing controls',()=>{
 assert.deepEqual(parseScope(scope),scope);
 for(const patch of [{createStatus:'201'},{privatePath:'https://outside.test/'},{publicPath:'//outside.test/'},{entry:'../server.js'},{timeoutSeconds:3600},{fields:{body:'no unique marker'}}])assert.throws(()=>parseScope({...scope,recipe:{...scope.recipe,...patch}}));
 assert.throws(()=>parseScope({...scope,dependencyReview:{mode:'passed',rationale:'Everything secure'}}));
});
test('security comparisons require positive controls and observe privacy without retaining secrets',()=>{
 assert.equal(assess(parseScope(scope),good).length,0);
 for(const [field,value]of [['keyLeaks',1],['privateLeaks',1],['logKeyLeaks',1],['logBodyLeaks',1],['keysDistinct',false]] as const){const findings=assess(parseScope(scope),{...good,[field]:value});assert.ok(findings.length);assert.ok(findings.every(f=>f.severity==='high'));}
 assert.ok(assess(parseScope(scope),{...good,statuses:{...good.statuses,authorized1:401}}).some(f=>f.rule==='controls'));
 assert.ok(assess(parseScope(scope),{...good,statuses:{...good.statuses,missing:200}}).some(f=>f.rule==='authorization'));
 assert.ok(assess(parseScope(scope),{...good,statuses:{...good.statuses,origin:200}}).some(f=>f.rule==='origin'));
 assert.throws(()=>parseObservations({...good,keyLeaks:-1}));assert.throws(()=>parseObservations({...good,rawBody:'secret'}));assert.throws(()=>parseObservations({...good,statuses:{...good.statuses,missing:undefined}}));assert.throws(()=>parseObservations({...good,logsComplete:false}));
});
import {countLeaks,creationLeaks} from '../src/security/instrumentation/scan.mjs';
test('privacy scans decode JSON escapes and refuse duplicate-field disclosures while exempting only the created key',()=>{
 const key='synthetic-secret-111',prior='synthetic-secret-222',escaped=[...prior].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('');
 assert.equal(creationLeaks('',JSON.stringify({managementKey:key}),key,[key,prior]),0);
 assert.ok(creationLeaks('',`{"managementKey":"${key}","hidden":"${escaped}","hidden":null}`,key,[key,prior])>0);
 assert.ok(creationLeaks('',`{"managementKey":"${key}","managementKey":"${key}"}`,key,[key])>0);
 assert.ok(countLeaks(`{"secret":"${escaped}"}`,[prior])>0);assert.ok(countLeaks('header: '+Buffer.from(key).toString('base64'),[key])>0);
});

import {run} from '../src/run.ts';
test('fixed security instrumentation parses before an isolated run starts',async()=>{
 for(const file of ['probe.mjs','scan.mjs']){const result=await run(process.execPath,['--check',new URL('../src/security/instrumentation/'+file,import.meta.url).pathname]);assert.equal(result.code,0,result.stderr);}
});
