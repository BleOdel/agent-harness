/** Explicitly enabled real VM trials. Never enabled by ordinary product reporting. */
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {scaffoldDesktop} from './desktop-fixture.ts';import {notesJourney} from '../src/desktop/scaffold.ts';
import {appleScaffold,appleNotesJourney} from '../src/native/apple/scaffold.ts';
import {readGuiRuntime} from '../src/native/gui/provision.ts';import {readAppleRuntime} from '../src/native/apple/runtime.ts';
import {approveGui} from '../src/native/gui/store.ts';import {approveApple} from '../src/native/apple/store.ts';
import {verifyGui} from '../src/native/gui/controller.ts';import {verifyApple} from '../src/native/apple/controller.ts';
import {desktopChoices,collectEvidence} from '../src/product/evidence/desktop.ts';import {evidenceStatus} from '../src/product/evidence/schema.ts';
import {approveProduct,draftProduct} from '../src/product/spec.ts';import {productReport} from '../src/product/report.ts';
for(const framework of ['electron','swiftui','appkit'] as const)test(`real ${framework}: product report aggregates packaged Mac evidence and rejects a wrong expectation`,{skip:!process.env.HARNESS_VERIFY_PRODUCT_MACOS,timeout:720000},async t=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'product-macos-live-'))),project=root+'/app';
 // Never delete unfinished native state: it holds the ownership needed for recovery.
 let safeToRemove=false;t.after(async()=>{if(safeToRemove)await rm(root,{recursive:true,force:true});else console.log('Retained native trial for inspection/recovery: '+root);});
 if(framework==='electron')await scaffoldDesktop(project);else{await mkdir(project);for(const [file,text]of await appleScaffold(framework)){await mkdir(path.dirname(project+'/'+file),{recursive:true});await writeFile(project+'/'+file,text);}await writeFile(project+'/package.json','{"name":"native-evidence-trial","version":"1.0.0"}');}
 await writeFile(project+'/features.json',JSON.stringify([{id:'notes',title:'Notes',priority:'must',status:'done',criteria:['Save and reopen notes'],dependsOn:[]}]));
 const runtime=framework==='electron'?await readGuiRuntime():await readAppleRuntime();
 const journey=framework==='electron'?{...notesJourney,timeoutSeconds:300}:appleNotesJourney;
 const a=framework==='electron'?await approveGui(project,journey,runtime as Awaited<ReturnType<typeof readGuiRuntime>>):await approveApple(project,journey,runtime);
 const scope={version:1 as const,targets:[(await desktopChoices(project)).find(c=>c.target.approval===a.id)!.target]};await approveProduct(project,await draftProduct(project,'desktop','prototype',[],scope));
 const notify=(s:string)=>console.log(framework+': '+s);
 const good=framework==='electron'?await verifyGui(project,a.id,notify):await verifyApple(project,a.id,notify);assert.equal(good.status,'passed',good.message);
 const report=await productReport(project),check=report.checks.find(c=>c.id.startsWith('runtime:'));assert.equal(check?.status,'passed',check?.detail);assert.equal(check?.evidence?.producer,good.id);assert.equal(report.ready,false);
 const wrong=structuredClone(journey);const step=wrong.steps.find(s=>s.action==='text')!;if(step.action==='text')step.expected='Deliberately wrong native observation';
 const b=framework==='electron'?await approveGui(project,wrong,runtime as Awaited<ReturnType<typeof readGuiRuntime>>):await approveApple(project,wrong,runtime);
 const bad=framework==='electron'?await verifyGui(project,b.id,notify):await verifyApple(project,b.id,notify);assert.equal(bad.status,'failed',bad.message);
 const badScope={version:1 as const,targets:[(await desktopChoices(project)).find(c=>c.target.approval===b.id)!.target]};const evidence=await collectEvidence(project,bad.source!,badScope);assert.notEqual(evidenceStatus(evidence.records[0]!),'passed');
 assert.equal((await productReport(project)).checks.find(c=>c.id.startsWith('runtime:'))?.status,'passed');safeToRemove=true;
});
