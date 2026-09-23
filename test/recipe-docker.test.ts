import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {compileRecipe} from '../src/acceptance/recipes/catalog.ts';import {approveChecks,requireChecks,verifyAcceptance} from '../src/acceptance/checks.ts';import {captureBaseline} from '../src/workspace/candidate.ts';import {loadConfig} from '../src/config.ts';import {webFixture,webSpec} from './recipe-fixtures.ts';
const configured=!!process.env.HARNESS_DOCKER&&!!process.env.HARNESS_IMAGE_ID;
test('Docker recipe accepts the good server and rejects independently broken asset, privacy, storage and transport behaviours',{skip:configured?false:'configure Docker for recipe verification'},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'recipe-docker-')),project=path.join(root,'app');await mkdir(project);
 try{
  await writeFile(path.join(project,'package.json'),'{"type":"module"}');await writeFile(path.join(project,'app.js'),webFixture);await writeFile(path.join(project,'mode'),'good');
  const file=path.join(root,'checks.json');await writeFile(file,JSON.stringify({version:1,cases:[{id:'boundary',tasks:['app'],steps:[compileRecipe(webSpec)]}]}));await approveChecks(project,file);const approved=await requireChecks(project,['app']);const config=loadConfig();
  for(const mode of ['good','missing-asset','leak-db','leak-sidecar','inside-work','bad-db','bad-host','bad-origin']){
   await writeFile(path.join(project,'mode'),mode);const candidate=await captureBaseline(project,path.join(root,mode));
   if(mode==='good'){const result=await verifyAcceptance(project,candidate,['app'],config,approved);const proof=JSON.parse(await readFile(result.evidencePath,'utf8'));const observed=JSON.parse(proof.observations[0].stdoutPreview);assert.equal(observed.assets.responses,5);assert.equal(observed.database.integrity[0],'ok');assert.equal(observed.requests.leaks,0);assert.equal(observed.cleanup.removed,true);assert.ok(observed.requests.scanned>30);}
   else await assert.rejects(verifyAcceptance(project,candidate,['app'],config,approved),mode==='missing-asset'||mode==='bad-db'?/expected exit 0/:/Recipe evidence/);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
