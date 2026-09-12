import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readdir,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {readWorkspace,readOutput} from '../src/view/workspace.ts';
import {nextAction,workspaceSections} from '../src/view/guidance.ts';
import {putArtifact} from '../src/artifacts/store.ts';
import type {QueueItem} from '../src/view/render.ts';
const item:QueueItem={feature:{id:'build',title:'Build the blog',status:'todo',priority:'must',criteria:['Works'],dependsOn:[]},state:'todo',next:true};
async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),'harness-guidance-'));const project=path.join(root,'project');await mkdir(project);return {root,project,state:project+'-harness'};}
test('workspace discovery is read-only even when no harness state exists',async()=>{const f=await fixture();try{const data=await readWorkspace(f.project);assert.deepEqual(data.warnings,[]);assert.deepEqual(await readdir(f.root),['project']);assert.equal(data.outputs.length,0);}finally{await rm(f.root,{recursive:true,force:true});}});
test('next step prioritises blockers and approvals ahead of eligible builds; no checks means no ready claim',()=>{
 const data={warnings:[],documents:[],outputs:[],releases:[],reviews:[]};
 assert.match(nextAction([item],[],[],data).title,/acceptance checks/i);
 assert.match(nextAction([item],[],[],{...data,warnings:['Unreadable approval']}).title,/attention/i);
 const html=workspaceSections([item],[],[],data,false);
 assert.match(html,/Plan/);assert.match(html,/Approve/);assert.match(html,/Verify/);assert.match(html,/Needs your attention/);
 assert.doesNotMatch(html,/All checks passed/);
});
test('bad or symlinked documents are warned about, not silently presented as approved',async()=>{const f=await fixture();try{await mkdir(path.join(f.state,'acceptance'),{recursive:true});await writeFile(path.join(f.root,'secret'),'DO NOT SHOW');await symlink(path.join(f.root,'secret'),path.join(f.state,'acceptance','approved.json'));const data=await readWorkspace(f.project);assert.ok(data.warnings.length);assert.equal(data.approval,undefined);assert.ok(!JSON.stringify(data).includes('DO NOT SHOW'));}finally{await rm(f.root,{recursive:true,force:true});}});
test('output downloads are ID-scoped, hash checked and refuse changed bytes or symlink blobs',async()=>{const f=await fixture();try{const a=await putArtifact(f.project,'notes.txt',Buffer.from('hello'),{producer:'test',input:'a'.repeat(64),environment:'b'.repeat(64),verification:'unverified'});assert.equal((await readWorkspace(f.project)).outputs[0]?.id,a.id);assert.equal((await readOutput(f.project,a.id)).bytes.toString(),'hello');await assert.rejects(readOutput(f.project,'../project'));await writeFile(path.join(f.state,'artifacts','blobs',a.sha256),'jello');await assert.rejects(readOutput(f.project,a.id));await rm(path.join(f.state,'artifacts','blobs',a.sha256));await writeFile(path.join(f.root,'private'),'hello');await symlink(path.join(f.root,'private'),path.join(f.state,'artifacts','blobs',a.sha256));await assert.rejects(readOutput(f.project,a.id));}finally{await rm(f.root,{recursive:true,force:true});}});
test('rendered guidance escapes project text and labels outputs as reported rather than independent proof',()=>{const html=workspaceSections([item],[],[],{warnings:['<script>oops</script>'],documents:[],outputs:[],releases:[],reviews:[]},false);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>oops/);assert.match(html,/Orbit/);});

test('workspace and output routes remain GET-only and accept only artifact identifiers',async()=>{
 const {createViewServer,listen}=await import('../src/view/server.ts');let requested='';
 const server=createViewServer({page:async()=>'<p>page</p>',status:async()=>({}),workspace:async()=>'<p>fresh</p>',output:async id=>{requested=id;return {name:'notes.txt',bytes:Buffer.from('hello')};}});
 try{const base=`http://127.0.0.1:${await listen(server,0)}`;
 assert.equal(await (await fetch(base+'/workspace')).text(),'<p>fresh</p>');
 const id='artifact-'+'a'.repeat(36),download=await fetch(base+'/output/'+id);assert.equal(await download.text(),'hello');assert.equal(requested,id);assert.match(download.headers.get('content-disposition')!,/attachment/);
 assert.equal((await fetch(base+'/output/..%2Fprivate')).status,404);assert.equal((await fetch(base+'/workspace',{method:'POST'})).status,405);
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});

test('active ordinary work is not offered a second build and stopped work is surfaced',()=>{
 const data={warnings:[],documents:[],outputs:[],releases:[],reviews:[],ordinary:{live:true,status:undefined,reason:undefined}};
 assert.equal(nextAction([item],[],[],data).href,'#office');
 assert.equal(nextAction([item],[],[],{...data,ordinary:{...data.ordinary,live:false,reason:'Process disappeared'}}).href,'#attention');
});
test('saved plan and canonical task handoff are read and tampering is visible',async()=>{
 const {createHash}=await import('node:crypto');const {realpath}=await import('node:fs/promises');
 const hash=(s:string)=>createHash('sha256').update(s).digest('hex');const f=await fixture();
 try{const dir=path.join(f.state,'plans','2026-09-12-plan');await mkdir(path.join(dir,'work'),{recursive:true});
 const plan='# Blog\nApproved scope',items='[{"id":"posts"}]';
 await writeFile(path.join(dir,'PLAN.md'),plan);await writeFile(path.join(dir,'items.json'),items);await writeFile(path.join(dir,'work','DECISIONS.md'),'Use Markdown');
 await writeFile(path.join(dir,'state.json'),JSON.stringify({version:1,id:path.basename(dir),project:await realpath(f.project),topic:'Blog',phase:'ready',status:'paused',approvedHash:hash(plan),itemsHash:hash(items)}));
 const data=await readWorkspace(f.project);assert.equal(data.plan?.phase,'ready');assert.ok(data.documents.some(d=>d.text===items&&d.status==='Ready to import'));assert.ok(data.documents.some(d=>d.name==='DECISIONS.md'));
 await writeFile(path.join(dir,'items.json'),'changed');const changed=await readWorkspace(f.project);assert.ok(changed.warnings.some(w=>/items changed/i.test(w)));assert.equal(changed.plan,undefined);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('staged review uses retained originals, exposes skill reports and refuses changed snapshots',async()=>{
 const {createTeam,driveTeam}=await import('../src/team/controller.ts');const {parseTeamPlan}=await import('../src/team/schema.ts');
 const {copySource,captureCandidate}=await import('../src/workspace/candidate.ts');const {readTeams}=await import('../src/view/status.ts');
 const f=await fixture();try{
  await writeFile(path.join(f.project,'app.txt'),'original\n');
  const plan=parseTeamPlan({version:1,roles:[{id:'builder',instructions:'Build',skills:[]}],skills:[]},[item.feature]);
  const directory=await createTeam(f.project,plan,f.root,{maxAttempts:1,maxDispatches:1,maxMs:60000,maxCostUsd:1});
  const state=await driveTeam(directory,{
   async execute(a){const work=path.join(a.directory,'work');await copySource(a.baseline.directory,work);await writeFile(path.join(work,'app.txt'),'candidate\n');return {outcome:'submitted',candidate:await captureCandidate(a.baseline,work,path.join(a.directory,'candidate')),usage:{tokens:1,costUsd:0,complete:true},observedReads:['/opt/skills/tdd/SKILL.md'],workflowEvidence:['Reported: red, then green']};},
   async verify(){return {passed:true,gates:['Fixture project checks'],review:'pass'};},async verifyIntegration(){return {passed:true,gates:['Fixture combined checks'],review:'pass'};},async cleanup(){},
  });
  await writeFile(path.join(f.project,'app.txt'),'unrelated live change\n');
  const data=await readWorkspace(f.project),teams=await readTeams(f.project);
  assert.equal(data.reviews[0]?.status,'staged');assert.deepEqual(data.reviews[0]?.files[0]?.lines,['- original','+ candidate']);
  assert.deepEqual(teams[0]?.attempts[0]?.observedReads,['/opt/skills/tdd/SKILL.md']);assert.deepEqual(teams[0]?.attempts[0]?.workflowEvidence,['Reported: red, then green']);
  const html=workspaceSections([item],teams,[],data);assert.match(html,/Staged · not applied/);assert.match(html,/Works/);assert.doesNotMatch(html,/unrelated live change/);
  await writeFile(path.join(state.baseline.directory,'app.txt'),'tampered');assert.equal((await readWorkspace(f.project)).reviews[0]?.files[0]?.kind,'unavailable');
 }finally{await rm(f.root,{recursive:true,force:true});}
});
