/** Real Docker enforces read-only claim correction; fixture agents never contact providers. */
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {run} from '../src/run.ts';import {loadConfig} from '../src/config.ts';
import {approveChecks} from '../src/acceptance/checks.ts';import {harnessDirectory,readRecord} from '../src/record/record.ts';
import {installFixtureCatalog} from './model-fixture.ts';
const configured=!!process.env.HARNESS_IMAGE_ID&&!!process.env.HARNESS_DOCKER;
for(const invalid of [false,true])test(`Docker: claim correction is read-only and failure is resumable (${invalid})`,{skip:configured?false:'configure Docker for claim recovery'},async()=>{
 const config=loadConfig(),root=await realpath(await mkdtemp(path.join(os.tmpdir(),'harness-claim-recovery-'))),project=path.join(root,'project'),pi=path.join(root,'pi'),agent=path.join(root,'agent');
 try{
  for(const d of [path.join(project,'test'),path.join(pi,'dist'),agent])await mkdir(d,{recursive:true});
  await installFixtureCatalog(pi);await writeFile(path.join(agent,'auth.json'),'{}');await writeFile(path.join(root,'config'),'# fixture');
  await writeFile(path.join(project,'features.json'),JSON.stringify([{id:'value',title:'Update value',criteria:['Return 2'],status:'todo',priority:'must',dependsOn:[]}]));
  await writeFile(path.join(project,'package.json'),JSON.stringify({type:'module',scripts:{test:'node --test test/*.test.js'}}));
  await writeFile(path.join(project,'app.js'),'export const value=1;\n');await writeFile(path.join(project,'test/app.test.js'),"import assert from 'node:assert/strict';import {value} from '../app.js';assert.ok(Number.isInteger(value));\n");
  const checks=path.join(root,'checks.json');await writeFile(checks,JSON.stringify({version:1,cases:[{id:'value',tasks:['value'],steps:[{command:['node','--input-type=module','-e',"import {value} from './app.js';console.log(value)"],exitCode:0,stdout:'2\n'}]}]}));await approveChecks(project,checks);
  await writeFile(path.join(pi,'dist/cli.js'),`const fs=require('node:fs'),args=process.argv.slice(2);const claim={files:['app.js'],deletions:[],criteria:[{criterion:'Return 2',verifiedBy:'test/app.test.js'}]};
if(args.at(-1).includes('Correct only the completion claim')){
 let denied=false;try{fs.writeFileSync('/work/app.js','unsafe edit');}catch(e){denied=['EROFS','EACCES'].includes(e.code);}if(!denied)throw Error('source was writable');
 if(${invalid})claim.files=[];
 const message={role:'assistant',content:[{type:'text',text:JSON.stringify(claim)}],usage:{totalTokens:10,cost:{total:0.01}}};
 for(const type of ['message_end','turn_end'])console.log(JSON.stringify({type,message}));console.log(JSON.stringify({type:'agent_end',messages:[message]}));
}else if(args.includes('read,grep')){console.log(JSON.stringify({verdict:'pass',unmet:[],unaccounted:[],notes:[]}));}
else {if(fs.readFileSync('app.js','utf8').includes('value=1')){fs.writeFileSync('app.js','export const value=2;\\n');claim.files=[];}
else if(fs.existsSync('.harness-claim.json'))throw Error('old claim restored');fs.writeFileSync('.harness-claim.json',JSON.stringify(claim));}`);
  const {NODE_TEST_CONTEXT:_test,NODE_OPTIONS:_options,...inherited}=process.env;
  const env={...inherited,HARNESS_CONFIG:path.join(root,'config'),HARNESS_PROJECT:project,HARNESS_DOCKER:config.dockerExecutable,HARNESS_IMAGE_ID:config.imageId,HARNESS_AGENT_DIR:agent,HARNESS_PI_PACKAGE:pi,HARNESS_PROVIDER:'fixture',HARNESS_MODEL:'fixture',HARNESS_REASONING_EFFORT:'medium',HARNESS_SKILLS:'',HARNESS_AGENT_TIMEOUT:'30'};
  const cli=path.resolve(import.meta.dirname,'../src/cli.ts');const first=await run(process.execPath,[cli,'work','value'],{env,timeoutMs:60000});assert.equal(first.code,invalid?1:0,first.stdout+first.stderr);
  if(invalid){
   assert.match(first.stderr,/harness work --resume r1/);assert.equal(await readFile(path.join(project,'app.js'),'utf8'),'export const value=1;\n');
   assert.equal(await readFile(path.join(harnessDirectory(project),'implementation/r1/source/app.js'),'utf8'),'export const value=2;\n');
   const second=await run(process.execPath,[cli,'work','--resume','r1'],{env,timeoutMs:60000});assert.equal(second.code,0,second.stdout+second.stderr);
  }
  const records=(await readRecord(project)).runs;assert.equal(records[0]!.usage?.totalTokens,10);assert.equal(records.at(-1)!.outcome,'applied');assert.ok(records.at(-1)!.acceptance);
  assert.equal(await readFile(path.join(project,'app.js'),'utf8'),'export const value=2;\n');
 }finally{await rm(root,{recursive:true,force:true});}
});
