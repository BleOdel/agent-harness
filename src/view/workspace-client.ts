/** Progressive controls work in saved pages too; only served pages refresh data. */
export const WORKSPACE_SCRIPT=`<script>
(function(){
 var office=document.getElementById('office');if(!office)return;
 var zoom=document.getElementById('office-zoom'), expand=document.getElementById('office-expand'), inspector=document.getElementById('office-inspector-toggle');
 zoom.addEventListener('change',function(){var map=office.querySelector('.office-map');if(map)map.style.width=zoom.value+'%';});
 expand.addEventListener('click',function(){var on=office.classList.toggle('office-expanded');expand.setAttribute('aria-pressed',String(on));expand.textContent=on?'Exit expanded view':'Expand office';});
 inspector.addEventListener('click',function(){var off=office.classList.toggle('office-inspector-hidden');inspector.setAttribute('aria-expanded',String(!off));inspector.textContent=off?'Show inspector':'Hide inspector';});
 document.addEventListener('keydown',function(e){if(e.key==='Escape'&&office.classList.contains('office-expanded')){expand.click();expand.focus();}});
 document.addEventListener('click',async function(e){
  var orbit=e.target.closest('.office-hover');if(orbit){if(office.classList.contains('office-expanded'))expand.click();var help=document.getElementById('orbit-guidance');help.scrollIntoView({block:'start'});help.setAttribute('tabindex','-1');help.focus();}
  var copy=e.target.closest('[data-copy-command]');if(copy){try{await navigator.clipboard.writeText(copy.getAttribute('data-copy-command'));copy.textContent='Copied';}catch(error){copy.textContent='Select the command to copy';}}
 });
 if(!document.getElementById('connection-status'))return;
 var busy=false;
 var targets=['record-summary','overview','attention','journey','review','outputs','orbit-guidance','task-content','usage-content','history-content','files-content'];
 function key(d){var run=d.closest('[data-run]');return (run?run.id+'/':'')+(d.getAttribute('data-state-key')||d.querySelector('summary')?.textContent||'');}
 function sync(doc){
  var y=window.scrollY, active=document.activeElement;
  targets.forEach(function(id){
   var old=document.getElementById(id), next=doc.getElementById(id);if(!old||!next||old.innerHTML===next.innerHTML)return;
   // Do not replace text while it is being selected or a control is in use.
   var selection=window.getSelection();if((selection&&!selection.isCollapsed&&old.contains(selection.anchorNode))||(old.contains(active)&&/INPUT|TEXTAREA|SELECT/.test(active.tagName)))return;
   var open=Array.from(old.querySelectorAll('details[open]')).map(key);
   var scroll=Array.from(old.querySelectorAll('pre')).map(function(p){return [p.scrollTop,p.scrollLeft];});
   var file=old.querySelector('[data-file-path]:not([hidden])')?.getAttribute('data-file-path');
   var focused=old.contains(active)?{id:active.id,key:active.closest('details')?key(active.closest('details')):null}:null;
   old.replaceChildren(...Array.from(next.childNodes));
   old.querySelectorAll('details').forEach(function(d){d.open=open.indexOf(key(d))!==-1;});
   old.querySelectorAll('pre').forEach(function(p,i){if(scroll[i]){p.scrollTop=scroll[i][0];p.scrollLeft=scroll[i][1];}});
   if(id==='files-content'){window.bindHarnessFiles?.();if(file){var panel=Array.from(old.querySelectorAll('[data-file-path]')).find(function(p){return p.getAttribute('data-file-path')===file;});if(panel){var button=Array.from(old.querySelectorAll('[data-file]')).find(function(b){return b.getAttribute('data-file')===panel.id;});button?.click();}}}
   if(focused){var focus=focused.id?document.getElementById(focused.id):Array.from(old.querySelectorAll('details')).find(function(d){return key(d)===focused.key;})?.querySelector('summary');focus?.focus({preventScroll:true});}
  });
  window.refreshHarnessFilters?.();window.scrollTo({top:y,behavior:'instant'});
 }
 window.refreshHarnessWorkspace=async function(){
  if(busy)return;busy=true;
  var button=document.getElementById('refresh-overview');var label=button.textContent;button.disabled=true;button.textContent='Refreshing…';
  try{var r=await fetch('/workspace',{cache:'no-store',signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error('Workspace unavailable');var doc=new DOMParser().parseFromString(await r.text(),'text/html');if(!doc.getElementById('overview'))throw Error('Invalid workspace response');sync(doc);button.title='Workspace updated '+new Date().toLocaleTimeString();document.getElementById('workspace-update').textContent=button.title;}
  catch(e){button.title='Workspace refresh failed; current information retained. Retry to update.';document.getElementById('workspace-update').textContent=button.title;}
  finally{busy=false;button.disabled=false;button.textContent=label;}
 };
 setInterval(function(){if(!document.hidden)window.refreshHarnessWorkspace();},10000);
})();
</script>`;
