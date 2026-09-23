import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
// @ts-expect-error Runtime is standalone JavaScript for offline Node containers.
import {observeHttp,observeJson} from '../src/acceptance/runtime/http.mjs';
async function fixture(run:(url:string)=>Promise<void>){let hits=0;const server=createServer(async(req,res)=>{hits++;if(req.url==='/redirect'){res.writeHead(302,{location:'/private-secret'});res.end();return;}if(req.url==='/slow')return;if(req.url==='/large'){res.end('x'.repeat(300));return;}if(req.url==='/wrong'){res.end('{"valid":true}');return;}res.setHeader('Content-Type','application/json');res.setHeader('X-Private','private-note');let body='';for await(const chunk of req)body+=chunk;res.end(JSON.stringify({hits,method:req.method,type:req.headers['content-type'],origin:req.headers.origin,body}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');try{await run(`http://127.0.0.1:${address.port}`);}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}}
test('HTTP observations retain raw headers and bodies, reject implicit redirects, and preserve negative requests',()=>fixture(async url=>{
 const redirect=await observeHttp(url+'/redirect');assert.equal(redirect.status,302);assert.equal(redirect.headers.location,'/private-secret');
 const valid=await observeJson(url,{method:'DELETE'});assert.equal(valid.data.hits,2);assert.equal(valid.data.method,'DELETE');assert.equal(valid.data.type,'application/json');assert.equal(valid.data.origin,url);assert.equal(valid.headers['x-private'],'private-note');assert.match(valid.text,/DELETE/);
 const negative=await observeHttp(url,{method:'POST',headers:{'Content-Type':'text/plain'},body:'text'});assert.equal(JSON.parse(negative.text).type,'text/plain');assert.equal(JSON.parse(negative.text).origin,undefined);
 const payload=await observeJson(url,{method:'POST',json:{title:'hello'}});assert.equal(payload.data.body,'{"title":"hello"}');
 await assert.rejects(observeHttp(url,{redirect:'follow'}),/redirect/);
}));
test('HTTP observations bound time and bytes and require JSON media type when parsing',()=>fixture(async url=>{
 await assert.rejects(observeHttp(url+'/large',{maxBytes:100}),/limit/);
 await assert.rejects(observeHttp(url+'/slow',{timeoutMs:30}));
 await assert.rejects(observeJson(url+'/wrong'),/JSON content type/);
}));
