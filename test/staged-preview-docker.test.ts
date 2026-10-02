/** Real Docker, Chromium and host-browser bridge; fixture agent makes no provider requests. */
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {run} from '../src/run.ts';import {loadConfig} from '../src/config.ts';
import {approveChecks} from '../src/acceptance/checks.ts';import {installFixtureCatalog} from './model-fixture.ts';
import {startStagePreview} from '../src/staging/preview.ts';import {readStage,recordStageReview} from '../src/staging/store.ts';
import {stageCommand} from '../src/verbs/stage.ts';
const configured=!!process.env.HARNESS_IMAGE_ID&&!!process.env.HARNESS_DOCKER;
test('Docker: staged web candidate is previewed with isolated data then applied only after explicit final review',{skip:configured?false:'configure Docker and browser image for staged preview'},async()=>{
 const config={dockerExecutable:process.env.HARNESS_DOCKER!,imageId:process.env.HARNESS_IMAGE_ID!},root=await realpath(await mkdtemp(path.join(os.tmpdir(),'harness-stage-preview-'))),project=path.join(root,'project'),pi=path.join(root,'pi'),agent=path.join(root,'agent');
 const prior={...process.env};let preview:Awaited<ReturnType<typeof startStagePreview>>|undefined;
 try{
  for(const d of [path.join(project,'test'),path.join(pi,'dist'),agent])await mkdir(d,{recursive:true});
  await installFixtureCatalog(pi);await writeFile(path.join(agent,'auth.json'),'{}');await writeFile(path.join(root,'config'),'# fixture');
  await writeFile(path.join(project,'features.json'),JSON.stringify([{id:'value',title:'Update value',criteria:['Return 2'],status:'todo',priority:'must',dependsOn:[]}]));
  await writeFile(path.join(project,'package.json'),JSON.stringify({type:'module',scripts:{test:'node --test test/*.test.js'}}));
  await writeFile(path.join(project,'app.js'),'export const value=1;\n');
  await writeFile(path.join(project,'server.js'),`import http from 'node:http';import {value} from './app.js';import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.env.BLOG_DB);db.exec('CREATE TABLE IF NOT EXISTS visits(n INTEGER)');db.exec('INSERT INTO visits VALUES (1)');http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<h1>'+value+'</h1><p>'+db.prepare('SELECT COUNT(*) AS n FROM visits').get().n+'</p>');}).listen(Number(process.env.PORT),'127.0.0.1');`);
  await writeFile(path.join(project,'test/app.test.js'),"import assert from 'node:assert/strict';import {value} from '../app.js';assert.ok(Number.isInteger(value));\n");
  Object.assign(process.env,{HARNESS_CONFIG:path.join(root,'config'),HARNESS_PROJECT:project,HARNESS_DOCKER:config.dockerExecutable,HARNESS_IMAGE_ID:config.imageId,HARNESS_AGENT_DIR:agent,HARNESS_PI_PACKAGE:pi,HARNESS_PROVIDER:'fixture',HARNESS_MODEL:'fixture',HARNESS_REASONING_EFFORT:'medium',HARNESS_SKILLS:'',HARNESS_AGENT_TIMEOUT:'30'});
  const file=path.join(root,'checks.json');await writeFile(file,JSON.stringify({version:1,cases:[
   {id:'value',tasks:['value'],steps:[{command:['node','--input-type=module','-e',"import {value} from './app.js';console.log(value)"],exitCode:0,stdout:'2\n'}]},
   {id:'page',kind:'browser',tasks:['value'],steps:[],browser:{version:1,title:'Value heading',entry:'server.js',databaseEnv:'BLOG_DB',port:4200,timeoutSeconds:20,steps:[{action:'goto',path:'/'},{action:'text',selector:'h1',expected:'2'}]}},
   {id:'speech',kind:'manual',tasks:['value'],steps:[],manual:{instructions:'Observe the heading using a real screen reader.'}}
  ]}));await approveChecks(project,file);
  await writeFile(path.join(pi,'dist/cli.js'),`const fs=require('node:fs');const args=process.argv.slice(2);if(args.includes('read,grep')){console.log(JSON.stringify({verdict:'pass',unmet:[],unaccounted:[],notes:[]}));}else{fs.writeFileSync('app.js','export const value=2;\\n');fs.writeFileSync('.harness-claim.json',JSON.stringify({files:['app.js'],deletions:[],criteria:[{criterion:'Return 2',verifiedBy:'test/app.test.js'}]}));}`);
  const {NODE_TEST_CONTEXT:_test,NODE_OPTIONS:_options,...env}=process.env,cli=path.resolve(import.meta.dirname,'../src/cli.ts');
  const built=await run(process.execPath,[cli,'continue','value'],{env,timeoutMs:60000,maxOutputBytes:100000});assert.equal(built.code,0,built.stdout+built.stderr);assert.match(built.stdout,/Staged as r1/);assert.match(built.stdout,/awaits final review/);
  assert.equal(await readFile(path.join(project,'app.js'),'utf8'),'export const value=1;\n');
  const s=await readStage(project,'r1');assert.deepEqual(s.manual.map(c=>c.id),['speech']);
  await assert.rejects(recordStageReview(project,s,{environment:'synthetic test only',observations:[{id:'speech',passed:true,notes:'Synthetic test attestation, not actual screen-reader proof'}],approved:true}),/Preview this exact/);
  preview=await startStagePreview(project,'r1');
  const result=await fetch(preview.url);assert.equal(result.status,200);assert.equal(await result.text(),'<h1>2</h1><p>1</p>');
  const metadata=JSON.parse(await readFile(path.join(project+'-harness/staging/r1/preview.json'),'utf8'));
  const inspected=await run(config.dockerExecutable,['inspect',metadata.name],{timeoutMs:10000});const container=JSON.parse(inspected.stdout)[0];assert.equal(container.HostConfig.NetworkMode,'none');assert.equal(container.HostConfig.ReadonlyRootfs,true);assert.ok(container.Mounts.filter((m:{Type:string})=>m.Type==='bind').every((m:{RW:boolean})=>!m.RW));
  await preview.close();preview=undefined;
  preview=await startStagePreview(project,'r1');assert.equal(await (await fetch(preview.url)).text(),'<h1>2</h1><p>1</p>');await preview.close();preview=undefined;
  // Simulated operator interaction only, confined to this temporary fixture.
  const answers=['Synthetic test: fetched preview with Node, no screen-reader observation claimed','Synthetic fixture observation only','y','y'];
  await stageCommand(project,['review','r1'],{write:()=>{},ask:async()=>answers.shift()??assert.fail('unexpected prompt')});assert.equal(answers.length,0);
  assert.equal(await readFile(path.join(project,'app.js'),'utf8'),'export const value=2;\n');assert.equal((await readStage(project,'r1')).status,'applied');
 }finally{await preview?.close();for(const k of Object.keys(process.env))if(!(k in prior))delete process.env[k];Object.assign(process.env,prior);await rm(root,{recursive:true,force:true});}
});
