import test from 'node:test';import assert from 'node:assert/strict';
import {verificationActions} from '../src/product/actions.ts';
import {productEvidence} from '../src/view/product.ts';
import type {ProductReport} from '../src/product/report.ts';
const report:ProductReport={version:1,project:'/tmp/demo',ready:false,source:'a'.repeat(64),spec:'b'.repeat(64),checks:[{id:'diagnostics',status:'passed',detail:'passed'},{id:'security',status:'accepted-risk',detail:'Scoped accepted risk'},{id:'performance',status:'failed',detail:'Too slow',next:'harness performance verify'},{id:'human-assessment',status:'human',detail:'Needs review',next:'harness product assess'}]};
test('guidance reuses passing evidence, preserves accepted risk and never executes saved command text',()=>{
 const actions=verificationActions(report);assert.ok(!actions.some(a=>a.checks.includes('diagnostics')));assert.ok(!actions.some(a=>a.checks.includes('security')));assert.equal(actions[0]?.command,'harness performance verify');
 const bad=verificationActions({...report,checks:[{id:'unknown',status:'failed',detail:'bad',next:'harness work; touch /tmp/untrusted'}]});assert.ok(!JSON.stringify(bad).includes('touch'));assert.equal(bad[0]?.command,'harness product report');
});
test('dashboard uses report readiness, textual statuses, escaped details and distinct risk',()=>{
 const html=productEvidence({...report,checks:[...report.checks,{id:'runtime:x',status:'unavailable',detail:'<script>secret()</script>'}]},undefined,true,'/tmp/demo');
 assert.match(html,/Evidence still needed/);assert.match(html,/Accepted risk/);assert.match(html,/Unavailable/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>secret/);assert.match(html,/harness performance verify/);assert.doesNotMatch(html,/data-execute|<form/);
 assert.match(productEvidence({...report,ready:true},undefined,false),/Evidence complete for the approved scope/);
 assert.match(productEvidence(undefined,'Could not read evidence',false),/Evidence unavailable/);
});
import {guideProduct} from '../src/guide/product.ts';
const preview=async()=>({description:'Budget 30 seconds; no model.',identity:'pinned'});
test('guided verification previews budgets and reuses passed evidence without dispatch',async()=>{
 const calls:string[][]=[],answers=['1','y','0'],lines:string[]=[];
 await guideProduct('/tmp/demo',{ask:async()=>answers.shift()??'0',write:s=>lines.push(s)},async(_p,args)=>{calls.push([...args]);return 0;},async()=>report,preview);
 assert.deepEqual(calls,[['performance','verify']]);assert.ok(lines.some(l=>l.includes('Budget 30 seconds')));
 await guideProduct('/tmp/demo',{ask:async()=>{throw Error('No choice required');},write:()=>{}},async()=>{throw Error('Do not rerun passed checks');},async()=>({...report,ready:true,checks:[{id:'diagnostics',status:'passed',detail:'done'}]}),preview);
});
test('cancelled or changed guidance never dispatches an unreviewed action',async()=>{
 let calls=0,reads=0;const answers=['1','y','0'],lines:string[]=[];
 await guideProduct('/tmp/demo',{ask:async()=>answers.shift()??'0',write:s=>lines.push(s)},async()=>{calls++;return 0;},async()=>++reads===1?report:{...report,source:'c'.repeat(64)},preview);
 assert.equal(calls,0);assert.ok(lines.some(l=>l.includes('changed')));
 const no=['1','n','0'];await guideProduct('/tmp/demo',{ask:async()=>no.shift()??'0',write:()=>{}},async()=>{calls++;return 0;},async()=>report,preview);assert.equal(calls,0);
});
import {mkdtemp,realpath,mkdir,writeFile,readdir,readFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {draftProduct,approveProduct} from '../src/product/spec.ts';import {productReport} from '../src/product/report.ts';import {readWorkspace} from '../src/view/workspace.ts';
async function files(root:string):Promise<Record<string,string>>{const all:Record<string,string>={};async function visit(p:string){for(const d of await readdir(p,{withFileTypes:true})){const f=path.join(p,d.name);if(d.isDirectory()){all[path.relative(root,f)]='directory';await visit(f);}else all[path.relative(root,f)]=createHash('sha256').update(await readFile(f)).digest('hex');}}await visit(root);return all;}
test('approved web dashboard and repeated reports are read-only and surface corrupt evidence',async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'evidence-view-'))),project=root+'/app';await mkdir(project);try{
  await writeFile(project+'/package.json','{"type":"module"}');await writeFile(project+'/features.json',JSON.stringify([{id:'read',title:'Read posts',priority:'must',status:'done',criteria:['Public content only'],dependsOn:[]}]));await approveProduct(project,await draftProduct(project,'web','prototype',[]));const before=await files(root);
  const direct=await productReport(project),workspace=await readWorkspace(project);assert.deepEqual(workspace.product,direct);assert.equal(workspace.product?.checks.find(c=>c.id==='browser')?.status,'missing');await readWorkspace(project);assert.deepEqual(await files(root),before);
  await mkdir(project+'-harness/browser/approvals',{recursive:true});await writeFile(project+'-harness/browser/approvals/not-valid.json','{"payload":"DO NOT DISPLAY RAW"}');const corrupt=await readWorkspace(project);assert.equal(corrupt.product?.checks.find(c=>c.id==='browser')?.status,'failed');assert.ok(!JSON.stringify(corrupt.product).includes('DO NOT DISPLAY RAW'));
 }finally{await rm(root,{recursive:true,force:true});}
});
import {viewFixture} from './product-view-fixture.ts';
test('evidence panel presents metrics, artifact links, separate recovery and limits without raw response expectations',()=>{
 const html=productEvidence(viewFixture(),undefined,true);
 for(const text of ['Linux Electron','PyTorch CPU','Classification error','Observed model metrics','Mean latency','Retained evidence','Needs recheck','Unavailable','Accepted risk','Raw timing samples','Model and data lineage'])assert.ok(html.includes(text),text);
 assert.ok(!html.includes('NEVER_RENDER_APPROVED_RESPONSE'));assert.match(html,/href="\/output\/artifact-/);assert.match(html,/scope="col"/);
});

test('each browser journey keeps its own suggested command',()=>{
 const a='web-journey-11111111-1111-4111-8111-111111111111',b='web-journey-22222222-2222-4222-8222-222222222222';
 const html=productEvidence({...report,checks:[{id:'browser',status:'failed',detail:'First',next:'harness browser verify '+a},{id:'browser',status:'missing',detail:'Second',next:'harness browser verify '+b}]},undefined);
 assert.match(html,new RegExp('harness browser verify '+a));assert.match(html,new RegExp('harness browser verify '+b));
});

import {previewAction} from '../src/guide/product.ts';import {approvePerformance} from '../src/performance/store.ts';import {approveSecurity} from '../src/security/store.ts';import {profile,environment} from './performance-fixture.ts';import {scope} from './security-fixture.ts';
test('real approved action previews show scope, limits and thresholds without expected payloads',async()=>{
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'evidence-budgets-'))),project=root+'/app';await mkdir(project);try{
 await writeFile(project+'/features.json',JSON.stringify([{id:'api',title:'API',priority:'must',status:'done',criteria:['Safe response'],dependsOn:[]}]));await approveProduct(project,await draftProduct(project,'api','prototype',[]));
 await approvePerformance(project,{...profile,expectedJson:{secret:'DO_NOT_PRINT'}},environment);await approveSecurity(project,scope,environment.image);
 const action=(command:string)=>verificationActions({...report,checks:[{id:'budget',status:'missing',detail:'missing',next:command}]})[0]!;
 const p=await previewAction(project,action('harness performance verify'));for(const text of ['GET '+profile.path,'mean ≤ '+profile.meanMs,'throughput ≥ '+profile.minRps,profile.maxSeconds+'s','Offline'])assert.ok(p.description.includes(text),text);assert.ok(!p.description.includes('DO_NOT_PRINT'));
 const security=await previewAction(project,action('harness security verify'));for(const text of [scope.assets,scope.boundaries,scope.recipe.privatePath,'Host 403','30s','offline'])assert.ok(security.description.includes(text),text);
 await approvePerformance(project,{...profile,meanMs:profile.meanMs+1},environment);assert.notEqual((await previewAction(project,action('harness performance verify'))).identity,p.identity);
 }finally{await rm(root,{recursive:true,force:true});}
});
