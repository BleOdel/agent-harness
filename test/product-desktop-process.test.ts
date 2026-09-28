/** Real retained artifacts, independent of synthetic provenance fixtures. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {scaffoldDesktop} from './desktop-fixture.ts';
import {inspectDesktop} from '../src/desktop/runtime.ts';
import {saveApproval} from '../src/desktop/store.ts';
import {verifyDesktop} from '../src/desktop/controller.ts';
import {notesJourney} from '../src/desktop/scaffold.ts';
import {desktopChoices,collectEvidence} from '../src/product/evidence/desktop.ts';
import {evidenceStatus} from '../src/product/evidence/schema.ts';
import {draftProduct,approveProduct} from '../src/product/spec.ts';
import {productReport} from '../src/product/report.ts';
test('real Linux packaged journey is aggregated and a persistence regression cannot pass',{skip:!process.env.HARNESS_VERIFY_PRODUCT_DESKTOP,timeout:180000},async t=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'product-desktop-live-'))),project=root+'/app';t.after(()=>rm(root,{recursive:true,force:true}));await scaffoldDesktop(project);
 await writeFile(project+'/features.json',JSON.stringify([{id:'notes',title:'Notes',priority:'must',status:'done',criteria:['Notes survive restart'],dependsOn:[]}]));
 const a=await saveApproval(project,notesJourney,await inspectDesktop());
 const scope={version:1 as const,targets:[(await desktopChoices(project))[0]!.target]};await approveProduct(project,await draftProduct(project,'desktop','prototype',[],scope));
 const good=await verifyDesktop(project,a.id);assert.equal(good.status,'passed',good.message);
 const report=await productReport(project),check=report.checks.find(c=>c.id.startsWith('runtime:'));assert.equal(check?.status,'passed',check?.detail);assert.equal(check?.evidence?.producer,good.id);assert.ok(check?.evidence?.artifacts.some(a=>a.name==='app.asar'));assert.equal(report.ready,false);
 const store=await readFile(project+'/src/store.cjs');
 await writeFile(project+'/src/store.cjs',"let notes=[];exports.load=async()=>notes;exports.add=async(_,title)=>{notes.push(title.trim());return notes;};");
 const bad=await verifyDesktop(project,a.id);assert.equal(bad.status,'failed',bad.message);
 assert.notEqual(evidenceStatus((await collectEvidence(project,bad.source!,scope)).records[0]!),'passed');
 await writeFile(project+'/src/store.cjs',store);
 assert.equal((await productReport(project)).checks.find(c=>c.id.startsWith('runtime:'))?.status,'passed');
});
