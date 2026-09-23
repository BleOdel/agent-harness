/** Real container timeout/cleanup and fresh-container continuation; no model or credentials. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {run} from '../src/run.ts';
import {loadConfig} from '../src/config.ts';
import {approveChecks} from '../src/acceptance/checks.ts';
import {harnessDirectory,readRecord} from '../src/record/record.ts';
import {installFixtureCatalog} from './model-fixture.ts';
const configured=!!process.env.HARNESS_IMAGE_ID&&!!process.env.HARNESS_DOCKER;
test('Docker: timed-out implementation survives cleanup and resumes through independent acceptance', {skip:configured?false:'configure Docker for implementation-resume verification'},async()=>{
 const config=loadConfig(),root=await realpath(await mkdtemp(path.join(os.tmpdir(),'harness-work-resume-'))),project=path.join(root,'project'),pi=path.join(root,'pi'),agent=path.join(root,'agent');
 try {
  for(const d of [path.join(project,'test'),path.join(pi,'dist'),agent])await mkdir(d,{recursive:true});
  await installFixtureCatalog(pi);await writeFile(path.join(agent,'auth.json'),'{}');await writeFile(path.join(root,'config'),'# fixture');
  await writeFile(path.join(project,'features.json'),JSON.stringify([{id:'value',title:'Update value',criteria:['Return 2'],status:'todo',priority:'must',dependsOn:[]}]));
  await writeFile(path.join(project,'package.json'),JSON.stringify({type:'module',scripts:{test:'node --test test/*.test.js'}}));
  await writeFile(path.join(project,'app.js'),'export const value=1;\n');
  await writeFile(path.join(project,'test/app.test.js'),"import assert from 'node:assert/strict';import {value} from '../app.js';assert.ok(Number.isInteger(value));\n");
  const file=path.join(root,'checks.json');await writeFile(file,JSON.stringify({version:1,cases:[{id:'value',tasks:['value'],steps:[{command:['node','--input-type=module','-e',"import {value} from './app.js';console.log(value)"],exitCode:0,stdout:'2\n'}]}]}));await approveChecks(project,file);
  await writeFile(path.join(pi,'dist/cli.js'),`const fs=require('node:fs');const args=process.argv.slice(2);
if(args.includes('read,grep')){console.log(JSON.stringify({verdict:'pass',unmet:[],unaccounted:[],notes:[]}));}
else if(fs.readFileSync('app.js','utf8').includes('value=1')){
 fs.writeFileSync('app.js','export const value=2;\\n');fs.writeFileSync('.harness-claim.json','{unfinished');setInterval(()=>{},1000);
}else{
 if(fs.existsSync('.harness-claim.json'))throw Error('stale claim copied');
 if(!args.at(-1).includes('saved, unverified partial implementation'))throw Error('missing resume context');
 fs.writeFileSync('.harness-claim.json',JSON.stringify({files:['app.js'],deletions:[],criteria:[{criterion:'Return 2',verifiedBy:'test/app.test.js'}]}));
}`);
  const {NODE_TEST_CONTEXT:_test,NODE_OPTIONS:_options,...inherited}=process.env;
  const env={...inherited,HARNESS_CONFIG:path.join(root,'config'),HARNESS_PROJECT:project,HARNESS_DOCKER:config.dockerExecutable,HARNESS_IMAGE_ID:config.imageId,HARNESS_AGENT_DIR:agent,HARNESS_PI_PACKAGE:pi,HARNESS_PROVIDER:'fixture',HARNESS_MODEL:'fixture',HARNESS_REASONING_EFFORT:'medium',HARNESS_SKILLS:'',HARNESS_AGENT_TIMEOUT:'5'};
  const cli=path.resolve(import.meta.dirname,'../src/cli.ts');
  const first=await run(process.execPath,[cli,'work','value'],{env,timeoutMs:60000});
  assert.equal(first.code,1,first.stdout+first.stderr);assert.match(first.stderr+first.stdout,/partial work saved/);
  const sandbox=first.stdout.match(/sandbox: (.+)/)![1]!;await assert.rejects(readFile(path.join(sandbox,'app.js')),{code:'ENOENT'});
  assert.equal(await readFile(path.join(project,'app.js'),'utf8'),'export const value=1;\n');
  assert.equal(await readFile(path.join(harnessDirectory(project),'implementation/r1/source/app.js'),'utf8'),'export const value=2;\n');
  const second=await run(process.execPath,[cli,'work','--resume','r1'],{env:{...env,HARNESS_AGENT_TIMEOUT:'30'},timeoutMs:60000});
  assert.equal(second.code,0,second.stdout+second.stderr);assert.match(second.stdout,/acceptance:.*passed/);
  assert.notEqual(second.stdout.match(/sandbox: (.+)/)![1],sandbox);
  assert.equal(await readFile(path.join(project,'app.js'),'utf8'),'export const value=2;\n');
  const records=(await readRecord(project)).runs;assert.equal(records.length,2);assert.equal(records[1]!.resumedFrom,'r1');assert.ok(records[1]!.acceptance);
 }finally{await rm(root,{recursive:true,force:true});}
});
