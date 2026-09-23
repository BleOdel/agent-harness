import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {discoverAssets, collectAssets, assertNoDatabaseBytes} from '../src/acceptance/runtime/assets.mjs';
const page='http://127.0.0.1:1234/page/index.html';
const urls=(r:any)=>r.references.map((x:any)=>x.url).sort();
test('HTML assets respect base, entities, unquoted attributes, inert templates and raw text',()=>{
 const result=discoverAssets(`<base href="../files/"><base href="/ignored/"><script src=main.js></script><link rel=stylesheet href='a.css'><img src="a.png?x=1&amp;y=2"><template><template></template><img src=missing.png></template><!-- <img src=comment.png> --><script>const example='<img src="string.png">';</script><textarea><img src=textarea.png></textarea><svg><image href="icon.svg#part" /></svg><video poster=poster.png></video>`,page,'html');
 assert.deepEqual(urls(result),['a.css','a.png?x=1&y=2','icon.svg','main.js','poster.png'].map(x=>'http://127.0.0.1:1234/files/'+x).sort());
 assert.deepEqual(result.unresolved,[]);
});
test('JavaScript parses imports without matching comments, strings or nested template examples',()=>{
 const r=discoverAssets(`// import './missing.js'\nconst s="import './fake.js'";const t=\`outer \${\`inner\`} import './no.js'\`; import x from './real.js';export * from './exports.js';import('./lazy.js');new URL('./photo.png',import.meta.url);import(name);`,page,'module');
 assert.deepEqual(urls(r),['real.js','exports.js','lazy.js','photo.png'].map(x=>'http://127.0.0.1:1234/page/'+x).sort());assert.equal(r.unresolved.length,1);
 assert.throws(()=>discoverAssets('import {',page,'module'),/JavaScript/);
});
test('CSS parses imports, URLs and escaped names; comment and content examples are inert',()=>{
 const r=discoverAssets(`/* url(missing.png) */ @import "nested.css"; .x{background:url("im\\61ge.png");content:"url(fake.png)";src:url(font.woff2)}`,page,'css');
 assert.deepEqual(urls(r),['nested.css','image.png','font.woff2'].map(x=>'http://127.0.0.1:1234/page/'+x).sort());
 assert.throws(()=>discoverAssets('.x{background:???}',page,'css'),/CSS/);
 // CSS defines EOF recovery for an unclosed string; inspect the recovered URL.
 assert.ok(urls(discoverAssets('.x { background: url("unterminated)',page,'css')).some((u:string)=>u.endsWith('unterminated)')));
});
test('inline modules/styles, srcset and remote references retain explicit evidence boundaries',()=>{
 const r=discoverAssets(`<script type=module>import './m.js'</script><style>@import 's.css';</style><img style="background:url(i.png)" srcset="a.png 1x, b.png 2x"><img src=https://other.invalid/x><script type=importmap>{}</script>`,page,'html');
 assert.ok(urls(r).includes('http://127.0.0.1:1234/page/m.js'));assert.ok(urls(r).includes('http://127.0.0.1:1234/page/b.png'));
 assert.equal(r.external.length,1);assert.equal(r.unresolved.length,1);
});
async function fixture(routes:Record<string,{body:string|Buffer,type?:string,status?:number}>,run:(url:string)=>Promise<void>){
 const server=createServer((q,r)=>{const item=routes[q.url!]??{body:'missing',status:404};r.writeHead(item.status??200,{'content-type':item.type??'text/plain'});r.end(item.body);});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{await run('http://127.0.0.1:'+(server.address() as any).port+'/');}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
test('asset crawl fetches transitive modules/CSS, keeps binary bodies, deduplicates cycles and rejects missing assets',async()=>{
 const routes:any={'/':{body:'<script type=module src="a.js"></script><link rel=stylesheet href=s.css><img src=p.png>',type:'text/html'},'/a.js':{body:`import './b.js'`,type:'text/javascript'},'/b.js':{body:`import './a.js'`,type:'text/javascript'},'/s.css':{body:'a{background:url(p.png)}',type:'text/css'},'/p.png':{body:Buffer.from([0,1,255]),type:'image/png'}};
 await fixture(routes,async url=>{const r=await collectAssets(url);assert.equal(r.responses.length,5);assert.deepEqual(r.responses.find((x:any)=>x.url.endsWith('p.png'))!.body,Buffer.from([0,1,255]));assert.deepEqual(r.unresolved,[]);});
 delete routes['/b.js'];await fixture(routes,async url=>{await assert.rejects(collectAssets(url),/HTTP 404/);});
});
test('HTTP errors, redirects, resource and byte limits fail closed',async()=>{
 for(const [routes,opts,pattern] of [
  [{'/':{body:'redirect',status:302}}, {}, /HTTP 302/],
  [{'/':{body:'<img src=x>',type:'text/html'},'/x':{body:'x'}},{maxResources:1},/resource limit/],
  [{'/':{body:'large document',type:'text/html'}},{maxBytes:4},/byte limit/],
  [{'/':{body:'not HTML',type:'text/plain'}},{},/HTML/],
 ] as const)await fixture(routes,async url=>{await assert.rejects(collectAssets(url,opts),pattern);});
});
test('database disclosure checks containment in any response, including prefixed assets and sidecars',()=>{
 const db=Buffer.from('SQLite format 3\0private');const sidecar=Buffer.from([2,3,4,5]);
 for(const body of [Buffer.concat([Buffer.from('prefix'),db,Buffer.from('suffix')]),Buffer.concat([Buffer.from('prefix'),sidecar,Buffer.from('suffix')])])assert.throws(()=>assertNoDatabaseBytes([{url:page,body}],[db,sidecar]),/database/i);
 assert.doesNotThrow(()=>assertNoDatabaseBytes([{url:page,body:Buffer.from('safe')}],[db,sidecar]));
 assert.throws(()=>assertNoDatabaseBytes([{url:page,body:db}],[]),/database/i);
});

test('CSS conditions and namespace strings are not mistaken for files; custom property URLs are found',()=>{
 const r=discoverAssets('@namespace svg url(http://www.w3.org/2000/svg); @import "a.css" supports(font-format: "woff"); :root{--art:url(custom.png)}',page,'css');
 assert.deepEqual(urls(r),['a.css','custom.png'].map(x=>'http://127.0.0.1:1234/page/'+x));assert.deepEqual(r.external,[]);
});
test('external assets are reported without network requests and computed imports cannot silently claim coverage',async()=>{
 await fixture({'/':{body:'<img src="https://invalid.invalid/a.png"><script type=module>import(name)</script>',type:'text/html'}},async url=>{const r=await collectAssets(url);assert.equal(r.responses.length,1);assert.equal(r.external.length,1);assert.equal(r.unresolved.length,1);});
});
test('a stalled body is aborted within the request deadline',async()=>{
 const server=createServer((_q,r)=>{r.writeHead(200,{'content-type':'text/html'});r.write('<html>');});server.listen(0,'127.0.0.1');await once(server,'listening');
 try{await assert.rejects(collectAssets('http://127.0.0.1:'+(server.address() as any).port,{timeoutMs:100}),/abort/i);}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
