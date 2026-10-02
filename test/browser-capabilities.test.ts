import test from 'node:test';import assert from 'node:assert/strict';
import {parseJourney,assessJourney,actionRequest} from '../src/browser/schema.ts';
const base={version:1,title:'Private author key',entry:'server.js',port:4173,timeoutSeconds:45};
const steps=[{action:'goto',path:'/'},{action:'capture',selector:'#key',name:'key',source:'text'},{action:'click',selector:'#copy'},{action:'clipboard',expectedFrom:'key'},{action:'download',selector:'#download',expectedFrom:'key'},{action:'storage',absentFrom:'key'},{action:'context',name:'other'},{action:'goto',path:'/'},{action:'fill',selector:'#key',valueFrom:'key'},{action:'text',selector:'#result',expected:'Loaded'}];
test('browser capabilities validate references, preserve host expectations and refuse script/network escapes',()=>{
 const j=parseJourney({...base,steps});const sent=actionRequest(j);
 assert.ok(!JSON.stringify(sent).includes('expectedFrom'));assert.ok(!JSON.stringify(sent).includes('absentFrom'));assert.ok(!JSON.stringify(sent).includes('Loaded'));assert.ok(JSON.stringify(sent).includes('valueFrom'));
 for(const bad of [[{action:'clipboard',expectedFrom:'missing'}],[{action:'capture',selector:'#k',name:'k',source:'text'}],[{action:'network',path:'//outside',method:'POST',mode:'abort'},...steps],[{action:'network',path:'/api',method:'TRACE',mode:'abort'},...steps],[{action:'clipboard',expected:'x',expectedFrom:'key'}], [...steps,{action:'evaluate',code:'alert(1)'}]])assert.throws(()=>parseJourney({...base,steps:bad}));
});
test('host compares dynamic key evidence and rejects missing captures, privacy leaks, failed downloads and false clipboard contents',()=>{
 const j=parseJourney({...base,steps});const observed={version:1,errors:[],steps:[{action:'goto',status:200},{action:'capture',values:['private-key']},{action:'click'},{action:'clipboard',value:'private-key'},{action:'download',value:'private-key'},{action:'storage',local:[],session:[],databases:[],cache:[],cookies:[]},{action:'context'},{action:'goto',status:200},{action:'fill'},{action:'text',values:['Loaded']}]};
 assert.equal(assessJourney(j,observed).passed,true);
 for(const [index,value] of [[1,{action:'capture',values:[]}],[3,{action:'clipboard',value:'wrong'}],[4,{action:'download',value:'wrong'}],[5,{action:'storage',local:[['secret','private-key']],session:[],databases:[],cache:[],cookies:[]}]] as const){const r=structuredClone(observed);r.steps[index]=value as typeof r.steps[number];assert.equal(assessJourney(j,r).passed,false);}
 assert.throws(()=>assessJourney(j,{...observed,steps:observed.steps.slice(1)}));
});
test('controlled failures have exact paths and methods, and request counters are checked on the host',()=>{
 const j=parseJourney({...base,steps:[{action:'network',path:'/api/stories',method:'POST',mode:'abort'},{action:'requestCount',path:'/api/stories',method:'POST',expected:1},{action:'network',path:'/api/stories',method:'POST',mode:'normal'},{action:'page',name:'stale'},{action:'attribute',selector:'#error',name:'role',expected:'alert'},{action:'paste',selector:'#story',value:'hello'}]});
 const r={version:1,errors:[],steps:[{action:'network'},{action:'requestCount',value:1},{action:'network'},{action:'page'},{action:'attribute',values:['alert']},{action:'paste'}]};assert.equal(assessJourney(j,r).passed,true);r.steps[1]!.value=0;assert.equal(assessJourney(j,r).passed,false);
});

import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {inspectBrowser} from '../src/browser/runtime.ts';import {saveApproval} from '../src/browser/store.ts';import {verifyBrowser} from '../src/browser/controller.ts';
test('real Chromium exercises clipboard, downloads, paste, profile isolation, stale pages and controlled failures',{skip:process.env.HARNESS_VERIFY_BROWSER!=='1'},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'browser-capabilities-')),project=root+'/app';await mkdir(project);
 const server=`import http from 'node:http';http.createServer((q,r)=>{if(q.url==='/api/save'){r.setHeader('Content-Type','application/json');return r.end('{"saved":true}');}r.setHeader('Content-Type','text/html');r.end(\`<!doctype html><html lang="en"><head><title>Author fixture</title></head><body><main><h1>Author</h1><p id="ready" hidden>Ready</p><p id="key">fixture-private-key</p><label for="story">Story</label><input id="story"><output id="count">0</output><button id="copy">Copy</button><span id="copied" hidden>Copied</span><a id="download" download="key.txt">Download</a><button id="remember">Remember</button><p id="saved"></p><button id="submit">Submit</button><p id="result" role="alert" hidden></p></main><script>
const key='fixture-private-key',broken=new URLSearchParams(location.search).get('broken');document.querySelector('#saved').textContent=localStorage.getItem('key')||'Empty';document.querySelector('#story').oninput=e=>document.querySelector('#count').textContent=String(e.target.value.length);
document.querySelector('#copy').onclick=async()=>{await navigator.clipboard.writeText(broken==='copy'?'wrong':key);document.querySelector('#copied').hidden=false;};document.querySelector('#download').href=URL.createObjectURL(new Blob([broken==='download'?'wrong':key]));document.querySelector('#remember').onclick=()=>localStorage.setItem('key',key);if(broken==='storage')sessionStorage.setItem('key',key);
(async()=>{if(broken==='indexed'){await new Promise((resolve,reject)=>{const r=indexedDB.open('private');r.onupgradeneeded=()=>r.result.createObjectStore('keys');r.onsuccess=()=>{const db=r.result,tx=db.transaction('keys','readwrite');tx.objectStore('keys').put(key,'saved');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=reject;};r.onerror=reject;});}if(broken==='cache')await (await caches.open('private')).put('/saved-key',new Response(key));if(broken==='cookie')document.cookie='private='+key;document.querySelector('#ready').hidden=false;})();
document.querySelector('#submit').onclick=async()=>{const result=document.querySelector('#result');result.hidden=true;try{const r=await fetch('/api/save',{method:'POST'});result.textContent=r.ok?'Saved':'Unavailable';}catch{result.textContent='Disconnected';}result.hidden=false;};
</script></body></html>\`);}).listen(Number(process.env.PORT),'127.0.0.1');`;
 await writeFile(project+'/package.json','{"type":"module"}');await writeFile(project+'/server.js',server);
 try{
 const runtime=await inspectBrowser();const sequence=[
 {action:'goto',path:'/'},{action:'capture',selector:'#key',name:'key',source:'text'},
 {action:'click',selector:'#copy'},{action:'text',selector:'#copied',expected:'Copied'},{action:'clipboard',expectedFrom:'key'},
 {action:'download',selector:'#download',expectedFrom:'key'},{action:'storage',absentFrom:'key'},
 {action:'paste',selector:'#story',value:'Hello'},{action:'text',selector:'#count',expected:'5'},
 {action:'network',path:'/api/save',method:'POST',mode:'abort'},{action:'click',selector:'#submit'},{action:'text',selector:'#result',expected:'Disconnected'},
 {action:'network',path:'/api/save',method:'POST',mode:'503'},{action:'click',selector:'#submit'},{action:'text',selector:'#result',expected:'Unavailable'},
 {action:'network',path:'/api/save',method:'POST',mode:'normal'},{action:'click',selector:'#submit'},{action:'text',selector:'#result',expected:'Saved'},
 {action:'requestCount',path:'/api/save',method:'POST',expected:3},{action:'attribute',selector:'#result',name:'role',expected:'alert'},
 {action:'click',selector:'#remember'},{action:'page',name:'stale'},{action:'goto',path:'/'},{action:'text',selector:'#saved',expected:'fixture-private-key'},
 {action:'context',name:'independent'},{action:'goto',path:'/'},{action:'text',selector:'#saved',expected:'Empty'},{action:'storage',absentFrom:'key'},
 {action:'fill',selector:'#story',valueFrom:'key'},{action:'text',selector:'#count',expected:'19'}];
 const a=await saveApproval(project,{...base,steps:sequence},runtime);const good=await verifyBrowser(project,a.id);assert.equal(good.status,'passed',good.message);assert.ok(good.assessment!.checks>=12);
 for(const broken of ['copy','download','storage','indexed','cache','cookie']){
  const b=await saveApproval(project,{...base,title:broken,steps:[{action:'goto',path:'/?broken='+broken},{action:'text',selector:'#ready',expected:'Ready'},{action:'capture',selector:'#key',name:'key',source:'text'},...(broken==='copy'?[{action:'click',selector:'#copy'},{action:'text',selector:'#copied',expected:'Copied'},{action:'clipboard',expectedFrom:'key'}]:broken==='download'?[{action:'download',selector:'#download',expectedFrom:'key'}]:[{action:'storage',absentFrom:'key'}])]},runtime);
  const bad=await verifyBrowser(project,b.id);assert.equal(bad.status,'failed',broken);assert.match(bad.message,/differs|private marker/);assert.deepEqual(bad.containers,[]);
 }
 assert.equal(await readFile(project+'/server.js','utf8'),server);
 }finally{await rm(root,{recursive:true,force:true});}
});
