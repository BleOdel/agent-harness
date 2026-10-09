/** Desired behavior for known audit failures. Run explicitly; failures are never counted as fixes. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { captureBaseline } from '../src/workspace/candidate.ts';
import { validateTorchCheckpoint } from '../src/torch/schema.ts';

const known = { skip: process.env.HARNESS_KNOWN_DEFECTS === '1' ? false : 'Known audit defects: explicit non-qualifying lane, HARNESS_KNOWN_DEFECTS=1' };
test('F13 incomplete serialized classifier checkpoint is rejected', known, () => {
  const dict = (keys: string[]) => ({ dict: keys.map(key => [key, null]) });
  const value = { protocol: 'torch-cpu@1', context: 'audit', completed: 1, runtime: '2.14.0+cpu',
    model: dict(['0.weight', '0.bias', '3.weight', '3.bias', '5.weight', '5.bias']),
    optimizer: { dict: [['state', { dict: [] }], ['param_groups', []]] },
    scheduler: dict(['last_epoch', '_step_count']), torchRng: Array(5056).fill(0),
    pythonRng: [3, { tuple: Array(625).fill(null) }, null], permutation: [], cursor: 0, epoch: 1, losses: [1], centers: null };
  assert.throws(() => validateTorchCheckpoint(value, 'audit', 1, 'classifier'), /checkpoint|tensor|optimizer|state/i);
});

import {readFile} from 'node:fs/promises';
import {run} from '../src/run.ts';
import {applyChanges} from '../src/workspace/sandbox-lifecycle.ts';
import {repairSavedCheck} from '../src/acceptance/guided.ts';
import {parseProposal} from '../src/acceptance/draft.ts';
import {scopeDigest} from '../src/acceptance/scoped-review.ts';
import {putArtifact,sha256} from '../src/artifacts/store.ts';
import {prepareRelease,approveRelease,stageRelease} from '../src/releases/controller.ts';
import {prepareGitHub,approveGitHub,uploadGitHub,type GitHubClient} from '../src/releases/github.ts';
const task={id:'app',title:'App',status:'todo' as const,priority:'must' as const,dependsOn:[],criteria:['Pending content is private.']};
const proposal=()=>parseProposal({version:1,contract:'Pending content is private.',coverage:[{criterion:1,cases:['edit','peer']}],manifest:{version:1,cases:['edit','peer'].map(id=>({id,tasks:['app'],description:id,steps:[{command:['node','-e','console.log(1)'],exitCode:0,stdout:'1\n'}]}))}},task);

test('F01 targeted repair can resume a preparation-owned failed scope',known,async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'audit-preparation-')),project=root+'/app';
 try{
  await mkdir(project);await mkdir(project+'-harness/acceptance',{recursive:true});
  await writeFile(project+'/features.json',JSON.stringify([task]));const p=proposal();
  const ledger={version:1,entries:['$contract','peer','edit'].map(scope=>({scope,digest:scopeDigest(task,p,scope),repairs:scope==='edit'?2:0,syntaxRepairs:0,review:{verdict:scope==='edit'?'repair':'pass',issues:scope==='edit'?['Observe pending fields']:[],limitations:[]}}))};
  const saved={version:1,taskId:task.id,state:{version:1,blueprint:{version:1,contract:p.contract,coverage:p.coverage,cases:p.manifest.cases.map(c=>({id:c.id,description:c.description}))},cases:p.manifest.cases,reviewLedger:ledger}};
  const file=project+'-harness/acceptance/preparation.json';await writeFile(file,JSON.stringify(saved));
  let called=false;
  await repairSavedCheck(project,{write:()=>{},ask:async()=>{throw Error('Unexpected question');}},'edit',async(_project,_task,input,scope,history)=>{called=true;assert.equal(scope,'edit');assert.ok(history.entries.some(e=>e.scope==='peer'&&e.review?.verdict==='pass'));return {proposal:input,ledger:history};});
  assert.equal(called,true,'targeted repair must locate the preparation-owned scope');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('F04 a failed ordinary apply preserves every live file',known,async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'audit-apply-')),project=root+'/app',copy=root+'/copy';
 try{
  await mkdir(project);await mkdir(copy);
  for(const file of ['a.js','b.js'])await writeFile(project+'/'+file,'before');
  await writeFile(copy+'/a.js','after');
  // Missing second source simulates failure after intent selection, without platform-specific permission behavior.
  await assert.rejects(applyChanges(project,copy,['a.js','b.js'].map(file=>({file,kind:'modified',symlink:false}))),/ENOENT/);
  assert.equal(await readFile(project+'/a.js','utf8'),'before','a late source read failure must not partially apply');
  assert.equal(await readFile(project+'/b.js','utf8'),'before');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('F14 confirmed remote permission denial can be retried without resetting release state',known,async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'audit-release-')),project=root+'/app',commit='a'.repeat(40);
 try{
  await mkdir(project);await mkdir(root+'/stage');
  const artifact=await putArtifact(project,'bundle.zip',Buffer.from('fixture'),{producer:'audit',input:'b'.repeat(64),environment:'c'.repeat(64),verification:'diagnostics-passed'});
  const local=await prepareRelease(project,{artifact:artifact.id,name:'audit',version:'1.0.0',destination:root+'/stage'});
  await approveRelease(project,local.id,local.digest);await stageRelease(project,local.id);
  const draft=await prepareGitHub(project,{release:local.id,repository:'audit/repo',tag:'v1',commit});await approveGitHub(project,draft.id,draft.digest);
  let denied=true,creates=0;const releases:any[]=[],assets:any[]=[];
  const client:GitHubClient={async request(method,route,body){
   if(route.includes('/commits/'))return {sha:commit};if(route.includes('/git/ref/'))return null;
   if(route.includes('/releases?'))return releases;if(route.endsWith('/assets'))return assets;
   if(method==='POST'&&route.endsWith('/releases')){creates++;if(denied)throw Error('GitHub request failed (403).');const value={...body as object,id:1};releases.push(value);return value;}
   if(route.endsWith('/releases/1'))return releases[0];throw Error('Unexpected fake route '+route);
  },async upload(route,bytes){const asset={id:assets.length+1,name:new URL('https://uploads.github.com/'+route).searchParams.get('name'),state:'uploaded',size:bytes.length,digest:'sha256:'+sha256(bytes)};assets.push(asset);return asset;}};
  await assert.rejects(uploadGitHub(project,draft.id,client),/403/);denied=false;
  assert.equal((await uploadGitHub(project,draft.id,client)).status,'uploaded');assert.equal(creates,2);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('F16 explicit preparation without a terminal reaches project validation',known,async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'audit-tty-'));
 try{
  await mkdir(root+'/agent');await writeFile(root+'/config','# isolated\n');
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('HARNESS_')&&!['NODE_OPTIONS','NODE_TEST_CONTEXT'].includes(k)));
  const result=await run(process.execPath,[new URL('../src/cli.ts',import.meta.url).pathname,'checks','prepare','--max-requests','1'],{timeoutMs:10000,env:{...env,HARNESS_PROJECT:root,HARNESS_CONFIG:root+'/config',HARNESS_AGENT_DIR:root+'/agent',HARNESS_PROVIDER:'fixture',HARNESS_MODEL:'fixture'}});
  assert.equal(result.timedOut,false);assert.doesNotMatch(result.stdout+result.stderr,/needs a terminal/i);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('F18 an unrelated peer description does not invalidate a case code review',known,()=>{
 const p=proposal(),before=scopeDigest(task,p,'edit');p.manifest.cases[1]!.description='An unchanged peer check with clearer wording.';
 assert.equal(scopeDigest(task,p,'edit'),before);
});

import {approveChecks,verifyAcceptance} from "../src/acceptance/checks.ts";
import {loadConfig} from "../src/config.ts";
const baseCase={id:"ui",tasks:["ui"],kind:"browser",steps:[],browser:{version:1,title:"Async completion",entry:"server.js",port:4173,timeoutSeconds:20}};
test('F02 Chromium waits for an asynchronously rendered expected result',{skip:process.env.HARNESS_KNOWN_DEFECTS!=='1'||process.env.HARNESS_VERIFY_BROWSER!=='1'},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'audit-browser-')),project=root+'/app';await mkdir(project);
 try{
  await writeFile(project+'/package.json','{"type":"module"}');
  await writeFile(project+'/server.js',`import http from 'node:http';http.createServer((q,r)=>r.end('<button id="go">Go</button><output id="state">Idle</output><script>document.querySelector("#go").onclick=()=>setTimeout(()=>document.querySelector("#state").textContent="Complete",750);</script>')).listen(Number(process.env.PORT),'127.0.0.1');`);
  const file=root+'/checks.json';await writeFile(file,JSON.stringify({version:1,cases:[{...baseCase,description:'After Go, observe the asynchronous completion within the journey timeout.',browser:{...baseCase.browser,title:'Async completion',steps:[{action:'goto',path:'/'},{action:'click',selector:'#go'},{action:'text',selector:'#state',expected:'Complete'}]}}]}));
  const approval=await approveChecks(project,file);await mkdir(root+'/pi');await mkdir(root+'/agent');
  const config=loadConfig({...process.env,HARNESS_PROJECT:project,HARNESS_PI_PACKAGE:root+'/pi',HARNESS_AGENT_DIR:root+'/agent'});
  const candidate=await captureBaseline(project,root+'/candidate');
  const proof=await verifyAcceptance(project,candidate,['ui'],config,approval);
  assert.match(proof.summaries.join('\n'),/passed in Chromium/);
 }finally{await rm(root,{recursive:true,force:true});}
});
