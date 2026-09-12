import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir,symlink,readFile} from 'node:fs/promises';
import {saveApproval,readApproval,newRun,readDesktopRun,saveDesktopRun,desktopRoot} from '../src/desktop/store.ts';
import {boundedOutput,validatePng} from '../src/desktop/output.ts';
import {notesJourney} from '../src/desktop/scaffold.ts';
const runtime={image:'sha256:'+'a'.repeat(64),arch:'arm64',electron:'44.3.0',playwright:'1.63.0',asar:'4.3.0',node:'v26.5.0',protocol:'b'.repeat(64)};
test('desktop approvals detect edits and reports bind to approved runtime/source',async t=>{
 const root=await mkdtemp('/private/tmp/desktop-state-'),project=root+'/app';await mkdir(project);t.after(()=>rm(root,{recursive:true,force:true}));
 const a=await saveApproval(project,notesJourney,runtime);assert.deepEqual((await readApproval(project,a.id)).journey,a.journey);
 const j=await newRun(project,a,'/usr/local/bin/docker');assert.equal((await readDesktopRun(project,j.id)).status,'preparing');
 j.source='c'.repeat(64);await saveDesktopRun(project,j);assert.equal((await readDesktopRun(project,j.id)).source,j.source);
 const file=(await desktopRoot(project))+'/approvals/'+a.id+'.json';const changed=JSON.parse(await readFile(file,'utf8'));changed.journey.steps[2].expected='forged';await writeFile(file,JSON.stringify(changed));
 await assert.rejects(readApproval(project,a.id),/identity|changed/);await assert.rejects(readDesktopRun(project,'../escape'),/Invalid/);
});
test('desktop outputs reject aliases, excessive bytes and malformed PNGs before retention',async t=>{
 const root=await mkdtemp('/private/tmp/desktop-output-');t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(root+'/small','data');assert.equal((await boundedOutput(root,'small',4)).toString(),'data');
 await assert.rejects(boundedOutput(root,'small',3),/limit/);await symlink('small',root+'/alias');await assert.rejects(boundedOutput(root,'alias',4),/symlink/);
 assert.throws(()=>validatePng(Buffer.from('not a screenshot')),/PNG/);
});
