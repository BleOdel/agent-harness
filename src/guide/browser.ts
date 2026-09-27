import {readFile} from 'node:fs/promises';
import {choose,confirmed,terminalDialogue,type Dialogue} from './dialogue.ts';
import {parseJourney,type Step} from '../browser/schema.ts';
import {inspectBrowser} from '../browser/runtime.ts';
import {listApprovals,listBrowserRuns,saveApproval} from '../browser/store.ts';
import {withWriter} from '../workspace/writer-lock.ts';
import type {GuideCommand} from '../verbs/guide.ts';
export async function browserSetup(project:string,io:Dialogue=terminalDialogue(),probe=inspectBrowser):Promise<void>{
 const runtime=await probe();io.write(`Chromium ${runtime.chromium}. Fresh offline application copy; no source changes are applied.`);
 const choice=await choose(io,'Browser journey',['Create a journey with short prompts','Read a saved journey file']);if(choice<0)return;
 let raw:unknown;
 if(choice===1)raw=JSON.parse(await readFile((await io.ask('Journey file path:')).trim(),'utf8'));
 else{
  const title=await io.ask('What should this journey check?'),entry=(await io.ask('Node server entry (Enter for src/server.js):')).trim()||'src/server.js';
  const databaseEnv=(await io.ask('Database environment variable (optional, for fresh temporary data):')).trim();
  const timeoutSeconds=Number((await io.ask('Time limit in seconds (Enter for 90, maximum 300):')).trim()||90);
  const steps:Step[]=[{action:'goto',path:'/'}];
  for(;;){
   const action=await choose(io,'Add an observation or action',['Check page heading','Click an element','Fill an input','Press a key','Check exact text','Check element count','Check focused element','Use mobile viewport (320px)','Use desktop viewport (1280px)','Check page has no horizontal overflow','Check common accessibility rules','Take screenshot','Reload page','Navigate to another page','Finish and review']);
   if(action<0)return;if(action===14)break;
   if(action===0)steps.push({action:'text',selector:'h1',expected:await io.ask('Expected heading text:')});
   if(action>=1&&action<=6){const selector=await io.ask('Element selector (for example #title or button[type=submit]):');
    if(action===1)steps.push({action:'click',selector});if(action===2)steps.push({action:'fill',selector,value:await io.ask('Text to enter:')});
    if(action===3)steps.push({action:'press',selector,key:await io.ask('Key (Tab, Shift+Tab, Enter, Space, Escape, ArrowUp, ArrowDown):')});
    if(action===4)steps.push({action:'text',selector,expected:await io.ask('Expected exact text:')});
    if(action===5)steps.push({action:'count',selector,expected:Number(await io.ask('Expected count:'))});
    if(action===6)steps.push({action:'focused',selector});
   }
   if(action===7||action===8)steps.push({action:'viewport',width:action===7?320:1280,height:900});
   if(action===9)steps.push({action:'overflow'});if(action===10)steps.push({action:'accessibility'});if(action===11)steps.push({action:'screenshot'});if(action===12)steps.push({action:'reload'});
   if(action===13)steps.push({action:'goto',path:await io.ask('Local path (for example /#stories):')});
   if(steps.length>=60)break;
  }
  raw={version:1,title,entry,port:4173,timeoutSeconds,steps,...(databaseEnv?{databaseEnv}:{})};
 }
 const journey=parseJourney(raw);io.write(`${journey.title}: node ${journey.entry}, local port ${journey.port}, ${journey.timeoutSeconds}s.`);
 journey.steps.forEach((s,i)=>io.write(`${i+1}. ${JSON.stringify(s)}`));
 io.write('Expected values stay on the host. Screenshots and axe diagnostics are retained. This does not prove full accessibility or replace source acceptance.');
 if(await confirmed(io,'Approve this journey and browser runtime?')){await withWriter(project,'browser approve',()=>saveApproval(project,journey,runtime));io.write('Saved. Continue through harness guide → Browser UI checks.');}
}
export async function guideBrowser(project:string,io:Dialogue,command:GuideCommand):Promise<void>{
 for(;;){
  const approvals=await listApprovals(project),runs=await listBrowserRuns(project);
  const dispatch=async(...args:string[])=>{if(await command(project,['browser',...args]))io.write('That step stopped. The saved result explains what needs attention.');};
  const actions=[{label:'Check browser readiness',run:()=>dispatch('doctor')},{label:'Set up a browser journey',run:()=>dispatch('setup')},
   ...approvals.map(a=>({label:`Verify: ${a.journey.title}`,run:()=>dispatch('verify',a.id)})),
   ...runs.map(r=>({label:`${r.status}: ${approvals.find(a=>a.id===r.approval)?.journey.title??r.approval} (${r.at})`,run:async()=>{await dispatch('inspect',r.id);if(['running','preparing'].includes(r.status)&&await confirmed(io,'Recover owned containers after the writer has ended?'))await dispatch('recover',r.id);}})),
   {label:'Install browser tools in Docker',run:async()=>{io.write('Downloads Chromium, Playwright and axe into a separate local Docker image.');if(await confirmed(io,'Prepare the browser image?'))await dispatch('image');}}
  ];
  const choice=await choose(io,'Browser UI checks',actions.map(a=>a.label));if(choice<0)return;try{await actions[choice]!.run();}catch(e){io.write((e as Error).message);}
 }
}
