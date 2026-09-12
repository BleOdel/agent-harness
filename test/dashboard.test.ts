import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPage, type QueueItem } from '../src/view/render.ts';
import { view } from '../src/verbs/view.ts';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const item = (id: string, status: QueueItem['feature']['status'], priority: QueueItem['feature']['priority'] = 'must'): QueueItem => ({
  feature: { id, title: `Readable ${id}`, status, priority, criteria: ['Expected behaviour'], dependsOn: [] }, state: status, next: status === 'todo',
});

test('dashboard separates excluded tasks and shows titles, criteria and next step', () => {
  const html = renderPage('Example', [], undefined, false, [item('ready','todo'), item('finished','done'), item('later','todo','wont')]);
  assert.match(html, /1 of 2 planned tasks complete/);
  assert.match(html, /1 excluded from scope/);
  assert.match(html, /Next task: Readable ready/);
  assert.match(html, /Expected behaviour/);
  assert.match(html, /id="task-search"/);
  assert.match(html, /id="run-filter"/);
  assert.match(html, /href="#tasks"/);
});

test('unfinished queues are never reported as completed without eligible work', () => {
  const html = renderPage('Example', [], undefined, false, [{...item('blocked','blocked'),next:false}]);
  assert.match(html, /Needs your attention/);
  assert.doesNotMatch(html, /All planned tasks complete/);
});

test('teams are readable cards with staging distinct from application and escaped content', () => {
  const html = renderPage('Example', [], undefined, false, [], undefined, [{runId:'team-example', status:'staged', live:false,elapsedMs:3000,costUsd:0,tokens:0,tasks:[{id:'<img src=x onerror=alert(1)>',role:'builder',waitingFor:[]}],attempts:[],steering:[]}]);
  assert.match(html, /class="team-card"/);
  assert.match(html, /Ready for review/);
  assert.match(html, /Changes are staged; project files have not been updated/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /Usage not reported/);
});

test('empty and saved dashboards explain how to start and do not poll', () => {
  const html = renderPage('Empty', []);
  assert.match(html, /No tasks yet/);
  assert.match(html, /harness guide/);
  assert.match(html, /Saved snapshot/);
  assert.match(html, /No runs yet/);
  assert.doesNotMatch(html, /fetch\("\/status"/);
});

test('live dashboard reports disconnects and offers explicit refresh', () => {
  const html = renderPage('Example', [], undefined, true);
  assert.match(html, /id="connection-status"/);
  assert.match(html, /Connection lost/);
  assert.match(html, /Refresh overview/);
  assert.match(html, /if \(!r.ok\)/);
});

test('static view opens before the first run and warns about unreadable task data', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'harness-dashboard-'));
  const project = path.join(dir,'project');
  try {
    await mkdir(project);
    await view(project, []);
    assert.match(await readFile(`${project}-harness/view.html`,'utf8'), /No tasks yet/);
    await writeFile(path.join(project,'features.json'),'{bad');
    await view(project, []);
    const html = await readFile(`${project}-harness/view.html`,'utf8');
    assert.match(html, /Project data needs attention/);
    assert.match(html, /features.json/);
    assert.doesNotMatch(html, /All planned tasks complete/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('search combines text and status, shows no matches and reveals linked hidden runs', async () => {
  const { runInNewContext } = await import('node:vm');
  const { DASHBOARD_SCRIPT } = await import('../src/view/dashboard.ts');
  class Element {
    value = ''; hidden = false; textContent = ''; scrolled = false;
    listeners: Record<string, () => void> = {};
    readonly attrs: Record<string,string>;
    constructor(attrs: Record<string,string> = {}) { this.attrs = attrs; }
    getAttribute(key: string) { return this.attrs[key] ?? ''; }
    hasAttribute(key: string) { return key in this.attrs; }
    addEventListener(key: string, fn: () => void) { this.listeners[key] = fn; }
    scrollIntoView() { this.scrolled = true; }
  }
  const elements = Object.fromEntries(['task-search','task-filter','task-result','task-empty','run-search','run-filter','run-result','run-empty','file-search','file-result','file-empty'].map(id=>[id,new Element()]));
  elements['task-filter']!.value = elements['run-filter']!.value = 'all';
  const rows = [new Element({'data-search':'save files','data-group':'done'}),new Element({'data-search':'save tasks','data-group':'open'})];
  const run = new Element({'data-run':'','data-search':'storage','data-group':'applied'});
  const file = new Element({'data-search':'src/storage.ts'});
  elements.r1 = run;
  const document = {getElementById:(id:string)=>elements[id],querySelectorAll:(s:string)=>s==='[data-task]'?rows:s==='[data-run]'?[run]:[file]};
  const events: Record<string,()=>void> = {};
  const location = {hash:''};
  runInNewContext(DASHBOARD_SCRIPT.replace(/^<script>|<\/script>$/g,''),{document,location,window:{addEventListener:(event:string,fn:()=>void)=>{events[event]=fn;}}});
  elements['task-search']!.value=' SAVE ';
  elements['task-filter']!.value='done'; elements['task-filter']!.listeners.change!();
  assert.deepEqual(rows.map(r=>r.hidden),[false,true]);
  assert.equal(elements['task-result']!.textContent,'1 matching tasks');
  elements['task-search']!.value='absent'; elements['task-search']!.listeners.input!();
  assert.equal(elements['task-empty']!.hidden,false);
  elements['run-search']!.value='absent'; elements['run-search']!.listeners.input!();
  assert.equal(run.hidden,true);
  location.hash='#r1'; events.hashchange!();
  assert.equal(run.hidden,false); assert.equal(run.scrolled,true);
  elements['file-search']!.value='storage'; elements['file-search']!.listeners.input!();
  assert.equal(file.hidden,false);
  elements['file-search']!.value='missing'; elements['file-search']!.listeners.input!();
  assert.equal(file.hidden,true); assert.equal(elements['file-empty']!.hidden,false);
});

test('a failed status request visibly disconnects, and the next success reconnects', async () => {
  const { runInNewContext } = await import('node:vm');
  const page=renderPage('Example',[],undefined,true);
  const script=[...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)![1]!;
  const connection={textContent:'',dataset:{} as Record<string,string>};
  const box={hidden:false}; let tick:()=>void=()=>{}; let ok=false;
  runInNewContext(script,{window:{},document:{getElementById:(id:string)=>id==='connection-status'?connection:id==='live'?box:null},fetch:async()=>({ok,json:async()=>({live:false})}),setInterval:(fn:()=>void)=>{tick=fn;},AbortSignal});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(connection.dataset.state,'lost'); assert.match(connection.textContent,/Connection lost/); assert.equal(box.hidden,true);
  ok=true; tick(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(connection.dataset.state,'connected'); assert.match(connection.textContent,/Connected/);
});
