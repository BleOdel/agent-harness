import {productEvidence} from '../src/view/product.ts';
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,realpath,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {draftProduct,approveProduct} from '../src/product/spec.ts';import {productReport} from '../src/product/report.ts';import {approveSecurity} from '../src/security/store.ts';import {verifySecurity,appArguments,probeArguments} from '../src/security/controller.ts';import {securityReport,recordSecurityAssessment} from '../src/security/report.ts';import {scope} from './security-fixture.ts';import {run} from '../src/run.ts';
const server=String.raw`
import http from 'node:http';import {randomBytes} from 'node:crypto';
const stories=new Map(),port=Number(process.env.PORT),origin='http://127.0.0.1:'+port;
const server=http.createServer(async(req,res)=>{
 const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
 if(req.headers.host!=='127.0.0.1:'+port)return send(403,{error:'host'});
 if(req.headers.origin&&req.headers.origin!==origin)return send(403,{error:'origin'});
 if(req.url==='/api/stories'&&req.method==='POST'){
  if(req.headers['content-type']!=='application/json')return send(415,{error:'media'});
  let text='';for await(const chunk of req)text+=chunk;
  const body=JSON.parse(text),key=randomBytes(32).toString('hex');stories.set(key,body);return send(201,{managementKey:key});
 }
 if(req.url==='/api/stories'){
  if(fault==='flood'){process.stdout.write('X'.repeat(1200000));}
  if(fault==='privacy'&&stories.size)res.setHeader('X-Private-Key',stories.keys().next().value);
  return send(200,{stories:[]});
 }
 if(req.url==='/api/author/story'){
  const story=stories.get(req.headers.authorization?.slice(7));if(!story)return send(fault==='authorization'?200:401,{error:'unauthorized'});return send(200,{story});
 }
 return send(404,{error:'missing'});
});server.listen(port,'127.0.0.1');
process.on('SIGTERM',()=>{if(fault==='logs'&&stories.size)console.error(stories.keys().next().value);server.close(()=>process.exit(0));});
`;
test('security containers separate app source, probe code/config/output and retain offline limits',()=>{
 const r:any={id:'security-run-x',token:'test',image:'sha256:'+'a'.repeat(64)},a=appArguments(r,'app','/owned/source',scope.recipe as any),p=probeArguments(r,'probe','app','/owned',scope.recipe as any);
 assert.ok(a.includes('--network=none'));assert.ok(!a.join(' ').includes('/harness-checks'));assert.ok(!a.join(' ').includes('/owned/output'));assert.ok(p.includes('container:app'));assert.ok(!p.join(' ').includes('/owned/source'));assert.ok(a.includes('--read-only'));assert.ok(p.includes('--read-only'));assert.ok(a.includes('max-file=2'));
});
test('real isolated security: positive controls, authorization failure, header disclosure, shutdown logging and cancellation',{skip:!process.env.HARNESS_VERIFY_SECURITY,timeout:240000},async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'security-live-'))),docker=process.env.HARNESS_DOCKER??'/usr/local/bin/docker',image=process.env.HARNESS_IMAGE_ID!;let success=false;
 try{
 for(const fault of ['none','authorization','privacy','logs','flood','cancel']){
  const project=root+'/'+fault;await mkdir(project+'/src',{recursive:true});await writeFile(project+'/package.json','{"name":"security-fixture","type":"module"}');await writeFile(project+'/features.json',JSON.stringify([{id:'service',title:'Service',priority:'must',status:'done',criteria:['Protect private data'],dependsOn:[]} ]));await writeFile(project+'/src/server.js',`const fault=${JSON.stringify(fault)};\n`+server);
  const product=await draftProduct(project,'api','prototype',[]);await approveProduct(project,product);await approveSecurity(project,scope,image);const before=await productReport(project),r=await verifySecurity(project,message=>{console.log(fault+': '+message);if(fault==='cancel'&&message.startsWith('Running approved'))process.emit('SIGTERM');},docker);
  if(fault==='cancel'){assert.equal(r.status,'interrupted');}else if(fault==='flood'){assert.equal(r.status,'failed');assert.ok(r.message.includes('log inspection'));assert.equal(r.report,undefined);}else{
   const context={source:before.source!,product:product.digest,consequence:'prototype' as const,acceptance:[]},report=await securityReport(project,context);
   if(fault==='none'){assert.equal(r.status,'passed',r.message);assert.equal(report.requirements.find(r=>r.id==='probes')?.status,'passed',JSON.stringify(report));await recordSecurityAssessment(project,report,true,'Reviewed the synthetic local scope; no dependency or production assurance.');assert.equal((await securityReport(project,context)).status,'passed');}
   else{assert.equal(r.status,'failed',r.message);assert.ok(report.findings.some(f=>f.rule===fault),JSON.stringify(report));}
   assert.ok(!JSON.stringify(report).includes('HARNESS_SYNTHETIC_'));const panel=productEvidence(await productReport(project),undefined);assert.match(panel,/Security scope/);assert.ok(!panel.includes('HARNESS_SYNTHETIC_'));
  }
  assert.deepEqual(r.containers,[]);const ps=await run(docker,['ps','-aq','--filter',`label=harness.security=${r.id}`],{timeoutMs:10000});assert.equal(ps.stdout.trim(),'');await assert.rejects(readFile(project+'-harness/security/runs/'+r.id+'/output/synthetic-secrets.json'));
 }success=true;
 }finally{if(success)await rm(root,{recursive:true,force:true});else console.log('Retained security trial for inspection: '+root);}
});
