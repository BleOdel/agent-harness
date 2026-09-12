import {scaffoldDesktop} from './desktop-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,readFile,cp} from 'node:fs/promises';
import {inspectDesktop,desktopDocker} from '../src/desktop/runtime.ts';
import {saveApproval,readDesktopRun,runRoot,saveDesktopRun} from '../src/desktop/store.ts';
import {verifyDesktop,exportDesktop,releaseDesktop,recoverDesktop} from '../src/desktop/controller.ts';
import {notesJourney} from '../src/desktop/scaffold.ts';
import {artifactBytes,listArtifacts} from '../src/artifacts/store.ts';
import {run} from '../src/run.ts';
import {artifactsCommand} from '../src/verbs/artifacts.ts';
import {setTimeout as delay} from 'node:timers/promises';
const configured=!!process.env.HARNESS_DESKTOP_IMAGE_ID;
test('real packaged desktop: keyboard save, restart persistence, PNG, exact export and rejected wrong expectation', {skip:!configured,timeout:180000}, async t=>{
 const root=await mkdtemp('/private/tmp/desktop-e2e-'),project=root+'/app';t.after(()=>rm(root,{recursive:true,force:true}));await scaffoldDesktop(project);
 const runtime=await inspectDesktop(),approval=await saveApproval(project,notesJourney,runtime),before=await readFile(project+'/src/store.cjs','utf8');
 const j=await verifyDesktop(project,approval.id);assert.equal(j.status,'passed',j.message);assert.equal(j.assessment?.checks,5);assert.equal(await readFile(project+'/src/store.cjs','utf8'),before);
 const all=await listArtifacts(project),png=all.find(a=>a.producer===j.id&&a.name.endsWith('.png'));assert.ok(png);assert.equal((await artifactBytes(project,png.id)).subarray(1,4).toString(),'PNG');
 await exportDesktop(project,j.id,root+'/export');assert.deepEqual(await readFile(root+'/export/app.asar'),await artifactBytes(project,j.package!));assert.equal(JSON.parse(await readFile(root+'/export/runtime.json','utf8')).runtime.image,runtime.image);
 await assert.rejects(exportDesktop(project,j.id,root+'/export'),/exist/);
 await assert.rejects(artifactsCommand(project,['release',j.id,'--yes']),/Cannot release/);
 const source=j.source;j.source='c'.repeat(64);await saveDesktopRun(project,j);await assert.rejects(exportDesktop(project,j.id,root+'/wrong-source'),/identity/);j.source=source!;await saveDesktopRun(project,j);
 const changedRuntime=await saveApproval(project,notesJourney,{...runtime,protocol:'d'.repeat(64)});await assert.rejects(verifyDesktop(project,changedRuntime.id),/runtime|protocol/);
 const wrong=structuredClone(notesJourney);(wrong.steps[2] as {expected:string}).expected='This never appears';const badApproval=await saveApproval(project,wrong,runtime),bad=await verifyDesktop(project,badApproval.id);assert.equal(bad.status,'failed');await assert.rejects(exportDesktop(project,bad.id,root+'/bad'),/passed/);
 const missing=structuredClone(notesJourney);missing.timeoutSeconds=5;missing.steps=[{action:'text',selector:'#missing',expected:'never'}];const short=await saveApproval(project,missing,runtime),timeout=await verifyDesktop(project,short.id);assert.equal(timeout.status,'failed');assert.match(timeout.message,/timed out|failed/);
 const containers=await run(desktopDocker(),['ps','-aq','--filter',`label=harness.desktop=${timeout.id}`]);assert.equal(containers.stdout.trim(),'');
 await releaseDesktop(project,j.id);assert.equal((await readDesktopRun(project,j.id)).status,'released');await assert.rejects(exportDesktop(project,j.id,root+'/released'),/passed/);
});
test('desktop detects missing persistence in a real restarted app', {skip:!configured,timeout:90000}, async t=>{
 const root=await mkdtemp('/private/tmp/desktop-negative-'),project=root+'/app';t.after(()=>rm(root,{recursive:true,force:true}));await scaffoldDesktop(project);
 await writeFile(project+'/src/store.cjs',"let notes=[];exports.load=async()=>notes;exports.add=async(_,title)=>{notes.push(title.trim());return notes;};");
 const a=await saveApproval(project,notesJourney,await inspectDesktop()),j=await verifyDesktop(project,a.id);assert.equal(j.status,'failed');assert.match(j.message,/failed|approved text|visible/);
});

test('desktop refuses live source changes and captures renderer errors', {skip:!configured,timeout:90000},async t=>{
 const root=await mkdtemp('/private/tmp/desktop-errors-'),project=root+'/app';t.after(()=>rm(root,{recursive:true,force:true}));await scaffoldDesktop(project);
 const a=await saveApproval(project,{...notesJourney,steps:[{action:'text',selector:'h1',expected:'A little space to remember.'}]},await inspectDesktop());
 const running=verifyDesktop(project,a.id,phase=>{if(phase.startsWith('ui:'))void writeFile(project+'/changed.txt','new live source');});
 assert.match((await running).message,/live project.*changed/);
 const renderer=await readFile(project+'/src/renderer.js','utf8');await writeFile(project+'/src/renderer.js',renderer+"\nthrow new Error('renderer crash fixture');\n");
 const failed=await verifyDesktop(project,a.id);assert.equal(failed.status,'failed');assert.match(failed.message,/renderer crash fixture/);
 const pkg=JSON.parse(await readFile(project+'/package.json','utf8'));pkg.main='missing.cjs';await writeFile(project+'/package.json',JSON.stringify(pkg));const missing=await verifyDesktop(project,a.id);assert.equal(missing.status,'failed');assert.match(missing.message,/main entry is missing/);
});
