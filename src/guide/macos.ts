import {readFile} from 'node:fs/promises';
import {parseMacJourney} from '../native/gui/schema.ts';import type {Step} from '../desktop/schema.ts';
import {notesJourney} from '../desktop/scaffold.ts';import {readGuiRuntime} from '../native/gui/provision.ts';
import {approveGui,listGuiApprovals,listGuiRuns} from '../native/gui/store.ts';
import {listArtifacts} from '../artifacts/store.ts';import {withWriter} from '../workspace/writer-lock.ts';
import {choose,confirmed,terminalDialogue,type Dialogue} from './dialogue.ts';import type {GuideCommand} from '../verbs/guide.ts';
export async function macosSetup(project:string,io:Dialogue=terminalDialogue(),probe=readGuiRuntime):Promise<void>{
 const runtime=await probe();io.write(`macOS Electron ${runtime.electron}. Offline VM: 2 CPUs, 4 GiB RAM. Electron GUI diagnostics; no SwiftUI, mobile, Windows or GPU claim.`);
 const saved=await listGuiApprovals(project);
 const choice=await choose(io,'Journey to review',['Starter notes: keyboard save, restart, invalid input and screenshot','Create a journey with short prompts','Read a journey file',...saved.map(a=>`Review saved: ${a.journey.title}`)]);if(choice<0)return;
 let raw:unknown;
 if(choice>=3)raw=saved[choice-3]!.journey;
 else if(choice===0)raw={...notesJourney,timeoutSeconds:180};
 else if(choice===2)raw=JSON.parse(await readFile((await io.ask('Journey file path:')).trim(),'utf8'));
 else{
  const title=await io.ask('What should this journey prove?'),timeoutSeconds=Number((await io.ask('Time limit in seconds (Enter for 180, maximum 300):')).trim()||180),steps:Step[]=[];
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
 const journey=parseMacJourney(raw);io.write(`${journey.title} · ${journey.timeoutSeconds}s total limit including VM boot, packaging and UI steps.`);journey.steps.forEach((step,i)=>io.write(`${i+1}. ${JSON.stringify(step)}`));
 io.write('Actions go to the app driver; approved expected values stay in harness state. Driver observations are diagnostics and do not replace approved source acceptance. No source changes are applied.');
 if(await confirmed(io,'Approve this journey and pinned runtime?')){await withWriter(project,'macOS GUI approve',()=>approveGui(project,journey,runtime));io.write('Journey approved. Select it by title in harness guide → macOS GUI apps.');}
}

export async function guideMacos(project:string,io:Dialogue,command:GuideCommand){
 for(;;){
  const approvals=await listGuiApprovals(project),runs=await listGuiRuns(project);
  const actions=[{label:'Check macOS GUI readiness',args:['doctor']},{label:'Prepare and verify macOS GUI tools',args:['provision']},{label:'Set up and approve a GUI journey',args:['setup']},{label:'Recover interrupted tool preparation',args:['recover-preparation']},...approvals.map(a=>({label:`Verify: ${a.journey.title}`,args:['verify',a.id]})),...runs.map(r=>({label:`${r.status}: ${approvals.find(a=>a.id===r.approval)?.journey.title??r.id}`,args:['inspect',r.id]}))];
  const selected=await choose(io,'macOS GUI apps',actions.map(a=>a.label));if(selected<0)return;const action=actions[selected]!;
  if(selected===1){io.write('Downloads a pinned Electron archive and UI tools, then verifies an offline copy of the macOS VM. This adds roughly 1–2 GiB and takes several minutes. No project source is installed in the base.');if(!await confirmed(io,'Prepare and verify this GUI runtime?'))continue;}
  try{
   await command(project,['macos',...action.args]);const record=runs.find(r=>r.id===action.args[1]);if(!record)continue;
   if(['preparing','running'].includes(record.status)){if(await confirmed(io,'Recover resources after this writer ends?'))await command(project,['macos','recover',record.id]);}
   else{
    const files=(await listArtifacts(project)).filter(a=>a.producer===record.id);const index=await choose(io,'Export retained evidence (0 to return)',files.map(a=>`${a.name} (${a.size} bytes)`));if(index>=0){const target=(await io.ask('New output file path outside the project:')).trim();if(target)await command(project,['artifacts','export',files[index]!.id,target]);}
   }
  }catch(e){io.write((e as Error).message);}
 }
}
