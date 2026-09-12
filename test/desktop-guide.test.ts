import {run} from '../src/run.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,readFile} from 'node:fs/promises';
import {desktopSetup,guideDesktop} from '../src/guide/desktop.ts';
import {init} from '../src/verbs/init.ts';
import {listApprovals} from '../src/desktop/store.ts';
import type {Dialogue} from '../src/guide/dialogue.ts';
const runtime={image:'sha256:'+'a'.repeat(64),arch:'arm64',electron:'44.3.0',playwright:'1.63.0',asar:'4.3.0',node:'v26.5.0',protocol:'b'.repeat(64)};
function dialogue(answers:string[]){const lines:string[]=[];return {lines,io:{write:(message:string)=>{lines.push(message);},ask:async(question:string)=>{lines.push(question);assert.ok(answers.length,question);return answers.shift()!;},close:()=>{}}} as {lines:string[];io:Dialogue};}
test('guided desktop setup reviews default journey, requires approval and selects saved work by title',async t=>{
 const root=await mkdtemp('/private/tmp/desktop-guide-'),project=root+'/app';await mkdir(project);t.after(()=>rm(root,{recursive:true,force:true}));
 const cancelled=dialogue(['1','no']);await desktopSetup(project,cancelled.io,async()=>runtime);assert.equal((await listApprovals(project)).length,0);
 const d=dialogue(['1','yes']);await desktopSetup(project,d.io,async()=>runtime);assert.equal((await listApprovals(project)).length,1);assert.ok(d.lines.some(s=>s.includes('My first desktop note')));
 const calls:string[][]=[],menu=dialogue(['3','1','0']);await guideDesktop(project,menu.io,async(_project,args)=>{calls.push([...args]);return 0;});assert.equal(calls[0]?.[0],'desktop');assert.equal(calls[0]?.[1],'verify');assert.match(calls[0]?.[2]??'',/^journey-/);
});
test('desktop init creates usable files, refuses overwrite and does not add dependencies',async t=>{
 const root=await mkdtemp('/private/tmp/desktop-init-');t.after(()=>rm(root,{recursive:true,force:true}));await init(root,['--desktop']);
 const p=JSON.parse(await readFile(root+'/package.json','utf8'));assert.equal(p.main,'src/main.cjs');assert.equal(p.dependencies,undefined);await assert.rejects(init(root,['--desktop']),/already/);
 const {NODE_TEST_CONTEXT:_,NODE_OPTIONS:__,...env}=process.env;
 const tests=await run(process.execPath,['--test',root+'/test/*.test.js'],{timeoutMs:10000,env});assert.equal(tests.code,0,tests.stderr);assert.match(tests.stdout,/tests 1/);
});
