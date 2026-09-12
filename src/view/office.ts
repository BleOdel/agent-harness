import { readFileSync } from 'node:fs';
import { escape } from './render.ts';
import type { LiveStatus, TeamView } from './status.ts';
import { avatarSvg, personaName, workstyle, officeCompanions, COMPANION_STYLE } from './office-sprites.ts';
export { avatarSvg } from './office-sprites.ts';

export interface OfficeAgent {
  id: string; name: string; kind: 'builder' | 'reviewer'; role: string; task: string;
  phase: string; active: boolean; location: 'desk' | 'review' | 'lounge';
  variant: number; team?: string; attempt?: string; gates: readonly string[];
  review: string; integration: string; model: string; usage: string; skills?:string[]; observedReads?:string[]; workflowEvidence?:string[]; activity?:string[];
}
export interface OfficeHandoff { id: string; from: string; to: string; at: string; task: string; active: boolean; }
export interface OfficeModel { agents: OfficeAgent[]; handoffs: OfficeHandoff[]; system: string; live: boolean; }
const personaKey = (run:string,task:string,kind:string):string => JSON.stringify([run,task,kind]);
const title = (role: string): string => role.replaceAll(/[-_]/g,' ').replace(/^./, c=>c.toUpperCase());

/** Display identities represent assignments, never additional dispatched workers. */
export function officeModel(teams: readonly TeamView[], ordinary?: LiveStatus, live = true): OfficeModel {
  const agents: OfficeAgent[] = [], handoffs: OfficeHandoff[] = [];
  const system: string[] = [];
  // Reserve both roles up front, so a reviewer appearing or an attempt retry does
  // not rename existing people. Sorting makes incoming roster order irrelevant.
  const keys=teams.flatMap(t=>t.tasks.flatMap(task=>['builder','reviewer'].map(kind=>personaKey(t.runId,task.id,kind))));
  const ordinaryRun=ordinary?.status?`ordinary/${ordinary.status.startedAt}`:'';
  if(ordinary?.status) keys.push(...['builder','reviewer'].map(kind=>personaKey(ordinaryRun,ordinary.status!.item,kind)));
  const personas=new Map([...new Set(keys)].sort().map((key,index)=>[key,index]));
  function add(id: string, key:string, value: Omit<OfficeAgent,'id'|'name'|'variant'>): OfficeAgent {
    const variant=personas.get(key)!;
    const agent={id,name:personaName(variant),variant,...value}; agents.push(agent);return agent;
  }
  for(const team of teams){
    const current=new Map<string,TeamView['attempts'][number]>();
    for(const attempt of team.attempts) current.set(attempt.task,attempt);
    for(const task of team.tasks){
      const a=current.get(task.id), running=live&&team.live&&team.status==='running';
      const phase=a?.phase??(task.waitingFor.length?'waiting':'queued');
      const root=`${team.runId}/${a?.id??task.id}`;
      const common={task:task.id,team:team.runId,...(a?{attempt:a.id}:{}),gates:a?.gates??[],review:a?.review??'pending',integration:a?.integration??'pending'};
      const info=(role:string)=>{
        const m=a?.models.find(m=>m.role===role);
        return {skills:role==='builder'?a?.skills??[]:[],observedReads:role==='builder'?a?.observedReads??[]:[],workflowEvidence:role==='builder'?a?.workflowEvidence??[]:[],activity:a?.activity??[],model:m?`${m.provider??'unknown provider'}/${m.model??'unknown model'}`:'Not yet reported',usage:m?`${m.tokens.toLocaleString('en-GB')} tokens · $${m.costUsd.toFixed(4)} reported`:'Usage not reported'};
      };
      const building=running&&phase==='building';
      const builder=add(`${root}/builder`,personaKey(team.runId,task.id,'builder'),{...common,...info('builder'),kind:'builder',role:title(task.role),phase:!live?`${phase} (snapshot)`:running?(phase==='reviewing'?'awaiting review':phase):phase==='building'||phase==='reviewing'?'interrupted':phase,active:building,location:building||(!live&&phase==='building')?'desk':'lounge'});
      if(a&&(phase==='reviewing'||a.review!=='pending'||a.models.some(m=>m.role==='reviewer'))){
        const reviewing=running&&phase==='reviewing';
        const reviewer=add(`${root}/reviewer`,personaKey(team.runId,task.id,'reviewer'),{...common,...info('reviewer'),kind:'reviewer',role:`${title(task.role)} reviewer`,phase:reviewing?'reviewing':!live&&phase==='reviewing'?'reviewing (snapshot)':!running&&phase==='reviewing'?'interrupted':a.review==='pending'?'waiting':`review ${a.review}`,active:reviewing,location:reviewing||(!live&&phase==='reviewing')?'review':'lounge'});
        for(const event of team.reviewHandoffs??[]) if(event.attemptId===a.id) handoffs.push({id:`${team.runId}/${event.id}`,from:builder.id,to:reviewer.id,at:event.at,task:task.id,active:running&&phase==='reviewing'});
      }
      if(running&&['gating','integrating','preparing'].includes(phase)) system.push(`${task.id}: ${phase} (automated)`);
    }
  }
  if(ordinary?.status && ordinary.status.phase!=='idle'){
    const s=ordinary.status, active=live&&ordinary.live;
    const root=`ordinary/${s.startedAt}/${s.attempt}`;
    const common={task:s.item,gates:s.gates,activity:[`${s.at} · ${s.phase}${s.tool?` · ${s.tool}`:''}`],review:'See run history',integration:'Not applicable',model:'See run history',usage:s.tokens===undefined?'Usage not reported':`${s.tokens.toLocaleString('en-GB')} reported tokens`};
    add(`${root}/builder`,personaKey(ordinaryRun,s.item,'builder'),{...common,kind:'builder',role:'Builder',phase:!active?'stopped':s.phase==='reviewing'?'awaiting review':s.phase,active:active&&s.phase==='building',location:active&&s.phase==='building'?'desk':'lounge'});
    if(s.phase==='reviewing') add(`${root}/reviewer`,personaKey(ordinaryRun,s.item,'reviewer'),{...common,kind:'reviewer',role:'Reviewer',phase:active?'reviewing':'stopped',active,location:active?'review':'lounge'});
    if(active&&['gating','applying'].includes(s.phase)) system.push(`${s.phase==='gating'?'Verification checks':'Applying changes'} (automated)`);
  }
  agents.sort((a,b)=>Number(b.active)-Number(a.active)||a.id.localeCompare(b.id));
  return {agents,handoffs:handoffs.sort((a,b)=>a.at.localeCompare(b.at)).slice(-6),system:system.join(' · ')||'No automated checks running',live};
}

let room: string | undefined;
const roomImage = (): string => room ??= `data:image/png;base64,${readFileSync(new URL('./office-room.png', import.meta.url)).toString('base64')}`;
export function officeSection(model: OfficeModel, includeRoom=true): string {
  return `<section id="office" class="office-section" aria-label="Agent office"><div class="office-heading"><div><p class="eyebrow">Workspace / live floor</p><h2>The agent office</h2></div><div class="office-controls"><label>Zoom <select id="office-zoom"><option value="100">Fit</option><option value="125">125%</option><option value="150">150%</option><option value="200">200%</option></select></label><button type="button" class="action" id="office-inspector-toggle" aria-expanded="true">Hide inspector</button><button type="button" class="action" id="office-expand" aria-pressed="false">Expand office</button><button type="button" class="action" id="office-motion" aria-pressed="false">Pause animation</button></div></div><div id="office-root">${renderOffice(model,includeRoom)}</div><p class="office-footnote">Avatars represent saved assignments. The review room shows independent reviews, not a shared conversation.</p></section>`;
}

export function renderOffice(model: OfficeModel, includeRoom = true): string {
  const desk=[[22,42.7],[45.9,42.7],[22,71.1],[45.9,71.1]];
  const review=[[74,32.7],[86.2,32.7],[74,40.6],[86.2,40.6]];
  const lounge=[[73.5,74],[82,74],[76,85],[85,85]];
  const occupied={desk:0,review:0,lounge:0};
  const positioned=model.agents.map(a=>({a,slot:occupied[a.location]++}));
  const visible=positioned.filter(({slot})=>slot<4);
  const inspectors=model.agents.map(a=>`<article data-office-detail="${escape(a.id)}" hidden><p class="eyebrow">${escape(a.role)}</p><h3>${escape(a.name)}</h3><span class="badge">${escape(a.phase)}</span><h4>Current assignment</h4><p>${escape(a.task)}</p><p class="meta">${escape(a.model)}</p><p class="meta">${escape(a.usage)}</p><h4>Configured / frozen skills</h4><p class="meta">${escape(a.skills?.join(', ')||'No assignment skill selection recorded.')}</p><details data-state-key="agent-evidence"><summary>Skill evidence & activity</summary><p class="meta">A file read shows access, not compliance. Workflow evidence is agent-reported.</p><h4>Observed file reads</h4><ul>${(a.observedReads??[]).slice(-15).map(v=>`<li>${escape(v)}</li>`).join('')||'<li>No reads recorded.</li>'}</ul><h4>Reported workflow</h4><ul>${(a.workflowEvidence??[]).map(v=>`<li>${escape(v)}</li>`).join('')||'<li>No workflow report.</li>'}</ul><h4>Recorded activity</h4><ul>${(a.activity??[]).map(v=>`<li>${escape(v)}</li>`).join('')||'<li>No phase events recorded.</li>'}</ul></details><h4>Verification</h4><p>Review: ${escape(a.review)}<br>Integration: ${escape(a.integration)}</p>${a.gates.length?`<ul>${a.gates.map(g=>`<li>${escape(g)}</li>`).join('')}</ul>`:'<p class="meta">No checks reported for this assignment yet.</p>'}<a href="${a.team?'#teams':'#history'}">Open ${a.team?'team evidence':'run history'} →</a><details data-state-key="agent-identity"><summary>Recorded identity</summary><p class="team-id">${escape(a.id)}</p></details></article>`).join('');
  const events=model.handoffs.map(h=>`<p class="handoff-log" data-handoff="${escape(h.id)}" data-at="${escape(h.at)}" data-active="${h.active}"><span aria-hidden="true">▱</span> Candidate submitted for review · ${escape(h.task)}<small>${escape(h.at)}</small></p>`).join('');
  const active=model.agents.filter(a=>a.active).length;
  return `<div class="office-stats"><span><i class="status-light"></i> ${model.live?`${active} active agents`:'Saved positions · not live'}</span><span>${model.agents.filter(a=>a.active&&a.kind==='reviewer').length} reviewing</span><span>${model.agents.length} assigned</span><span class="office-system">${escape(model.system)}</span></div><div class="office-layout"><div><div class="office-viewport"><div class="office-map${model.live?'':' office-still'}">${includeRoom ? `<img src="${roomImage()}" width="1536" height="1024" alt="Pixel-art office with four workstations, a boardroom and a lounge">` : ""}${officeCompanions()}<span class="room-label floor-label">BUILD FLOOR</span><span class="room-label review-label">INDEPENDENT REVIEWS</span><span class="room-label lounge-label">ON STANDBY</span>${visible.map(({a,slot})=>{const [x,y]=(a.location==='desk'?desk:a.location==='review'?review:lounge)[slot]!;return `${a.active&&a.location==='desk'?`<span class="office-screen screen-${workstyle(a)==='writer'?'document':workstyle(a)==='designer'?'design':workstyle(a)==='tester'?'tests':'code'}" style="left:${x}%;top:${slot<2?27.5:55.9}%" aria-hidden="true"><i></i><i></i><i></i></span>`:''}<button type="button" class="office-person ${a.active?'working':''} ${a.location}" style="left:${x}%;top:${y}%" data-office-select="${escape(a.id)}" aria-pressed="false" aria-label="${escape(`${a.name}, ${a.role}: ${a.phase}. ${a.task}`)}">${avatarSvg(a)}<span class="avatar-name">${escape(a.name)}<small>${escape(a.role)}</small></span>${a.active?'<span class="activity-bubble" aria-hidden="true">•••</span>':''}</button>`;}).join('')}<span class="office-envelope" aria-hidden="true" hidden>▱</span></div></div><div class="office-legend"><span><i class="status-light"></i> Working at desk</span><span>▤ Independent reviews</span><span>○ Standby / completed</span>${positioned.length>visible.length?`<span>More agents: ${positioned.length-visible.length} in the roster →</span>`:''}</div>${events?`<details class="office-handoffs"><summary>Recorded handoffs · ${model.handoffs.length}</summary>${events}</details>`:''}</div><aside class="office-inspector"><p class="eyebrow">Agent inspector</p><div class="office-roster" aria-label="Agent roster">${model.agents.map(a=>`<button type="button" data-office-select="${escape(a.id)}" aria-pressed="false"><span class="roster-portrait">${avatarSvg({...a,active:false})}</span><span class="roster-dot ${a.active?'is-active':''}"></span><span>${escape(a.name)}<small>${escape(a.role)} · ${escape(a.phase)}</small></span></button>`).join('')}</div><div class="office-selection"><p class="office-select-help">${model.agents.length?'Select a person to see their task and checks.':'No agent activity recorded. Start work through harness guide; the office will follow its progress.'}</p>${inspectors}</div></aside></div>`;
}

export const OFFICE_STYLE=`${COMPANION_STYLE}
.roster-portrait{width:26px;flex:none}.roster-portrait .office-sprite{filter:none}.office-screen.screen-document{background:#eee4cc}.screen-document i{background:#6d7b7f}.office-screen.screen-document i:nth-child(2){background:#536975;width:70%}.screen-design i{height:3px;width:40%;background:#d5a1bc}.screen-tests i{background:#9fdf91}.office-screen:after{content:"";display:block;width:2px;height:2px;background:#fff4ce;animation:screen-cursor 1s steps(1) infinite}.screen-document:after{background:#556979}.office-paused .office-screen:after,.office-disconnected .office-screen:after{animation:none}.office-disconnected .office-screen{filter:grayscale(1)}
@keyframes screen-cursor{0%,49%{opacity:1}50%,100%{opacity:0}}
@media(prefers-reduced-motion:reduce){.office-screen:after{animation:none}}

.page-actions{display:flex;align-items:center;gap:.75rem}.connection{margin:.2rem 0;font-size:12px}#live-fig{display:none}.live{padding:.5rem .75rem;margin:.3rem 0}.office-heading .action{font-size:12px}main{max-width:120rem;grid-template-columns:170px minmax(0,1fr)}.workspace{padding:1.3rem 1.8rem 4rem}.page-head h1{font-size:1.6rem}.page-head .team-id{margin:.3rem 0}.page-head .eyebrow{display:none}.sub{margin:.3rem 0 .7rem}.snapshot{margin:.5rem 0;font-size:12px}.office-heading{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin:1rem 0}.office-heading h2{font-size:1.35rem}.office-heading .eyebrow{font-size:12px;margin-bottom:.25rem}.office-section{margin:1.5rem 0 2rem}.office-stats{display:flex;gap:1.3rem;align-items:center;flex-wrap:wrap;padding:.8rem 1rem;background:var(--card);border:1px solid var(--line);border-radius:10px 10px 0 0;font-size:14px}.office-system{overflow-wrap:anywhere;min-width:0;margin-left:auto;color:var(--dim);font-size:12px}.office-layout{display:grid;grid-template-columns:minmax(0,1fr) 245px;border:1px solid var(--line);border-top:0;border-radius:0 0 12px 12px;background:var(--card);overflow:hidden}.office-map{position:relative;aspect-ratio:3/2;background:#493a30;isolation:isolate}.office-map>img{display:block;width:100%;height:100%;image-rendering:pixelated}.room-label{position:absolute;background:#182d2edb;color:#f4db9b;padding:4px 8px;font:600 clamp(8px,1vw,12px)/1.3 ui-monospace,monospace;letter-spacing:.08em;pointer-events:none;border:1px solid #c59c5b66}.floor-label{left:4%;top:17%}.review-label{left:67%;top:15%}.lounge-label{left:69%;top:56%}.office-person{position:absolute;transform:translate(-50%,-100%);padding:0;width:6%;border:0;background:none;cursor:pointer;overflow:visible;color:white;z-index:2}.office-sprite{width:100%;display:block;filter:drop-shadow(1px 3px 0 #251c2077);image-rendering:pixelated}.avatar-name{position:absolute;left:50%;top:100%;transform:translateX(-50%);background:#19282fef;border:1px solid #e5c88b66;border-radius:3px;padding:2px 5px;font:600 clamp(10px,1vw,12px)/1.25 ui-monospace,monospace;white-space:nowrap;box-shadow:0 2px #0006}.avatar-name{max-width:180px;overflow:hidden;text-overflow:ellipsis}.avatar-name small{display:none;font-size:10px;font-weight:400}.office-person:hover,.office-person[aria-pressed=true]{z-index:4}.office-person:hover .avatar-name small,.office-person[aria-pressed=true] .avatar-name small{display:block}.office-person[aria-pressed=true] .avatar-name{border-color:#8ef2c6}.office-person:focus-visible{outline:2px solid #fff3c7;outline-offset:4px}.activity-bubble{position:absolute;right:-35%;top:-15%;font:12px/1 ui-monospace,monospace;background:#fcf1d5;color:#393948;padding:3px 4px;border:2px solid #302b3e}.pose-b{visibility:hidden}.working .pose-a{animation:office-a .44s steps(1) infinite}.working .pose-b{animation:office-b .44s steps(1) infinite}.working .activity-bubble{animation:office-think 1.2s steps(3) infinite}.office-envelope{position:absolute;left:44%;top:39%;font-size:24px;color:#fff5c7;text-shadow:2px 2px #503620;z-index:5;animation:office-send 2s steps(16) 1 forwards}.office-inspector{position:static;max-height:none;overflow:hidden;padding:1rem;border-left:1px solid var(--line)}.office-screen{position:absolute;width:4.5%;height:4.6%;transform:translate(-50%,-50%);background:#173746;border:1px solid #1b2734;box-shadow:0 0 8px #68d7bf66;padding:3px;overflow:hidden}.office-screen i{display:block;height:1px;background:#75dbce;margin:2px 0;width:80%}.office-screen i:nth-child(2){width:50%;background:#eec177}.office-inspector .eyebrow{font-size:12px}.office-roster{display:grid;gap:3px;max-height:170px;overflow:auto;margin-bottom:1rem}.office-roster button{display:flex;gap:9px;text-align:left;align-items:center;background:transparent;border:1px solid transparent;border-radius:6px;padding:7px;color:var(--fg);font-size:14px;cursor:pointer}.office-roster button[aria-pressed=true]{background:var(--bg);border-color:var(--accent)}.office-roster small{display:block;color:var(--dim);font-size:12px}.roster-dot,.status-light{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--dim);flex:none}.is-active,.status-light{background:#61c69c}.office-selection{font-size:14px;overflow-wrap:anywhere}.office-selection h3{font-size:1.35rem;text-transform:none;letter-spacing:0;color:var(--fg);margin:.25rem 0 .7rem}.office-selection h4{font-size:12px;letter-spacing:.05em;text-transform:uppercase;margin:1.2rem 0 .5rem;color:var(--dim)}.office-selection .meta,.office-selection li{font-size:12px}.office-select-help{color:var(--dim);line-height:1.7}.office-legend{padding:10px;display:flex;flex-wrap:wrap;gap:1rem;font-size:12px;color:var(--dim)}.office-footnote{font-size:12px;color:var(--dim);margin:.5rem 0}.office-handoffs{margin:0 1rem}.handoff-log{font-size:12px}.handoff-log small{display:block;color:var(--dim)}.office-paused .pose,.office-disconnected .pose{animation:none!important}.office-paused .pose-a,.office-disconnected .pose-a{visibility:visible}.office-paused .pose-b,.office-disconnected .pose-b{visibility:hidden}.office-paused .activity-bubble,.office-disconnected .activity-bubble{animation:none!important}.office-disconnected .activity-bubble{display:none}.office-paused .office-envelope,.office-disconnected .office-envelope{display:none}.office-section~.overview{margin-top:1.5rem}.office-section .office-layout>div{min-width:0}
@keyframes office-a{0%,49%{visibility:visible}50%,100%{visibility:hidden}}@keyframes office-b{0%,49%{visibility:hidden}50%,100%{visibility:visible}}@keyframes office-think{0%{opacity:.5}100%{opacity:1}}@keyframes office-send{0%{transform:translate(0,0);opacity:1}90%{left:78%;top:32%;opacity:1}100%{left:79%;top:32%;opacity:0}}
@media(prefers-reduced-motion:reduce){.working .pose,.working .activity-bubble{animation:none!important}.working .pose-a{visibility:visible}.working .pose-b{visibility:hidden}.office-envelope{display:none!important}}
@media(max-width:1050px){.office-layout{grid-template-columns:minmax(0,1fr) 210px}.office-inspector{padding:.8rem}.workspace{padding:1rem}.office-system{margin-left:0}}
@media(max-width:760px){main{display:block}.office-layout{grid-template-columns:1fr}.office-inspector{border-left:0;border-top:1px solid var(--line)}.office-roster{grid-template-columns:repeat(2,minmax(0,1fr));max-height:180px}.office-person{width:6.5%;min-width:26px}.office-person:before{content:"";position:absolute;inset:-9px}.office-heading{flex-wrap:wrap}.office-stats{gap:.6rem;font-size:12px}.office-selection h3{font-size:1.2rem}.room-label{font-size:8px;padding:2px 4px}}
`;

export const OFFICE_SCRIPT=`<script>
(function(){
  var root=document.getElementById('office-root'), section=document.getElementById('office');
  if(!root)return;
  var selected=null, paused=false, seen=new Set(), initial=true, lastHtml=null;
  function select(id,focus){
    selected=id;
    var exists=false;
    root.querySelectorAll('[data-office-select]').forEach(function(b){var on=b.getAttribute('data-office-select')===id;b.setAttribute('aria-pressed',String(on));if(on){exists=true;if(focus){b.focus();focus=false;}}});
    root.querySelectorAll('[data-office-detail]').forEach(function(d){d.hidden=d.getAttribute('data-office-detail')!==id;});
    var help=root.querySelector('.office-select-help');if(help)help.hidden=exists;
    if(!exists)selected=null;
  }
  root.addEventListener('click',function(e){var button=e.target.closest('[data-office-select]');if(button&&root.contains(button))select(button.getAttribute('data-office-select'),false);});
  var motion=document.getElementById('office-motion');
  motion.addEventListener('click',function(){paused=!paused;section.classList.toggle('office-paused',paused);motion.setAttribute('aria-pressed',String(paused));motion.textContent=paused?'Resume animation':'Pause animation';});
  function handoffs(){
    var fresh=false;
    root.querySelectorAll('[data-handoff]').forEach(function(el){var key=el.getAttribute('data-handoff'), age=Date.now()-Date.parse(el.getAttribute('data-at'));if(!seen.has(key)&&!initial&&el.getAttribute('data-active')==='true'&&age>=0&&age<15000)fresh=true;seen.add(key);});
    initial=false;
    var envelope=root.querySelector('.office-envelope');if(envelope)envelope.hidden=!fresh;
  }
  handoffs();
  window.updateHarnessOffice=function(html,connected){
    section.classList.toggle('office-disconnected',!connected);
    if(!connected){lastHtml=null;var stats=root.querySelector('.office-stats');if(stats)stats.textContent='Connection lost · activity unconfirmed';return;}
    if(typeof html!=='string')return;
    if(html!==lastHtml){
      var focused=root.contains(document.activeElement)?document.activeElement.getAttribute('data-office-select'):null;
      var background=root.querySelector('.office-map>img');
      var companions=root.querySelector('.office-companions');
      var viewport=root.querySelector('.office-viewport'), oldMap=root.querySelector('.office-map');
      var zoom=oldMap?.style.width, left=viewport?.scrollLeft, top=viewport?.scrollTop;
      function detailKey(d){return d.closest('[data-office-detail]').getAttribute('data-office-detail')+'/'+d.getAttribute('data-state-key');}
      var evidence=Array.from(root.querySelectorAll('[data-office-detail] details[open]')).map(detailKey);
      var activeDetail=root.contains(document.activeElement)?document.activeElement.closest('[data-office-detail] details'):null;
      var focusDetail=activeDetail?detailKey(activeDetail):null;
      var roster=root.querySelector('.office-roster'), rosterScroll=roster?.scrollTop;
      var rosterFocus=focused && document.activeElement.closest('.office-roster');
      root.innerHTML=html;
      var map=root.querySelector('.office-map');if(map&&background)map.prepend(background);
      var nextCompanions=root.querySelector('.office-companions');if(companions&&nextCompanions)nextCompanions.replaceWith(companions);
      if(map&&zoom)map.style.width=zoom;
      var nextViewport=root.querySelector('.office-viewport');if(nextViewport){nextViewport.scrollLeft=left||0;nextViewport.scrollTop=top||0;}
      root.querySelectorAll('[data-office-detail] details').forEach(function(d){d.open=evidence.indexOf(detailKey(d))!==-1;});
      var nextRoster=root.querySelector('.office-roster');if(nextRoster)nextRoster.scrollTop=rosterScroll||0;
      lastHtml=html;select(selected,false);
      if(focusDetail)Array.from(root.querySelectorAll('[data-office-detail] details')).find(function(d){return detailKey(d)===focusDetail;})?.querySelector('summary')?.focus({preventScroll:true});
      if(focused){var area=rosterFocus?root.querySelector('.office-roster'):root.querySelector('.office-map');if(area)Array.from(area.querySelectorAll('[data-office-select]')).find(function(b){return b.getAttribute('data-office-select')===focused;})?.focus();}
      handoffs();
    }
  };
})();
</script>`;
