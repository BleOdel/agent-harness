import { listArtifacts } from '../artifacts/store.ts';
import {readFile} from 'node:fs/promises';
import {parseJourney,type Step} from '../desktop/schema.ts';
import {notesJourney} from '../desktop/scaffold.ts';
import {inspectDesktop} from '../desktop/runtime.ts';
import {listApprovals,listDesktopRuns,saveApproval} from '../desktop/store.ts';
import {withWriter} from '../workspace/writer-lock.ts';
import {choose,confirmed,terminalDialogue,type Dialogue} from './dialogue.ts';
import type {GuideCommand} from '../verbs/guide.ts';
export async function desktopSetup(project:string,io:Dialogue=terminalDialogue(),probe=inspectDesktop):Promise<void>{
 const runtime=await probe();io.write(`Linux desktop: Electron ${runtime.electron}, ${runtime.arch}. Offline; 2 CPUs, 2 GiB RAM. Native macOS/Windows/mobile support is deferred.`);
 const choice=await choose(io,'Journey to review',['Starter notes: keyboard save, restart, invalid input and screenshot','Create a journey with short prompts','Read a journey file']);if(choice<0)return;
 let raw:unknown;
 if(choice===0)raw=notesJourney;
 else if(choice===2)raw=JSON.parse(await readFile((await io.ask('Journey file path:')).trim(),'utf8'));
 else{
  const title=await io.ask('What should this journey prove?'),timeoutSeconds=Number((await io.ask('Time limit in seconds (Enter for 60, maximum 300):')).trim()||60),steps:Step[]=[];
  while(steps.length<30){
   const action=await choose(io,'Add a step',['Fill an input','Click an element','Press a key','Check exact text','Count matching elements','Restart app','Take screenshot','Finish and review']);if(action<0)return;if(action===7)break;
   const selector=action<5?await io.ask('Element selector (for example #note or #notes li):'):'';
   if(action===0)steps.push({action:'fill',selector,value:await io.ask('Text to enter:')});
   if(action===1)steps.push({action:'click',selector});
   if(action===2)steps.push({action:'press',selector,key:await io.ask('Key: Enter, Tab, Space, Escape, ArrowUp or ArrowDown:')});
   if(action===3)steps.push({action:'text',selector,expected:await io.ask('Expected exact text:')});
   if(action===4)steps.push({action:'count',selector,expected:Number(await io.ask('Expected count (0–1000):'))});
   if(action===5)steps.push({action:'restart'});if(action===6)steps.push({action:'screenshot'});
  }
  raw={version:1,title,timeoutSeconds,steps};
 }
 const journey=parseJourney(raw);io.write(`${journey.title} · ${journey.timeoutSeconds}s GUI limit. Two bounded packaging checks run first.`);journey.steps.forEach((step,i)=>io.write(`${i+1}. ${JSON.stringify(step)}`));
 io.write('Actions go to the app driver; approved expected values stay in harness state. Driver observations are diagnostics and do not replace approved source acceptance. No source changes are applied.');
 if(await confirmed(io,'Approve this journey and pinned runtime?')){await withWriter(project,'desktop approve',()=>saveApproval(project,journey,runtime));io.write('Journey approved. Select it by title in harness guide → Linux desktop apps.');}
}
export async function guideDesktop(project:string,io:Dialogue,command:GuideCommand):Promise<void>{
 const run=async(...args:string[])=>{if(await command(project,['desktop',...args]))io.write('That step stopped. Inspect the saved result and remedy before retrying.');};
 for(;;){
  const approvals=await listApprovals(project),runs=await listDesktopRuns(project);
  const actions:{label:string;run:()=>Promise<void>}[]=[
   {label:'Check Linux desktop image readiness',run:()=>run('doctor')},
   {label:'Set up and approve a GUI journey',run:()=>run('setup')},
   ...approvals.map(a=>({label:`Verify: ${a.journey.title}`,run:()=>run('verify',a.id)})),
   ...runs.map(j=>({label:`${approvals.find(a=>a.id===j.approval)?.journey.title??j.approval}: ${j.status} (${j.at})`,async run(){
    io.write(j.message);const options=['Inspect result, logs and screenshot locations'];
    if(['preparing','running'].includes(j.status))options.push('Recover resources after the writer has ended');
    else{if(j.status==='passed')options.push('Export package, runtime descriptor, report and screenshots');if(j.status!=='released')options.push('Export a retained log or screenshot','Release retained outputs');}
    const c=await choose(io,'Desktop result',options);if(c<0)return;
    const label=options[c]!;
    if(label.startsWith('Inspect'))await run('inspect',j.id);
    else if(label.startsWith('Recover'))await run('recover',j.id);
    else if(label==='Export a retained log or screenshot'){const files=(await listArtifacts(project)).filter(a=>a.producer===j.id&&(a.name.endsWith('.log')||a.name.endsWith('.png')));const selected=await choose(io,'Retained diagnostics',files.map(a=>`${a.name} (${a.size} bytes)`));if(selected>=0){const destination=(await io.ask('New diagnostic file path outside the project:')).trim();if(destination)await command(project,['artifacts','export',files[selected]!.id,destination]);}}
    else if(label.startsWith('Export')){const destination=(await io.ask('New export folder outside the project:')).trim();if(destination)await run('export',j.id,destination);}
    else if(await confirmed(io,'Release these outputs?'))await run('release',j.id,'--yes');
   }})),
   {label:'Prepare the pinned Linux desktop image (downloads tools)',async run(){io.write('Downloads Electron and Linux libraries into Docker. No project files are used.');if(await confirmed(io,'Build the local desktop image?'))await run('image');}},
  ];
  const selected=await choose(io,'Linux desktop apps',actions.map(a=>a.label));if(selected<0)return;
  try{await actions[selected]!.run();}catch(error){io.write((error as Error).message);}
 }
}
