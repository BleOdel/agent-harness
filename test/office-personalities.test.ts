import assert from 'node:assert/strict';
import test from 'node:test';
import {officeModel,avatarSvg,renderOffice,OFFICE_STYLE} from '../src/view/office.ts';
import type {TeamView} from '../src/view/status.ts';
import {workstyle} from '../src/view/office-sprites.ts';
const team=(count:number,phase='building'):TeamView=>({runId:'team-people',status:'running',live:true,elapsedMs:0,costUsd:0,tokens:0,steering:[],tasks:Array.from({length:count},(_,i)=>({id:`task-${i}`,role:i===0?'documentation':i===1?'designer':'backend',waitingFor:[]})),attempts:Array.from({length:count},(_,i)=>({id:`a-${i}`,task:`task-${i}`,role:i===0?'documentation':i===1?'designer':'backend',phase,elapsedMs:0,gates:[],review:'pending',integration:'pending',models:[]}))});

test('all displayed assignments have unique names and distinct character designs, including large rosters',()=>{
 const model=officeModel([team(80,'reviewing')]);
 assert.equal(new Set(model.agents.map(a=>a.name)).size,model.agents.length);
 assert.equal(new Set(model.agents.map(a=>avatarSvg(a))).size,model.agents.length);
});

test('names and appearances survive roster reordering, reviewer arrival, and task retries',()=>{
 const before=officeModel([team(6)]).agents;
 const t=team(6,'reviewing');t.tasks.reverse();t.attempts.reverse();
 const after=officeModel([t]);
 for(const a of before){const found=after.agents.find(b=>b.task===a.task&&b.kind===a.kind)!;assert.equal(a.name,found.name);assert.equal(a.variant,found.variant);}
 t.attempts=t.attempts.map(a=>({...a,id:`retry-${a.id}`}));
 for(const a of after.agents){const found=officeModel([t]).agents.find(b=>b.task===a.task&&b.kind===a.kind)!;assert.equal(a.name,found.name);assert.equal(a.variant,found.variant);}
});

test('active builders and document workers use seated keyboard poses and role-specific computer displays',()=>{
 const html=renderOffice(officeModel([team(3)]),false);
 assert.match(html,/data-workstyle="writer"/);
 assert.match(html,/data-workstyle="developer"/);
 assert.match(html,/data-pose="typing"/);
 assert.match(html,/screen-document/);
 assert.match(html,/screen-code/);
 const stopped=renderOffice(officeModel([{...team(3),live:false}]),false);
 assert.doesNotMatch(stopped,/data-pose="typing"/);
});

test('cat and hovering companion are decorative, excluded from worker counts, and covered by motion controls',()=>{
 const model=officeModel([]);const html=renderOffice(model,false);
 assert.equal(model.agents.length,0);assert.match(html,/0 active agents/);
 assert.match(html,/Pip.*office cat/);assert.match(html,/Orbit.*companion/);
 assert.match(html,/cat-tail/);assert.match(html,/office-hover/);
 assert.match(OFFICE_STYLE,/prefers-reduced-motion/);
 assert.match(OFFICE_STYLE,/office-paused[^}]*companion/);
 assert.match(renderOffice(officeModel([],undefined,false),false),/office-map office-still/);
 for(const state of ['office-paused','office-disconnected','office-still']) {
  assert.match(OFFICE_STYLE,new RegExp(`\\.${state} \\.office-companion[^}]*animation:none!important`));
  assert.match(OFFICE_STYLE,new RegExp(`\\.${state} \\.cat-tail-b[^}]*visibility:hidden`));
 }
});

test('role styling honours explicit roles and interprets documentation tasks without confusing Docker for docs',()=>{
 assert.equal(workstyle({kind:'builder',role:'builder',task:'write-docs'}),'writer');
 assert.equal(workstyle({kind:'builder',role:'builder',task:'Docker integration'}),'developer');
 assert.equal(workstyle({kind:'builder',role:'qa',task:'check docs'}),'tester');
 assert.equal(workstyle({kind:'reviewer',role:'documentation reviewer'}),'reviewer');
});

test('ordinary work keeps its persona across retries and a review arrival',()=>{
 const status={at:'2026-09-12',startedAt:'2026-09-12',pid:1,item:'write-docs',attempt:1,phase:'building' as const,turns:1,gates:[]};
 const before=officeModel([],{live:true,reason:undefined,status}).agents[0]!;
 const after=officeModel([],{live:true,reason:undefined,status:{...status,attempt:2,phase:'reviewing'}}).agents.find(a=>a.kind==='builder')!;
 assert.equal(before.name,after.name);assert.equal(before.variant,after.variant);
});
