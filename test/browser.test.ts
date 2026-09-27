import test from 'node:test';
import assert from 'node:assert/strict';
import {parseJourney,actionRequest,assessJourney} from '../src/browser/schema.ts';
const raw={version:1,title:'Read at narrow width',entry:'src/server.js',port:4173,timeoutSeconds:30,steps:[{action:'goto',path:'/'},{action:'text',selector:'h1',expected:'Stories'},{action:'overflow'},{action:'accessibility'}]};
test('browser journeys require observable expectations and confined startup/navigation',()=>{
 assert.equal(parseJourney(raw).entry,'src/server.js');
 for(const changes of [{entry:'../server.js'},{entry:'/etc/passwd'},{entry:'server.js; echo hi'},{databaseEnv:'NODE_OPTIONS'},{steps:[{action:'goto',path:'https://example.com'}]},{steps:[{action:'goto',path:'//example.com'}]},{steps:[{action:'goto',path:'/\\example.com'}]},{steps:[{action:'click',selector:'button'}]},{timeoutSeconds:301},{unknown:true}]) assert.throws(()=>parseJourney({...raw,...changes}));
});
test('browser driver receives actions but not operator expectations',()=>{
 const request=actionRequest(parseJourney(raw));
 assert.ok(!JSON.stringify(request).includes('Stories'));assert.equal(request.steps.length,4);
});
test('host refuses missing, reordered, fabricated or failed browser observations',()=>{
 const journey=parseJourney(raw);
 const good={version:1,steps:[{action:'goto',status:200},{action:'text',values:['Stories']},{action:'overflow',client:320,scroll:320},{action:'accessibility',violations:[]}],errors:[]};
 assert.equal(assessJourney(journey,good).passed,true);
 const bad=structuredClone(good);bad.steps[1]={action:'text',values:['Something else']};assert.equal(assessJourney(journey,bad).passed,false);
 const overflow=structuredClone(good);overflow.steps[2]={action:'overflow',client:320,scroll:500};assert.equal(assessJourney(journey,overflow).passed,false);
 assert.throws(()=>assessJourney(journey,{...good,steps:good.steps.slice(1)}));
 assert.throws(()=>assessJourney(journey,{...good,passed:true}));
 const redirected=structuredClone(good);redirected.steps[0]={action:'goto',status:302};assert.equal(assessJourney(journey,redirected).passed,false);
});

import {mkdtemp,writeFile,mkdir,rm,readFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {appArguments,driverArguments,verifyBrowser,recoverBrowser} from '../src/browser/controller.ts';
import {inspectBrowser} from '../src/browser/runtime.ts';
import {saveApproval,newRun,saveBrowserRun} from '../src/browser/store.ts';
import {listArtifacts,artifactBytes} from '../src/artifacts/store.ts';
import {run} from '../src/run.ts';

test('browser and app share only an offline network namespace',()=>{
 const j={id:'browser-123',token:'abc',runtime:{image:'sha256:test'}} as Parameters<typeof appArguments>[0];
 const spec=parseJourney(raw),app=appArguments(j,'app','/safe/source',spec),driver=driverArguments(j,'driver','app','/safe/run',spec);
 assert.ok(app.includes('none'));assert.ok(driver.includes('container:app'));
 assert.ok(app.includes('type=bind,src=/safe/source,dst=/app,readonly'));
 assert.ok(!driver.some(s=>s.includes('/safe/source')));
 assert.ok(!app.some(s=>s.includes('/harness-checks')||s.includes('/harness-instrumentation')));
 for(const args of [app,driver]){assert.ok(!args.includes('--privileged'));assert.ok(args.includes('--read-only'));assert.ok(!args.includes('--publish'));assert.ok(!args.some(s=>s.includes('docker.sock')));}
});

test('real browser observes UI, fails negative controls and retains artifacts without changing source',{skip:process.env.HARNESS_VERIFY_BROWSER!=='1'},async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'harness-browser-test-')),project=path.join(base,'app');await mkdir(project);
 const server=`import http from 'node:http';import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync(process.env.FIXTURE_DB);db.exec('CREATE TABLE probe (id INTEGER)');
http.createServer((req,res)=>{if(req.url==='/hang')return;res.setHeader('Content-Type','text/html');res.end(\`<!doctype html><html lang="en"><head><title>Browser fixture</title><style>body{margin:0;color:#111;background:#fff}button,input{min-height:44px}body.wide{width:2000px}</style></head><body class="\${req.url==='/wide'?'wide':''}"><main><h1>Stories</h1><p id="isolation">\${fs.existsSync('/harness-checks/actions.json')?'leaked':'isolated'}</p><label for="title">Title</label><input id="title"><button id="save">Save</button><p id="status" role="status"></p></main><script>document.querySelector('#status').textContent=localStorage.getItem('title')||'Empty';document.querySelector('#save').onclick=()=>{const t=document.querySelector('#title').value;localStorage.setItem('title',t);document.querySelector('#status').textContent=t;};</script></body></html>\`);}).listen(Number(process.env.PORT),'127.0.0.1');`;
 await writeFile(project+'/package.json','{"type":"module","name":"browser-fixture"}');await writeFile(project+'/server.js',server);
 try{
  const runtime=await inspectBrowser();
  const spec={version:1,title:'Complete fixture',entry:'server.js',port:4173,databaseEnv:'FIXTURE_DB',timeoutSeconds:45,steps:[{action:'goto',path:'/'},{action:'text',selector:'#isolation',expected:'isolated'},{action:'text',selector:'h1',expected:'Stories'},{action:'fill',selector:'#title',value:'Remember me'},{action:'press',selector:'#title',key:'Tab'},{action:'focused',selector:'#save'},{action:'press',selector:'#save',key:'Enter'},{action:'text',selector:'#status',expected:'Remember me'},{action:'reload'},{action:'text',selector:'#status',expected:'Remember me'},{action:'viewport',width:320,height:800},{action:'overflow'},{action:'accessibility'},{action:'screenshot'}]};
  const approved=await saveApproval(project,spec,runtime),result=await verifyBrowser(project,approved.id);
  assert.equal(result.status,'passed',result.message);assert.deepEqual(result.containers,[]);assert.ok(result.source);assert.ok(result.assessment!.checks>=8);
  const artifacts=await listArtifacts(project);const screen=artifacts.find(a=>a.name==='screen-13.png');assert.ok(screen);assert.ok((await artifactBytes(project,screen.id)).length>100);assert.ok(artifacts.some(a=>a.name==='axe-12.json'));assert.equal(await readFile(project+'/server.js','utf8'),server);
  for(const [title,steps]of [['wrong heading',[{action:'goto',path:'/'},{action:'text',selector:'h1',expected:'Wrong'}]],['overflow',[{action:'goto',path:'/wide'},{action:'overflow'}]],['timeout',[{action:'goto',path:'/hang'},{action:'text',selector:'h1',expected:'Stories'}]]] as const){
   const a=await saveApproval(project,{...spec,title,timeoutSeconds:10,steps},runtime),r=await verifyBrowser(project,a.id);assert.equal(r.status,'failed',title);assert.deepEqual(r.containers,[]);
  }
  const orphan=await newRun(project,approved,'/usr/local/bin/docker');const name=`harness-browser-${crypto.randomUUID()}`;orphan.containers=[name];orphan.status='running';await saveBrowserRun(project,orphan);
  const launched=await run(orphan.docker,['run','-d','--rm','--network','none','--name',name,'--label',`harness.browser=${orphan.id}`,'--label',`harness.token=${orphan.token}`,'--entrypoint','sleep',runtime.image,'60'],{timeoutMs:10000});assert.equal(launched.code,0,launched.stderr);
  await recoverBrowser(project,orphan.id);const inspected=await run(orphan.docker,['inspect',name],{timeoutMs:10000});assert.notEqual(inspected.code,0);
 }finally{await rm(base,{recursive:true,force:true});}
});

import {browserSetup} from '../src/guide/browser.ts';
import {listApprovals} from '../src/browser/store.ts';
test('guided browser setup saves reviewed expectations without invoking a model',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'browser-guide-')),project=base+'/app';await mkdir(project);
 const answers=['1','Read stories','','','30','1','Stories','8','10','15','y'],messages:string[]=[];
 const runtime={image:'sha256:'+'a'.repeat(64),arch:'arm64',node:'v26.5.0',playwright:'1.63.0',chromium:'153',axe:'4.13.0',protocol:'b'.repeat(64)};
 try{await browserSetup(project,{ask:async()=>{assert.ok(answers.length);return answers.shift()!;},write:m=>messages.push(m)},async()=>runtime);
 const approvals=await listApprovals(project);assert.equal(approvals.length,1);assert.equal(approvals[0]!.journey.title,'Read stories');assert.equal(approvals[0]!.journey.steps.at(-1)?.action,'overflow');assert.ok(messages.some(m=>m.includes('Expected values stay on the host')));assert.equal(answers.length,0);
 }finally{await rm(base,{recursive:true,force:true});}
});
