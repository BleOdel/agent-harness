import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {mkdtemp,readFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
// @ts-expect-error Standalone runtime for offline Node containers.
import {observeHttp,observeJson} from '../src/acceptance/runtime/http-bytes.mjs';
import {assertNoDatabaseBytes} from '../src/acceptance/runtime/assets.mjs';
import {HTTP_MODULE,HTTP_DIGEST,HTTP_BYTES_MODULE,HTTP_BYTES_DIGEST,assertHttpRuntimes,pinHttpRuntime,writeHttpRuntime,httpRuntimeReview} from '../src/acceptance/http-runtime.ts';
import {refreshHelperPins} from '../src/acceptance/helper-pins.ts';import {applyCodeRepair} from '../src/acceptance/repair-response.ts';import {parseProposal} from '../src/acceptance/draft.ts';
const secret=Buffer.from([255,254,0,128,193,192,17]);
async function fixture(run:(url:string)=>Promise<void>){let hits=0;const server=createServer(async(req,res)=>{hits++;if(req.url==='/slow')return;if(req.url==='/redirect'){res.writeHead(302,{location:'/binary','x-private':'marker'});res.end(secret);return;}if(req.url==='/binary'){res.writeHead(404,{'content-type':'application/octet-stream'});res.write(secret.subarray(0,3));res.end(secret.subarray(3));return;}if(req.url==='/empty'){res.writeHead(204);res.end();return;}if(req.url==='/wrong'){res.end('{}');return;}res.setHeader('Content-Type','application/json');let body='';for await(const chunk of req)body+=chunk;res.end(JSON.stringify({hits,type:req.headers['content-type'],origin:req.headers.origin,body}));});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');try{await run(`http://127.0.0.1:${address.port}`);}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}}
test('byte observations retain invalid UTF-8 across chunks and detect disclosures lost by text reconstruction',()=>fixture(async url=>{
 const r=await observeHttp(url+'/binary');assert.equal(r.status,404);assert.deepEqual(r.bytes,secret);assert.equal(r.text,secret.toString('utf8'));assert.notDeepEqual(Buffer.from(r.text),secret);
 assert.throws(()=>assertNoDatabaseBytes([{body:r.bytes}],[secret]));assert.doesNotThrow(()=>assertNoDatabaseBytes([{body:Buffer.from(r.text)}],[secret]));
 const empty=await observeHttp(url+'/empty');assert.deepEqual(empty.bytes,Buffer.alloc(0));assert.equal(empty.text,'');
}));
test('byte observations preserve JSON defaults, negative probes, redirects and byte/time limits',()=>fixture(async url=>{
 const redirect=await observeHttp(url+'/redirect');assert.equal(redirect.status,302);assert.equal(redirect.headers.location,'/binary');assert.equal(redirect.headers['x-private'],'marker');assert.deepEqual(redirect.bytes,secret);
 const json=await observeJson(url,{method:'POST',json:{title:'café'}});assert.equal(json.data.hits,2);assert.equal(json.data.type,'application/json');assert.equal(json.data.origin,url);assert.equal(json.data.body,'{"title":"café"}');assert.deepEqual(JSON.parse(json.bytes.toString('utf8')),json.data);
 const negative=await observeHttp(url,{method:'DELETE',headers:{'content-type':'text/plain'},body:'wrong'});assert.equal(JSON.parse(negative.text).type,'text/plain');assert.equal(JSON.parse(negative.text).origin,undefined);
 await assert.rejects(observeHttp(url+'/binary',{maxBytes:secret.length-1}),/limit/);await assert.rejects(observeHttp(url+'/slow',{timeoutMs:30}));await assert.rejects(observeHttp(url,{redirect:'follow'}),/redirect/);await assert.rejects(observeJson(url+'/wrong'),/JSON content type/);
}));
const task={id:'app',title:'App',status:'todo' as const,priority:'must' as const,dependsOn:[],criteria:['Observe private bytes.']};
const proposal=()=>parseProposal({version:1,contract:'Private data stays private.',coverage:[{criterion:1,cases:['old','new']}],manifest:{version:1,cases:[['old',HTTP_MODULE,HTTP_DIGEST],['new',HTTP_BYTES_MODULE,HTTP_BYTES_DIGEST]].map(([id,module,digest])=>({id,tasks:['app'],description:id,steps:[{command:['node','--input-type=module','-e',`import {observeHttp} from '${module}'; console.log(1)`],httpRuntime:digest,exitCode:0,stdout:'1\n'}]}))}},task);
test('both HTTP versions are mounted and pinned without refreshing previously reviewed text checks',async()=>{
 assert.equal(HTTP_DIGEST,'41e661a9f7d91f8120e6ce7307e35ce4bd8970f7d7e262754f455ecf50ff46d4');
 const p=proposal();assertHttpRuntimes(p.manifest);assert.deepEqual(refreshHelperPins(p,'old'),p);assert.deepEqual(refreshHelperPins(p,'new'),p);
 const step=p.manifest.cases[1]!.steps[0]!;step.httpRuntime=HTTP_DIGEST;assert.throws(()=>assertHttpRuntimes(p.manifest),/missing or changed/);pinHttpRuntime(step);assert.equal(step.httpRuntime,HTTP_BYTES_DIGEST);
 delete step.httpRuntime;assert.throws(()=>assertHttpRuntimes(p.manifest),/missing or changed/);pinHttpRuntime(step);
 const root=await mkdtemp(path.join(os.tmpdir(),'http-versions-'));try{await writeHttpRuntime(root);for(const [file,digest] of [['http.mjs',HTTP_DIGEST],['http-bytes.mjs',HTTP_BYTES_DIGEST]])assert.equal(createHash('sha256').update(await readFile(path.join(root,file!))).digest('hex'),digest);}finally{await rm(root,{recursive:true,force:true});}
 const review=httpRuntimeReview([step]);assert.match(review,/bytes/);assert.match(review,new RegExp(HTTP_BYTES_DIGEST));
});
test('targeted migration pins byte observations without changing peers, contract or expected results',()=>{
 const p=proposal(),updated=applyCodeRepair(task,p,'old',{codes:[{step:1,code:`import {observeHttp} from '${HTTP_BYTES_MODULE}'; console.log(1)`}]});assert.equal(updated.manifest.cases[0]!.steps[0]!.httpRuntime,HTTP_BYTES_DIGEST);assert.equal(updated.contract,p.contract);assert.equal(updated.manifest.cases[0]!.steps[0]!.stdout,'1\n');assert.deepEqual(updated.manifest.cases[1],p.manifest.cases[1]);assertHttpRuntimes(updated.manifest);
 const mixed=updated.manifest.cases[0]!.steps[0]!;mixed.command[3]+=`;import '${HTTP_MODULE}'`;assert.throws(()=>pinHttpRuntime(mixed),/one HTTP helper/);
});

import {scopeDigest,reviewScopes} from '../src/acceptance/scoped-review.ts';import {taskDigest} from '../src/acceptance/draft.ts';import {ASSET_MODULE,ASSET_DIGEST} from '../src/acceptance/asset-runtime.ts';
test('pre-byte-policy disclosure receipts need fresh review while unrelated scope receipts remain reusable',async()=>{
 const p=proposal(),s=p.manifest.cases[0]!.steps[0]!;s.command[3]+=`;import {assertNoDatabaseBytes} from '${ASSET_MODULE}';`;s.assetRuntime=ASSET_DIGEST;
 const oldDigest=(scope:string)=>createHash('sha256').update(JSON.stringify({policy:1,task:taskDigest(task),metadata:{contract:p.contract,coverage:p.coverage,cases:p.manifest.cases.map(c=>({id:c.id,tasks:c.tasks,description:c.description}))},case:scope==='$contract'?null:p.manifest.cases.find(c=>c.id===scope)})).digest('hex');
 assert.equal(scopeDigest(task,p,'old'),oldDigest('old'));
 s.command[3]+=";const example='Buffer.from(r.text)';/* Buffer.from(r.text) */";assert.equal(scopeDigest(task,p,'old'),oldDigest('old'));
 s.command[3]+=';Buffer.from(response.text)';
 assert.notEqual(scopeDigest(task,p,'old'),oldDigest('old'));assert.equal(scopeDigest(task,p,'new'),oldDigest('new'));assert.equal(scopeDigest(task,p,'$contract'),oldDigest('$contract'));
 const pass={verdict:'pass' as const,issues:[],limitations:[]},ledger={version:1 as const,entries:['$contract','old','new'].map(scope=>({scope,digest:oldDigest(scope),repairs:0,syntaxRepairs:0,review:pass}))};const seen:string[]=[];
 const reviewed=await reviewScopes(task,p,{syntax:async()=>[],review:async scope=>{seen.push(scope);return pass;},repair:async()=>{throw Error('not a code repair');},save:async()=>{}},ledger);
 assert.deepEqual(seen,['old']);assert.deepEqual(reviewed.ledger.entries.find(e=>e.scope==='new'),ledger.entries.find(e=>e.scope==='new'));
});
