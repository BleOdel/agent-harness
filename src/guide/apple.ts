import {readFile} from 'node:fs/promises';
import {parseAppleJourney} from '../native/apple/schema.ts';import type {Step} from '../desktop/schema.ts';
import {appleNotesJourney} from '../native/apple/scaffold.ts';import {readAppleRuntime} from '../native/apple/runtime.ts';
import {approveApple,listAppleApprovals,listAppleRuns} from '../native/apple/store.ts';
import {listArtifacts} from '../artifacts/store.ts';import {withWriter} from '../workspace/writer-lock.ts';
import {choose,confirmed,terminalDialogue,type Dialogue} from './dialogue.ts';import type {GuideCommand} from '../verbs/guide.ts';
export async function appleSetup(project:string,io:Dialogue=terminalDialogue(),probe=readAppleRuntime):Promise<void>{
 const runtime=await probe();io.write(`SwiftUI/AppKit on macOS ${runtime.profile.os}. Offline VM: 2 CPUs, 4 GiB RAM. Native accessibility diagnostics; no mobile, Windows or GPU claim. Guest-only Accessibility, input and screenshot grants expire with each VM.`);
 const saved=await listAppleApprovals(project);
 const choice=await choose(io,'Journey to review',['Starter notes: keyboard save, restart, invalid input and screenshot','Create a journey with short prompts','Read a journey file',...saved.map(a=>`Review saved: ${a.journey.title}`)]);if(choice<0)return;
 let raw:unknown;
 if(choice>=3)raw=saved[choice-3]!.journey;
 else if(choice===0)raw={...appleNotesJourney,timeoutSeconds:300};
 else if(choice===2)raw=JSON.parse(await readFile((await io.ask('Journey file path:')).trim(),'utf8'));
 else{
  const entry=(await io.ask('Relative build script (Enter for build.sh):')).trim()||'build.sh',app=(await io.ask('Built app bundle (Enter for build/Notes.app):')).trim()||'build/Notes.app';
  const title=await io.ask('What should this journey prove?'),timeoutSeconds=Number((await io.ask('Time limit in seconds (Enter for 300, maximum 600):')).trim()||300),steps:Step[]=[];
  while(steps.length<30){
   const action=await choose(io,'Add a step',['Fill an input','Click an element','Press a key','Check exact text','Count matching identifiers','Restart app','Take screenshot','Finish and review']);if(action<0)return;if(action===7)break;
   const selector=action<5?await io.ask('Accessibility identifier from the app (for example note or save):'):'';
   if(action===0)steps.push({action:'fill',selector,value:await io.ask('Text to enter:')});
   if(action===1)steps.push({action:'click',selector});
   if(action===2)steps.push({action:'press',selector,key:await io.ask('Key: Enter, Tab, Space, Escape, ArrowUp or ArrowDown:')});
   if(action===3)steps.push({action:'text',selector,expected:await io.ask('Expected exact text:')});
   if(action===4)steps.push({action:'count',selector,expected:Number(await io.ask('Expected count (0–1000):'))});
   if(action===5)steps.push({action:'restart'});if(action===6)steps.push({action:'screenshot'});
  }
  raw={version:1,title,timeoutSeconds,entry,app,steps};
 }
 const journey=parseAppleJourney(raw);io.write(`${journey.title} · ${journey.timeoutSeconds}s total limit including VM boot, build and UI steps.`);journey.steps.forEach((step,i)=>io.write(`${i+1}. ${JSON.stringify(step)}`));
 io.write(`Build: ${journey.entry}; output: ${journey.app}.`);
 io.write('Actions go to the app driver; approved expected values stay in harness state. Driver observations are diagnostics and do not replace approved source acceptance. No source changes are applied.');
 if(await confirmed(io,'Approve this journey and pinned runtime?')){await withWriter(project,'native UI approve',()=>approveApple(project,journey,runtime));io.write('Journey approved. Select it by title in harness guide → SwiftUI/AppKit apps.');}
}

export async function guideApple(project:string,io:Dialogue,command:GuideCommand){
 for(;;){
  const approvals=await listAppleApprovals(project),runs=await listAppleRuns(project);
  const actions=[{label:'Check native UI readiness',args:['doctor']},{label:'Validate SwiftUI/AppKit automation',args:['validate']},{label:'Set up and approve a GUI journey',args:['setup']},{label:'Create a SwiftUI notes starter in this empty project',args:['init','swiftui']},{label:'Create an AppKit notes starter in this empty project',args:['init','appkit']},...approvals.map(a=>({label:`Verify: ${a.journey.title}`,args:['verify',a.id]})),...runs.map(r=>({label:`${r.status}: ${approvals.find(a=>a.id===r.approval)?.journey.title??r.id}`,args:['inspect',r.id]}))];
  const selected=await choose(io,'SwiftUI/AppKit apps',actions.map(a=>a.label));if(selected<0)return;const action=actions[selected]!;
  if(selected===1){io.write('Builds and exercises SwiftUI/AppKit fixtures and a broken-persistence control in disposable offline VMs. Uses the installed Swift compiler; no Xcode download. Takes several minutes. Guest driver permissions never affect host settings.');if(!await confirmed(io,'Run native UI validation?'))continue;}
  try{
   await command(project,['macos-native',...action.args]);const record=runs.find(r=>r.id===action.args[1]);if(!record)continue;
   if(['preparing','running'].includes(record.status)){if(await confirmed(io,'Recover resources after this writer ends?'))await command(project,['macos-native','recover',record.id]);}
   else{
    const files=(await listArtifacts(project)).filter(a=>a.producer===record.id);const index=await choose(io,'Export retained evidence (0 to return)',files.map(a=>`${a.name} (${a.size} bytes)`));if(index>=0){const target=(await io.ask('New output file path outside the project:')).trim();if(target)await command(project,['artifacts','export',files[index]!.id,target]);}
   }
  }catch(e){io.write((e as Error).message);}
 }
}
