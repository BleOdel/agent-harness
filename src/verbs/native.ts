import {readFile} from 'node:fs/promises';
import {nativeRoot,readNativeProfile} from '../native/provision.ts';import {prepareNativeBase} from '../native/prepare.ts';import {registerPreparedNative} from '../native/verify.ts';
import {approveNative,listNativeApprovals,listNativeRuns,readNativeRun} from '../native/store.ts';import {verifyNative,recoverNative} from '../native/controller.ts';
import {choose,confirmed,terminalDialogue,type Dialogue} from '../guide/dialogue.ts';import {withWriter} from '../workspace/writer-lock.ts';import {OperatorError,say} from './io.ts';
import type {GuideCommand} from './guide.ts';
export async function nativeSetup(project:string,io:Dialogue=terminalDialogue(),probe=readNativeProfile){
 const profile=await probe(false);io.write(`Native macOS ${profile.os}, arm64, 2 CPUs, 4096 MiB. Runs a .sh script in a disposable offline VM.`);
 const title=await io.ask('What should this native check demonstrate?'),entry=(await io.ask('Relative .sh script path:')).trim();
 const timeoutSeconds=Number((await io.ask('Time limit including VM startup (Enter for 180 seconds, maximum 600):')).trim()||180);
 const stdout=(await io.ask('Exact expected output (use \\n for newline):')).replaceAll('\\n','\n');
 const artifacts=(await io.ask('Files to retain, relative to the script working directory (comma-separated, or Enter for none):')).split(',').map(s=>s.trim()).filter(Boolean);
 const check={version:1,title,entry,timeoutSeconds,expectedExit:0,stdout,artifacts};io.write(JSON.stringify(check,null,2));io.write('CPU/RAM and wall time are bounded. Root-disk growth uses a free-space watchdog, not a hard quota. No GUI, emulator, GPU or signing claim.');
 if(await confirmed(io,'Approve these native script observations?'))await withWriter(project,'native approve',async()=>{const a=await approveNative(project,check,profile);io.write(`Saved ${a.id}. Select it through harness guide → Native macOS checks.`);});
}
export async function nativeMenu(project:string,io:Dialogue,command:GuideCommand){for(;;){
 const approvals=await listNativeApprovals(project),runs=await listNativeRuns(project),actions=[{label:'Check native readiness',args:['doctor']},{label:'Prepare and verify the macOS base VM',args:['provision']},{label:'Set up a native script check',args:['setup']},...approvals.map(a=>({label:`Verify: ${a.check.title}`,args:['verify',a.id]})),...runs.map(r=>({label:`${r.status}: ${r.id}`,args:['inspect',r.id]}))];
 const choice=await choose(io,'Native macOS checks',actions.map(a=>a.label));if(choice<0)return;
 if(choice===1){io.write('Downloads Tart and a macOS image if missing (about 27 GB compressed), then verifies disposable VMs. Preparation uses network access with no project source. At least 65 GiB free is recommended before download.');if(!await confirmed(io,'Prepare this local native runtime?'))continue;}
 const selected=actions[choice]!;if(await command(project,['native',...selected.args]))io.write('That step stopped; saved diagnostics show what needs attention.');
 const inspected=runs.find(r=>r.id===selected.args[1]);if(selected.args[0]==='inspect'&&inspected&&['preparing','running'].includes(inspected.status)&&await confirmed(io,'Recover this run’s ended writer and owned VM resources?'))await command(project,['native','recover',inspected.id]);
}}
export async function nativeCommand(project:string,args:readonly string[]){const [action,id,...rest]=args;if(rest.length)throw new OperatorError('Too many native arguments.');
 if(action==='doctor'&&!id){const p=await readNativeProfile();say(`Native base ready: macOS ${p.os}, ${p.arch}; 2 CPUs, 4096 MiB.\nOffline script diagnostics; no native GUI, emulator or GPU verification.\nRuntime state: ${nativeRoot}`);return;}
 if(action==='provision'&&!id){const p=await prepareNativeBase(say);const osVersion=p.facts.split('\n')[0]!;await registerPreparedNative(p.image,osVersion,say);say('Native offline runtime verified and registered. Next: harness native setup.');return;}
 if(action==='revalidate'&&!id){const p=JSON.parse(await readFile(nativeRoot+'/profile.json','utf8'));await registerPreparedNative(p.image,p.os,say);say('Current native runtime revalidated. Review checks again before using the changed runtime.');return;}
 if(action==='setup'&&!id)return nativeSetup(project);
 if(action==='approve'&&id){await withWriter(project,'native approve',async()=>{const a=await approveNative(project,JSON.parse(await readFile(id,'utf8')),await readNativeProfile());say(`Approved ${a.id}.`);});return;}
 if((!action||action==='list')&&!id){for(const a of await listNativeApprovals(project))say(`${a.id}: ${a.check.title}`);for(const r of await listNativeRuns(project))say(`${r.id}: ${r.status} · ${r.message}`);return;}
 if(action==='verify'&&id){const r=await verifyNative(project,id,say);say(`Saved: ${r.id}`);if(r.status!=='passed')throw new OperatorError(r.message);return;}
 if(action==='inspect'&&id){const r=await readNativeRun(project,id);say(JSON.stringify(r,null,2));if(['preparing','running'].includes(r.status))say(`Recover resources after the writer ends: harness native recover ${id}`);return;}
 if(action==='recover'&&id)return recoverNative(project,id);
 throw new OperatorError('Use harness native provision | revalidate | doctor | setup | approve <file> | list | verify <id> | inspect <id> | recover <id>.');
}
