import { commandButton,type Action } from './guidance.ts';
import { escape, type QueueItem } from './render.ts';
import type { TeamView } from './status.ts';

export function taskGroup(item: QueueItem): string {
  if (item.feature.priority === 'wont') return 'excluded';
  if (item.feature.status === 'done') return 'done';
  if (item.waitingFor?.length || ['blocked','needs-revalidation','error','gate-failed','escalated','environment-blocked'].includes(item.state)) return 'attention';
  return 'open';
}

export function overview(items: readonly QueueItem[], warnings: readonly string[], action?:Action, project?:string): string {
  const planned = items.filter(i => i.feature.priority !== 'wont');
  const done = planned.filter(i => i.feature.status === 'done').length;
  const attention = planned.filter(i => taskGroup(i) === 'attention').length;
  const next = planned.find(i => i.next);
  const title = warnings.length ? 'Project data needs attention' : !items.length ? 'No tasks yet' : next ? `Next task: ${next.feature.title}` : planned.length && done === planned.length ? 'All planned tasks complete' : attention ? 'Needs your attention' : 'No task ready to start';
  const message = warnings.length ? 'Some saved information could not be read. Resolve it before relying on these totals.' : !items.length ? 'Start with a short planning interview. Your answers carry forward into the work.' : next ? 'Review its acceptance criteria below. Continue through the guide when you are ready.' : done === planned.length && planned.length ? 'Review the completed work and its checks. Applying changes does not commit or publish them.' : 'Review task states and prerequisites below, then use the guide to continue.';
  return `<section id="overview" class="overview" aria-labelledby="overview-title"><div><p class="eyebrow">Your next step</p><h2 id="overview-title">${escape(action?.title??title)}</h2><p>${escape(action?.message??message)}</p>${action?`<a href="${action.href}">View details →</a>${commandButton(action.command,project)}`:'<code>harness guide</code>'}<span class="command-note">Run in this project’s terminal</span>${warnings.map(w=>`<p class="warning">${escape(w)}</p>`).join('')}</div><div class="progress-card"><strong>${done}<span> / ${planned.length}</span></strong><p>${done} of ${planned.length} planned tasks complete</p><progress max="${Math.max(1,planned.length)}" value="${done}" aria-label="Planned tasks complete"></progress><p>${attention} need attention · ${items.length-planned.length} excluded from scope</p></div></section>`;
}

export function taskList(items: readonly QueueItem[]): string {
  if (!items.length) return '<p class="empty">Your accepted tasks will appear here, with a clear description of what done means.</p>';
  const labels: Record<string,string> = {todo:'To do',doing:'In progress',done:'Done',blocked:'Blocked','needs-revalidation':'Needs revalidation',undone:'Undone'};
  return `<ul class="queue">${items.map((item)=>{
    const f=item.feature, group=taskGroup(item), mark=f.status==='done'?'done':item.next?'next':f.status;
    return `<li class="${item.next?'is-next':''}" data-task data-group="${group}" data-search="${escape([f.id,f.title,item.state,...f.criteria,...(item.waitingFor??[])].join(' ').toLowerCase())}"><details data-state-key="task-${escape(f.id)}"><summary><span class="dot ${escape(mark)}"></span><span class="task-name">${escape(f.title)}<small>${escape(f.id)}</small></span><span class="badge">${group==='excluded'?'Excluded':item.waitingFor?.length?'Waiting':escape(labels[item.state]??item.state)}</span>${item.next&&group!=='excluded'?'<span class="badge next-badge">Up next</span>':''}</summary><div class="task-detail"><p>Priority: ${escape(f.priority)}${f.assignedRole?` · Role: ${escape(f.assignedRole)}`:''}</p>${item.waitingFor?.length?`<p class="warning">Prerequisites · waiting for: ${escape(item.waitingFor.join(', '))}</p>`:''}<h3>Acceptance criteria</h3><ul>${f.criteria.map(c=>`<li>${escape(c)}</li>`).join('')}</ul></div></details></li>`;
  }).join('')}</ul><span class="qleft">${items.filter(i=>i.feature.status!=='done' && i.feature.priority!=='wont').length} left in planned scope</span>`;
}

export function teamCards(teams: readonly TeamView[]): string {
  if (!teams.length) return '<p class="empty">No team runs yet. Team work appears here when you start a team from the terminal.</p>';
  return teams.map(t=>{
    const measured=t.attempts.some(a=>a.models.length>0);
    const title=t.status==='staged'?'Ready for review':t.status==='applied'?'Applied to project':t.status;
    const effect=t.status==='staged'?'Changes are staged; project files have not been updated.':t.status==='applied'?'Changes were applied. This does not mean they were committed or published.':'Read the latest attempt and any blockers before continuing.';
    return `<article class="team-card"><header><h3>${escape(title)}</h3><span class="badge">${t.live?'Controller active':'Controller inactive'}</span></header><p class="team-id">${escape(t.runId)}</p><p>${effect}</p>${t.reason?`<p class="warning">${escape(t.reason)}</p>`:''}<p class="meta">${Math.round(t.elapsedMs/1000)}s elapsed · ${measured||t.tokens>0||t.costUsd>0?`${t.tokens.toLocaleString('en-GB')} reported tokens · $${t.costUsd.toFixed(4)} estimated; reporting may be incomplete`:'Usage not reported'}</p><details data-team-detail="${escape(t.runId)}"><summary>Assignments and verification · ${t.tasks.length} tasks</summary><ul>${t.tasks.map(task=>`<li>${escape(task.id)} <span class="meta">${escape(task.role)}</span>${task.waitingFor.length?`<p class="warning">Waiting for ${escape(task.waitingFor.join(', '))}</p>`:''}</li>`).join('')}</ul>${t.attempts.map(a=>`<div class="attempt"><strong>${escape(a.task)} · ${escape(a.phase)}</strong><p class="meta">${escape(a.role)} · review: ${escape(a.review)} · integration: ${escape(a.integration)}</p><ul class="gates">${a.gates.map(g=>`<li>${escape(g)}</li>`).join('')}</ul>${a.models.map(m=>`<p class="meta">${escape(m.role)}: ${escape(m.provider??"unknown provider")}/${escape(m.model??"unknown model")} · ${m.tokens} tokens · $${m.costUsd.toFixed(4)} reported</p>`).join('')}<p class="team-id">${escape(a.id)}${a.repairOf?` · Repair of ${escape(a.repairOf)}`:''}</p></div>`).join('')}${t.steering.map(s=>`<p>Steering ${escape(s.state)}: ${escape(s.message)}</p>`).join('')}</details></article>`;
  }).join('');
}

export const DASHBOARD_STYLE = `
:root{--bg:#f5f6f3;--fg:#202c2b;--dim:#5b6966;--line:#dce2dc;--accent:#176b53;--card:#fff;--rail:#152d27}
@media(prefers-color-scheme:dark){:root{--bg:#111a17;--fg:#eaf0eb;--dim:#a2b2a9;--line:#33463d;--accent:#91d4b7;--card:#1a2721;--rail:#0d1712}}
[hidden]{display:none!important} html{scroll-padding-top:1rem} a{color:var(--accent)}
main{width:auto;max-width:100rem;margin:0 auto;padding:0;display:grid;grid-template-columns:220px minmax(0,1fr);min-height:100vh}
.rail{background:var(--rail);color:#eef5ef;padding:2rem 1.25rem;position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:2rem}
.brand{font-weight:700;font-size:1.3rem;letter-spacing:-.04em}.brand span{color:#9ed5ba;margin-right:.5rem}.rail p{font-size:.8rem;color:#bdcfc3}.rail nav{display:grid;gap:.5rem}.rail a{display:block;padding:.7rem .8rem;text-decoration:none;color:#e2eee5;border-radius:7px}.rail a:hover,.rail a:focus-visible{background:#29473a}.rail .rail-bottom{margin-top:auto}
.workspace{padding:2.5rem clamp(1.25rem,3.5vw,4rem) 4rem;min-width:0}.page-head{display:flex;justify-content:space-between;align-items:start;gap:1rem}.page-head h1{font-size:clamp(1.8rem,3vw,2.5rem);letter-spacing:-.045em;overflow-wrap:anywhere}.eyebrow{font-size:.7rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin:0 0 .65rem}.sub{margin:.45rem 0 1.5rem;font-size:.85rem}.badge{display:inline-block;padding:.2rem .6rem;border:1px solid var(--line);border-radius:20px;font-size:.73rem;font-weight:600;white-space:nowrap}.next-badge{color:var(--accent)}
.overview{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(180px,1fr);gap:2rem;padding:1.6rem;background:var(--card);border:1px solid var(--line);border-radius:14px;margin:1rem 0 2rem}.overview h2{font-size:1.35rem}.overview p{font-size:.9rem;color:var(--dim)}.overview code{background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:.35rem .6rem;font-size:.85rem}.command-note{display:block;margin-top:.65rem;font-size:.75rem;color:var(--dim)}.progress-card{border-left:1px solid var(--line);padding-left:2rem}.progress-card strong{font-size:2.8rem;line-height:1.1;letter-spacing:-.05em}.progress-card strong span{font-size:1.3rem;color:var(--dim);font-weight:400}progress{width:100%;height:.5rem;accent-color:var(--accent)}
.section-heading{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;margin:2rem 0 1rem}.section-heading h2{font-size:1.2rem;letter-spacing:-.02em}.section-heading p{margin:0;color:var(--dim);font-size:.8rem}.toolbar{display:flex;gap:.75rem;align-items:end;margin:1rem 0}.toolbar label{display:flex;flex-direction:column;gap:.3rem;font-size:.75rem;color:var(--dim)}.toolbar label:first-child{flex:1}input,select,button.action{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:7px;padding:.65rem .8rem;min-width:0}input{width:100%}button.action{cursor:pointer;font-size:.8rem}a:focus-visible,button:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.skip-link{position:absolute;left:-9999px}.skip-link:focus{left:1rem;top:1rem;z-index:5;background:var(--card);padding:1rem}
.queue{border:1px solid var(--line);border-radius:12px;background:var(--card);overflow:hidden}.queue>li{display:block;padding:0;border-radius:0;border-top:1px solid var(--line)}.queue>li:first-child{border-top:0}.queue>li.is-next{background:color-mix(in srgb,var(--accent) 5%,var(--card))}.queue details{border:0}.queue summary{font:inherit;align-items:center;padding:1rem;gap:.8rem}.queue summary:after{content:'+';color:var(--dim)}.queue details[open] summary:after{content:'−'}.task-name{flex:1;min-width:0;font-weight:600;overflow-wrap:anywhere}.task-name small{display:block;font-size:.73rem;color:var(--dim);font-weight:400;margin-top:.2rem}.task-detail{padding:0 1rem 1rem 2.2rem;font-size:.85rem}.task-detail li{display:list-item;padding:.2rem 0}.task-detail h3{margin-top:.75rem}.qleft{display:block;color:var(--dim);font-size:.7rem;margin:.5rem 0}.empty{padding:1.5rem;border:1px dashed var(--line);border-radius:10px;color:var(--dim);font-size:.9rem}.warning{color:var(--rev)!important;overflow-wrap:anywhere}.run{border-radius:12px}.run.reversed{opacity:1;border-style:dashed}.run.reversed header{color:var(--dim)}.run h2{font-size:.9rem}.run h2 .goal{color:var(--fg);font-weight:600;font-size:1rem}.run .criteria{font-size:.88rem}.strip{gap:1.5rem;margin-bottom:1rem}.team-card{border:1px solid var(--line);background:var(--card);padding:1.2rem;border-radius:12px;margin-bottom:1rem;overflow-wrap:anywhere}.team-card header{display:flex;justify-content:space-between;gap:1rem;align-items:center}.team-card h3{margin:0;font-size:1rem;text-transform:none;letter-spacing:0;color:var(--fg)}.team-card p{font-size:.85rem}.team-id{color:var(--dim);font: .72rem/1.5 ui-monospace,monospace;overflow-wrap:anywhere}.attempt{border-top:1px solid var(--line);padding:1rem 0}.connection{font-size:.78rem;color:var(--dim)}.connection[data-state="lost"]{color:var(--del)}.snapshot{font-size:.75rem;color:var(--dim)}.file-layout{display:grid;grid-template-columns:210px minmax(0,1fr);gap:1.25rem}.file-layout aside{max-height:32rem}.panel{min-width:0}.section{scroll-margin-top:1rem}.filter-result{font-size:.75rem;color:var(--dim)}
@media(max-width:1000px){main{grid-template-columns:175px minmax(0,1fr)}.rail{padding:1.5rem .75rem}.workspace{padding:1.5rem}.overview{gap:1rem}.progress-card{padding-left:1rem}}
@media(max-width:760px){main{display:block}.rail{position:static;height:auto;padding:1rem;gap:.5rem}.rail nav{display:flex;flex-wrap:wrap;gap:.1rem}.rail a{padding:.5rem .65rem;font-size:.85rem}.rail .rail-bottom{display:none}.rail p{margin:0}.workspace{padding:1.25rem 1rem}.overview{grid-template-columns:1fr;padding:1.25rem}.progress-card{padding:1rem 0 0;border-left:0;border-top:1px solid var(--line)}.progress-card strong{font-size:2rem}.page-head{flex-wrap:wrap}.toolbar{flex-wrap:wrap}.toolbar label{flex:1;min-width:130px}.queue summary{flex-wrap:wrap}.task-name{min-width:50%}.file-layout{grid-template-columns:1fr}.file-layout aside{max-height:16rem}.section-heading{flex-wrap:wrap}.team-card header{flex-wrap:wrap}.live{padding:.75rem;gap:.5rem}}
`;

export const DASHBOARD_SCRIPT = `<script>
(function(){
  var refreshers=[];
  function filter(kind){
    var search=document.getElementById(kind+'-search'), select=document.getElementById(kind+'-filter');
    if(!search)return;
    function update(){
      var query=search.value.trim().toLowerCase(), value=select?select.value:'all', count=0;
      document.querySelectorAll(kind==='file'?'[data-file-entry]':'[data-'+kind+']').forEach(function(row){
        var match=(!query || row.getAttribute('data-search').indexOf(query)!==-1) && (value==='all'||row.getAttribute('data-group')===value);
        row.hidden=!match;if(match)count++;
      });
      document.getElementById(kind+'-result').textContent=count+' matching '+(kind==='task'?'tasks':kind==='run'?'runs':'files');
      document.getElementById(kind+'-empty').hidden=count!==0;
    }
    refreshers.push(update);search.addEventListener('input',update);if(select)select.addEventListener('change',update);update();
    return function(){search.value='';if(select)select.value='all';update();};
  }
  filter('task');var clearRuns=filter('run');filter('file');
  function revealRun(){var target=document.getElementById(decodeURIComponent(location.hash.slice(1)));if(target && target.hasAttribute('data-run') && target.hidden){clearRuns();target.scrollIntoView();}}
  window.addEventListener('hashchange',function(){try{revealRun();}catch(e){}});try{revealRun();}catch(e){}
  window.refreshHarnessFilters=function(){refreshers.forEach(function(update){update();});};
  var refresh=document.getElementById('refresh-overview');if(refresh)refresh.addEventListener('click',function(){if(window.refreshHarnessWorkspace)window.refreshHarnessWorkspace();else location.reload();});
})();
</script>`;
