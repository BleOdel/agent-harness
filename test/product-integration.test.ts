import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,realpath,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {applyConfigFile} from '../src/config.ts';
import {approveChecks} from '../src/acceptance/checks.ts';
import {draftProduct,approveProduct} from '../src/product/spec.ts';
import {productReport,recordAssessment} from '../src/product/report.ts';
import {verify} from '../src/verbs/verify.ts';
test('Docker product verification runs real diagnostics and independent behaviour, rejects mutation and never dispatches a model',{skip:process.env.HARNESS_VERIFY_PRODUCT!=='1'},async()=>{
 applyConfigFile();
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'product-docker-'))),project=path.join(root,'app');
 try{
  await mkdir(path.join(project,'test'),{recursive:true});
  await writeFile(path.join(project,'package.json'),JSON.stringify({name:'product-fixture',version:'1.0.0',type:'module',scripts:{test:'node --test test/*.test.js'}}));
  await writeFile(path.join(project,'app.js'),'console.log("Saved story");\n');
  await writeFile(path.join(project,'test/runtime.test.js'),'import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; test("application entry exists",()=>assert.ok(fs.readFileSync("app.js","utf8").length>0));\n');
  await writeFile(path.join(project,'features.json'),JSON.stringify([{id:'story',title:'Read a story',priority:'must',status:'done',criteria:['The application prints Saved story.'],dependsOn:[]}]));
  const checks=path.join(root,'checks.json');await writeFile(checks,JSON.stringify({version:1,cases:[{id:'read-story',tasks:['story'],steps:[{command:['node','app.js'],exitCode:0,stdout:'Saved story\n'}]}]}));
  await approveChecks(project,checks);await approveProduct(project,await draftProduct(project,'cli','prototype',[]));
  await verify(project,['--acceptance']);let report=await productReport(project);
  assert.equal(report.checks.find(c=>c.id==='diagnostics')?.status,'passed',JSON.stringify(report));
  assert.equal(report.checks.find(c=>c.id==='acceptance:story')?.status,'passed',JSON.stringify(report));
  await recordAssessment(project,report.source!,report.spec!,true,'Inspected fixture output and its intentionally limited coverage.');
  assert.equal((await productReport(project)).ready,true);
  const savedImage=process.env.HARNESS_IMAGE_ID;
  try{process.env.HARNESS_IMAGE_ID='sha256:'+'f'.repeat(64);assert.equal((await productReport(project)).checks.find(c=>c.id==='diagnostics')?.status,'stale');}
  finally{if(savedImage===undefined)delete process.env.HARNESS_IMAGE_ID;else process.env.HARNESS_IMAGE_ID=savedImage;}
  await writeFile(path.join(project,'app.js'),'console.log("Wrong story");\n');
  await assert.rejects(()=>verify(project,['--acceptance']),/output|stdout/i);
  report=await productReport(project);assert.equal(report.ready,false);
  assert.equal(report.checks.find(c=>c.id==='diagnostics')?.status,'passed');
  assert.equal(report.checks.find(c=>c.id==='acceptance:story')?.status,'failed');
 }finally{await rm(root,{recursive:true,force:true});}
});
