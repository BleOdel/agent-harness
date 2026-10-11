import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {compileFormScenario} from '../src/acceptance/form-scenarios.ts';
import {inspectBrowser} from '../src/browser/runtime.ts';import {saveApproval} from '../src/browser/store.ts';import {verifyBrowser} from '../src/browser/controller.ts';
const script=`import http from 'node:http';http.createServer((q,r)=>{if(q.url==='/save'){r.setHeader('content-type','application/json');return setTimeout(()=>r.end('{"ok":true}'),200);}r.setHeader('content-type','text/html');r.end(\`<!doctype html><html lang="en"><title>Form fixture</title><body><label>Title<input id="title"></label><output id="count">0 characters</output><label>Story<textarea id="story"></textarea></label><button id="preview">Preview</button><p id="validation"></p><p id="ready"></p><label>Content note<select id="category"><option value="">None</option><option value="grief">Grief</option><option value="other">Other</option></select></label><label>Explanation<input id="explanation"></label><button id="note">Preview note</button><p id="note-error"></p><p id="note-label"></p><p id="note-explanation"></p><label><input id="ack" type="checkbox">Acknowledge</label><button id="send">Send</button><p id="result"></p><script>
const query=new URLSearchParams(location.search),broken=query.get('broken'),alternate=query.has('alternate');
const ids=['title','count','story','preview','validation','ready','category','explanation','note','note-error','note-label','note-explanation','ack','send','result'];const elements=Object.fromEntries(ids.map(id=>[id,document.getElementById(id)]));if(alternate){for(const e of Object.values(elements))e.id='alternate-'+e.id;elements.title.maxLength=100;}
elements.title.oninput=()=>{if(broken==='early')fetch('/save',{method:'POST'});if(broken!=='counts')setTimeout(()=>elements.count.textContent=elements.title.value.length+' characters',40);};
elements.preview.onclick=()=>{const n=elements.title.value.length;elements.validation.textContent='';elements.ready.textContent='';if(broken!=='validation'&&(n<5||n>100))elements.validation.textContent='Invalid title';else elements.ready.textContent='Preview';};
elements.note.onclick=()=>{elements['note-error'].textContent='';if(elements.category.value==='other'&&!elements.explanation.value&&broken!=='notes')return elements['note-error'].textContent='Explain Other';elements['note-label'].textContent=elements.category.value?elements.category.selectedOptions[0].textContent:'No note';elements['note-explanation'].textContent=elements.explanation.value;};
elements.send.onclick=async()=>{if(!elements.ack.checked&&broken!=='ack')return elements.result.textContent='Acknowledge first';try{const r=await fetch('/save',{method:'POST'});if(!r.ok)throw Error('failed');elements.result.textContent='Saved';}catch{if(broken==='retention')elements.story.value='';elements.result.textContent='Unavailable';}};
</script></body></html>\`);}).listen(Number(process.env.PORT),'127.0.0.1');`;
export function fixtureScenarios(alternate=false,broken=''){
 const sel=(id:string)=>'#'+(alternate?'alternate-':'')+id;
 const base={version:1,launch:{title:'Synthetic form',entry:'server.js',port:4173,timeoutSeconds:90},path:'/?'+(alternate?'alternate=1&':'')+'broken='+broken,setup:[]};
 return [
 {...base,kind:'text-limits',field:sel('title'),counter:sel('count'),prefix:'',suffix:' characters',minimum:5,maximum:100,overflow:alternate?'truncate':'reject',advance:sel('preview'),invalid:{selector:sel('validation'),text:'Invalid title'},valid:{selector:sel('ready'),text:'Preview'},requestPath:'/save'},
 {...base,kind:'acknowledgement',checkbox:sel('ack'),advance:sel('send'),invalid:{selector:sel('result'),text:'Acknowledge first'},valid:{selector:sel('result'),text:'Saved'},requestPath:'/save',successRequests:1},
 {...base,kind:'content-note',category:sel('category'),explanation:sel('explanation'),advance:sel('note'),noneValue:'',otherValue:'other',options:[{value:'grief',label:'Grief'}],noneText:'No note',previewNote:sel('note-label'),previewExplanation:sel('note-explanation'),otherText:'Synthetic explanation',invalid:{selector:sel('note-error'),text:'Explain Other'},requestPath:'/save'},
 {...base,kind:'failure-retention',setup:[{action:'click',selector:sel('ack')}],fields:[{selector:sel('story'),value:'A synthetic private draft with exact prose.'}],submit:sel('send'),requestPath:'/save',mode:'503',error:{selector:sel('result'),text:'Unavailable'}},
 ];
}
test('Chromium form templates observe two valid interfaces and deliberate validation, count, early-submit, note, acknowledgement and retention defects',{skip:process.env.HARNESS_VERIFY_BROWSER!=='1'},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'form-scenarios-')),project=root+'/app';await mkdir(project);await writeFile(project+'/package.json','{"type":"module"}');await writeFile(project+'/server.js',script);
 const outcomes:unknown[]=[];
 try{const runtime=await inspectBrowser();
  for(const alternate of [false,true])for(const scenario of fixtureScenarios(alternate)){
   const journey=compileFormScenario(scenario),approval=await saveApproval(project,journey,runtime),run=await verifyBrowser(project,approval.id);outcomes.push({kind:scenario.kind,alternate,expected:'passed',status:run.status,checks:run.assessment?.checks});assert.equal(run.status,'passed',scenario.kind+' '+run.message);assert.deepEqual(run.containers,[]);
  }
  for(const [broken,index] of [['counts',0],['validation',0],['early',0],['ack',1],['notes',2],['retention',3]] as const){
   const journey=compileFormScenario(fixtureScenarios(false,broken)[index]),approval=await saveApproval(project,journey,runtime),run=await verifyBrowser(project,approval.id);outcomes.push({broken,expected:'failed',status:run.status,reason:run.message});assert.equal(run.status,'failed',broken);assert.deepEqual(run.containers,[]);assert.ok(run.assessment?.failures.length,'Must fail a host observation, not just process startup');
  }
  if(process.env.HARNESS_FORM_EVIDENCE)await writeFile(process.env.HARNESS_FORM_EVIDENCE,JSON.stringify({version:1,runtime,outcomes},null,2)+'\n');
 }finally{await rm(root,{recursive:true,force:true});}
});
