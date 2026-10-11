import test from 'node:test';import assert from 'node:assert/strict';
import {migrationDocument} from '../src/acceptance/migration.ts';
import {SERVER_DIGEST,SERVER_MODULE} from '../src/acceptance/server-runtime.ts';
const command=(id:string,pin=SERVER_DIGEST)=>({id,tasks:['task'],description:id,steps:[{command:['node','--input-type=module','-e',`import '${SERVER_MODULE}'`],serverRuntime:pin,exitCode:0,stdout:'observed'}]});
test('migration inventories all stale checks, preserves unrelated receipts, and never upgrades old approval',()=>{
 const proposal={version:1,contract:'contract',coverage:[],manifest:{version:1,cases:[command('old','0'.repeat(64)),command('also-old','1'.repeat(64)),command('current')]}};
 const original={version:1,proposal,ledger:{version:1,entries:[{scope:'old',digest:'prior',review:{verdict:'pass'}},{scope:'current',digest:'kept',review:{verdict:'pass'}}]},validation:{status:'reviewed'}};
 const before=JSON.stringify(original),m=migrationDocument(original);assert.equal(m.changes.length,2);assert.equal(JSON.stringify(original),before);assert.equal(m.next.proposal.manifest.cases[0].steps[0].serverRuntime,SERVER_DIGEST);assert.deepEqual(m.next.ledger.entries,[original.ledger.entries[1]]);assert.equal(m.next.validation,undefined);assert.equal(m.requiresApproval,true);
});
test('negative timing needs an explicit choice; old browser approvals cannot acquire a fresh runtime receipt',()=>{
 const c={id:'browser',tasks:['task'],kind:'browser',steps:[],browser:{version:1,title:'UI',entry:'server.js',port:4173,timeoutSeconds:20,steps:[{action:'requestCount',method:'POST',path:'/submit',expected:0}]}};
 const original={version:1,manifest:{version:1,cases:[c]},browserRuntime:{protocol:'old'},approvedAt:'before',digest:'old'};
 const report=migrationDocument(original);assert.equal(report.blocked.length,1);assert.equal(report.next.manifest.cases[0].browser.steps[0].observation,undefined);
 const prepared=migrationDocument(original,1000);assert.equal(prepared.blocked.length,0);assert.deepEqual(prepared.next.manifest.cases[0].browser.steps[0].observation,{mode:'during',milliseconds:1000});assert.equal(prepared.next.browserRuntime.protocol,'old');assert.equal(prepared.next.approvedAt,'before');assert.equal(prepared.requiresApproval,true);
});
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {prepareMigration,migrationReport} from '../src/acceptance/migration.ts';
test('bounded migration resumes after publication interruption without re-reviewing, and keeps approved bytes intact',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'migration-')),project=root+'/project',dir=project+'-harness/acceptance';await mkdir(project);await mkdir(dir,{recursive:true});
 const manifest={version:1,cases:[command('first','0'.repeat(64)),command('second','1'.repeat(64)),command('peer')]};const approved=JSON.stringify({version:1,manifest,digest:'historic',approvedAt:'historic'});const original=JSON.stringify(manifest);
 try{await writeFile(dir+'/approved.json',approved);await writeFile(dir+'/draft.json',original);let reviews=0;
 const review=async()=>{reviews++;};const report=await migrationReport(project);assert.equal(report.flatMap(r=>r.changes).length,4);
 const partial=await prepareMigration(project,{review,maxCases:1});assert.equal(partial.status,'pending');assert.equal(reviews,1);assert.equal(await readFile(dir+'/draft.json','utf8'),original);
 await assert.rejects(prepareMigration(project,{review,maxCases:4,checkpoint:async phase=>{if(phase==='written')throw Error('crash');}}),/crash/);
 assert.equal(await readFile(dir+'/approved.json','utf8'),approved);const done=await prepareMigration(project,{review,maxCases:4});assert.equal(done.status,'prepared');assert.equal(reviews,4);
 assert.equal(await readFile(dir+'/migration/draft.json.original','utf8'),original);assert.equal(await readFile(dir+'/migration/approved.json.original','utf8'),approved);
 assert.equal(JSON.parse(await readFile(dir+'/draft.json','utf8')).cases[0].steps[0].serverRuntime,SERVER_DIGEST);assert.deepEqual(JSON.parse(await readFile(dir+'/draft.json','utf8')).cases[2],manifest.cases[2]);
 const again=await prepareMigration(project,{review,maxCases:4});assert.equal(again.status,'prepared');assert.equal(reviews,4);
 await writeFile(dir+'/draft.json','newer work');await assert.rejects(prepareMigration(project,{review}),/changed during migration/);assert.equal(await readFile(dir+'/draft.json','utf8'),'newer work');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('migration refuses modified saved output, and a missing window can be supplied before any reviews',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'migration-window-')),project=root+'/project',dir=project+'-harness/acceptance';await mkdir(project);await mkdir(dir,{recursive:true});
 const c={id:'private',tasks:['task'],kind:'browser',steps:[],browser:{version:1,title:'Private',entry:'server.js',port:4173,timeoutSeconds:20,steps:[{action:'count',selector:'.private',expected:0}]}};
 try{await writeFile(dir+'/draft.json',JSON.stringify({version:1,cases:[c]}));let calls=0;const review=async()=>{calls++;};await assert.rejects(prepareMigration(project,{review}),/decision/);assert.equal(calls,0);
 const state=await prepareMigration(project,{review,negativeWindow:1000});assert.equal(state.status,'prepared');assert.equal(calls,1);
 const journal=JSON.parse(await readFile(dir+'/migration/journal.json','utf8'));journal.documents[0].after=journal.documents[0].after.replace('1000','2000');await writeFile(dir+'/migration/journal.json',JSON.stringify(journal));await assert.rejects(prepareMigration(project,{review}),/proposal changed/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('a concurrent edit during independent review prevents publication',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'migration-drift-')),project=root+'/project',dir=project+'-harness/acceptance';await mkdir(project);await mkdir(dir,{recursive:true});
 try{await writeFile(dir+'/draft.json',JSON.stringify({version:1,cases:[command('old','0'.repeat(64))]}));await assert.rejects(prepareMigration(project,{review:async()=>{await writeFile(dir+'/draft.json','operator changed this');}}),/changed during migration/);assert.equal(await readFile(dir+'/draft.json','utf8'),'operator changed this');}finally{await rm(root,{recursive:true,force:true});}
});
import {migrationImpact,approveMigration} from '../src/acceptance/migration.ts';
import {compileRecipe} from '../src/acceptance/recipes/catalog.ts';
import {ASSET_MODULE,ASSET_DIGEST} from '../src/acceptance/asset-runtime.ts';
test('blog helper replay preserves retired designs, staged source and receipts, and batches every active pin',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'migration-blog-')),project=root+'/project',dir=project+'-harness/acceptance';await mkdir(project);await mkdir(dir,{recursive:true});
 try{
 const recipe=compileRecipe({kind:'node-web-sqlite',version:1,entry:'src/server.js',databaseEnv:'TO_BE_HEARD_DB',portEnv:'PORT',readinessPrefix:'Listening at ',entryPath:'/',publicPaths:['/api/stories'],rejectHost:403,rejectOrigin:403});recipe.recipeRuntime='0'.repeat(64);
 const asset=command('assets');asset.steps[0]!.command=['node','--input-type=module','-e',`import '${ASSET_MODULE}'`];delete (asset.steps[0] as any).serverRuntime;(asset.steps[0] as any).assetRuntime='1'.repeat(64);
 const cases=[command('startup','2'.repeat(64)),asset,{id:'recipe',tasks:['task'],steps:[recipe]}];
 const raw={version:1,state:{version:1,blueprint:{contract:'fixed'},cases,retiredCases:[{id:'retired',raw:command('retired','3'.repeat(64))}],outlineReview:{digest:'same-contract'},reviewLedger:{version:1,entries:[{scope:'peer',digest:'unchanged'}]}}};
 await writeFile(dir+'/preparation.json',JSON.stringify(raw));const staging=project+'-harness/staging/r7';await mkdir(staging,{recursive:true});const state=JSON.stringify({status:'pending',acceptance:{approvalDigest:'old'}});await writeFile(staging+'/state.json',state);await writeFile(staging+'/source.js','retained source');
 const report=await migrationReport(project);assert.deepEqual(report[0]!.changes.map(c=>c.id),['startup','assets','recipe']);assert.equal(report[0]!.blocked.length,0);const retired=JSON.stringify(raw.state.retiredCases);let count=0;
 await assert.rejects(prepareMigration(project,{review:async()=>{count++;},checkpoint:async phase=>{if(phase==='written')throw Error('interrupt');}}),/interrupt/);
 await prepareMigration(project,{review:async()=>{count++;}});assert.equal(count,3);
 const saved=JSON.parse(await readFile(dir+'/preparation.json','utf8'));assert.equal(saved.state.cases[1].steps[0].assetRuntime,ASSET_DIGEST);assert.equal(JSON.stringify(saved.state.retiredCases),retired);assert.deepEqual(saved.state.outlineReview,raw.state.outlineReview);assert.deepEqual(saved.state.reviewLedger,raw.state.reviewLedger);
 assert.equal(await readFile(staging+'/state.json','utf8'),state);assert.equal(await readFile(staging+'/source.js','utf8'),'retained source');assert.match((await migrationImpact(project)).join('\n'),/Staged r7.*old/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('migration approval is explicit, verifies retained proposal bytes and cannot approve old evidence',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'migration-approval-')),project=root+'/project',dir=project+'-harness/acceptance';await mkdir(project);await mkdir(dir,{recursive:true});
 try{const original=JSON.stringify({version:1,manifest:{version:1,cases:[command('old','0'.repeat(64))]},digest:'old',approvedAt:'past'});await writeFile(dir+'/approved.json',original);await prepareMigration(project,{review:async()=>{}});
 let approvals=0;const io={ask:async()=>'n',write:(_s:string)=>{}},approve=async(_project:string,file:string)=>{approvals++;assert.equal(JSON.parse(await readFile(file,'utf8')).cases[0].steps[0].serverRuntime,SERVER_DIGEST);};
 await approveMigration(project,io,approve);assert.equal(approvals,0);assert.equal(await readFile(dir+'/approved.json','utf8'),original);
 await approveMigration(project,{...io,ask:async()=>'y'},approve);assert.equal(approvals,1);
 await writeFile(dir+'/migration/approval-proposal.json','{"changed":true}');await assert.rejects(approveMigration(project,{...io,ask:async()=>'y'},approve),/proposal changed/);assert.equal(approvals,1);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('a new migration epoch archives the previous journal and independently reviews new changes',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'migration-epoch-')),project=root+'/project',dir=project+'-harness/acceptance';await mkdir(project);await mkdir(dir,{recursive:true});
 try{await writeFile(dir+'/draft.json',JSON.stringify({version:1,cases:[command('first','0'.repeat(64))]}));let calls=0;const review=async()=>{calls++;};await prepareMigration(project,{review});const original=await readFile(dir+'/migration/journal.json','utf8');
 await writeFile(dir+'/draft.json',JSON.stringify({version:1,cases:[command('second','1'.repeat(64))]}));await assert.rejects(prepareMigration(project,{review}),/changed during migration/);
 await prepareMigration(project,{review,restart:true});assert.equal(calls,2);const {readdir}=await import('node:fs/promises');const archive=await readdir(dir+'/migration/history');assert.equal(archive.length,1);assert.equal(await readFile(dir+'/migration/history/'+archive[0],'utf8'),original);
 }finally{await rm(root,{recursive:true,force:true});}
});
