import test from 'node:test';
import assert from 'node:assert/strict';
import { officeModel, renderOffice, OFFICE_STYLE } from '../src/view/office.ts';
import type { TeamView, LiveStatus } from '../src/view/status.ts';
const live: LiveStatus={live:true,reason:undefined,status:{at:new Date().toISOString(),startedAt:new Date().toISOString(),pid:1,item:'Build a blog',attempt:1,phase:'building',turns:4,gates:[]}};
const team=(phase='building',active=true):TeamView=>({runId:'team-1',status:active?'running':'interrupted',live:active,elapsedMs:1000,costUsd:0,tokens:0,tasks:[{id:'api',role:'backend',waitingFor:[]}],attempts:[{id:'a1',task:'api',role:'backend',phase,elapsedMs:1000,gates:[],review:'pending',integration:'pending',models:[]}],steering:[]});

test('office animates only actual live model phases; gates and application have no working agents',()=>{
 assert.equal(officeModel([],live).agents.filter(a=>a.active).length,1);
 for(const phase of ['gating','applying','idle'] as const){
  const model=officeModel([],{...live,status:{...live.status!,phase}});
  assert.equal(model.agents.some(a=>a.active),false,phase);
 }
 for(const phase of ['gating','integrating','preparing','integrated']) assert.equal(officeModel([team(phase)]).agents.some(a=>a.active),false,phase);
 assert.equal(officeModel([team('building',false)]).agents.some(a=>a.active),false);
});

test('active reviewers use the boardroom without suggesting builders participate',()=>{
 const model=officeModel([team('reviewing')]);
 assert.equal(model.agents.filter(a=>a.active&&a.location==='review').length,1);
 assert.equal(model.agents.filter(a=>a.kind==='builder').every(a=>!a.active),true);
 assert.match(renderOffice(model),/Independent reviews/);
});

test('latest attempt replaces previous attempts for a task and distinct teams remain distinct',()=>{
 const t=team();t.attempts.unshift({...t.attempts[0]!,id:'old',phase:'failed'});
 const model=officeModel([t,{...team(),runId:'team-2'}]);
 assert.equal(model.agents.filter(a=>a.kind==='builder').length,2);
 assert.equal(new Set(model.agents.map(a=>a.id)).size,model.agents.length);
 assert.equal(model.agents.some(a=>a.id.includes('old')),false);
});

test('office roster escapes project text and keeps overflow available',()=>{
 const t=team();t.tasks[0]!.id='<script>alert(1)</script>';t.attempts[0]!.task=t.tasks[0]!.id;
 const model=officeModel(Array.from({length:7},(_,i)=>({...t,runId:`team-${i}`})));
 const html=renderOffice(model);
 assert.match(html,/&lt;script&gt;/);
 assert.doesNotMatch(html,/<script>alert/);
 assert.equal((html.match(/data-office-select=/g)??[]).length>=model.agents.length,true);
 assert.match(html,/More agents/);
 assert.match(OFFICE_STYLE,/prefers-reduced-motion/);
});

test('saved snapshots are still and empty offices do not invent workers',()=>{
 assert.equal(officeModel([]).agents.length,0);
 assert.match(renderOffice(officeModel([])),/No agent activity recorded/);
 assert.equal(officeModel([team()],undefined,false).agents.some(a=>a.active),false);
});

test('handoffs require a recorded build-to-review transition and are not replayed as live after interruption', async()=>{
 const {reviewHandoffEvents}=await import('../src/view/status.ts');
 const at=new Date().toISOString();
 const events=reviewHandoffEvents([{seq:1,at,type:'phase',phase:'reviewing',attemptId:'unrelated'},{seq:2,at,type:'phase',phase:'building',attemptId:'a1'},{seq:3,at,type:'phase',phase:'gating',attemptId:'a1'},{seq:4,at,type:'phase',phase:'reviewing',attemptId:'a1'}]);
 assert.deepEqual(events,[{id:'4',at,attemptId:'a1'}]);
 const t={...team('reviewing'),reviewHandoffs:events};
 const running=officeModel([t]);assert.equal(running.handoffs[0]?.active,true);
 assert.equal(officeModel([{...t,live:false}]).handoffs[0]?.active,false);
 assert.equal(officeModel([t],undefined,false).handoffs[0]?.active,false);
 assert.doesNotMatch(renderOffice(running,false),/data:image/,'poll responses must not resend the background');
 assert.match(renderOffice(running),/data:image\/png;base64,/,'saved pages carry the room artwork');
});

test('avatars preserve identity through phase changes and offer male and female artwork with reviewer accessories', async()=>{
 const {avatarSvg}=await import('../src/view/office.ts');
 const building=officeModel([team('building')]).agents[0]!;
 const reviewing=officeModel([team('reviewing')]).agents.find(a=>a.kind==='builder')!;
 assert.equal(building.id,reviewing.id);assert.equal(building.name,reviewing.name);assert.equal(building.variant,reviewing.variant);
 assert.notEqual(avatarSvg({variant:0,kind:'builder',role:'builder'}),avatarSvg({variant:1,kind:'builder',role:'builder'}));
 assert.notEqual(avatarSvg({variant:1,kind:'builder',role:'builder'}),avatarSvg({variant:1,kind:'reviewer',role:'reviewer'}));
 assert.match(OFFICE_STYLE,/office-disconnected/);assert.match(OFFICE_STYLE,/office-paused/);
});

test('office selection, pause and identical-data reconnection remain usable through live updates',async()=>{
 const {runInNewContext}=await import('node:vm');
 const {OFFICE_SCRIPT}=await import('../src/view/office.ts');
 const attrs=new Map<string,string>(), classes=new Map<string,boolean>();let hidden=false,helpHidden=false,stats='active';
 const button={getAttribute:(k:string)=>k==='data-office-select'?'agent':attrs.get(k),setAttribute:(k:string,v:string)=>attrs.set(k,v)};
 const detail={get hidden(){return hidden;},set hidden(v:boolean){hidden=v;},getAttribute:()=> 'agent'};
 const handlers:Record<string,(e?:unknown)=>void>={};
 const root={querySelectorAll:(s:string)=>s==='[data-office-select]'?[button]:s==='[data-office-detail]'?[detail]:[],querySelector:(s:string)=>s==='.office-select-help'?{set hidden(v:boolean){helpHidden=v;}}:s==='.office-stats'?{set textContent(v:string){stats=v;}}:null,contains:(target:unknown)=>target===button,addEventListener:(name:string,fn:(e?:unknown)=>void)=>{handlers[name]=fn;},set innerHTML(_value:string){stats='active';}};
 const motion={addEventListener:(_name:string,fn:()=>void)=>{handlers.pause=fn;},setAttribute:(k:string,v:string)=>attrs.set('motion-'+k,v),textContent:''};
 const section={classList:{toggle:(k:string,v:boolean)=>classes.set(k,v)}};
 const window: {updateHarnessOffice?: (html:string|null,connected:boolean)=>void}={};
 runInNewContext(OFFICE_SCRIPT.replace(/^<script>|<\/script>$/g,''),{window,document:{activeElement:null,getElementById:(id:string)=>id==='office-root'?root:id==='office'?section:motion}});
 handlers.click!({target:{closest:()=>button}});assert.equal(hidden,false);assert.equal(helpHidden,true);assert.equal(attrs.get('aria-pressed'),'true');
 handlers.pause!();assert.equal(classes.get('office-paused'),true);assert.equal(motion.textContent,'Resume animation');
 window.updateHarnessOffice!('same',true);window.updateHarnessOffice!(null,false);assert.match(stats,/unconfirmed/);assert.equal(classes.get('office-disconnected'),true);
 window.updateHarnessOffice!('same',true);assert.equal(stats,'active');assert.equal(classes.get('office-disconnected'),false);assert.equal(attrs.get('aria-pressed'),'true');
 handlers.pause!();assert.equal(classes.get('office-paused'),false);
});

test('handoff animation happens once for a new recent event, never for initial, historical or inactive events',async()=>{
 const {runInNewContext}=await import('node:vm');const {OFFICE_SCRIPT}=await import('../src/view/office.ts');
 const at=new Date().toISOString();let events=[{id:'first',at,active:'true'}];const envelope={hidden:true};
 const root={querySelectorAll:(s:string)=>s==='[data-handoff]'?events.map(e=>({getAttribute:(key:string)=>key==='data-handoff'?e.id:key==='data-at'?e.at:e.active})):[],querySelector:(s:string)=>s==='.office-envelope'?envelope:null,contains:()=>false,addEventListener:()=>{},set innerHTML(_html:string){envelope.hidden=true;}};
 const window:{updateHarnessOffice?:(html:string,connected:boolean)=>void}={};
 runInNewContext(OFFICE_SCRIPT.replace(/^<script>|<\/script>$/g,''),{window,document:{activeElement:null,getElementById:(id:string)=>id==='office-root'?root:id==='office'?{classList:{toggle:()=>{}}}:{addEventListener:()=>{}}}});
 assert.equal(envelope.hidden,true);
 window.updateHarnessOffice!('first poll',true);assert.equal(envelope.hidden,true);
 events.push({id:'next',at,active:'true'});window.updateHarnessOffice!('new event',true);assert.equal(envelope.hidden,false);
 window.updateHarnessOffice!('another telemetry update',true);assert.equal(envelope.hidden,true);
 events.push({id:'old',at:'2000-01-01T00:00:00Z',active:'true'});window.updateHarnessOffice!('old event',true);assert.equal(envelope.hidden,true);
 events.push({id:'inactive',at,active:'false'});window.updateHarnessOffice!('inactive event',true);assert.equal(envelope.hidden,true);
});
