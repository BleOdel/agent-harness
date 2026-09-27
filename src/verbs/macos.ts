import {readFile,mkdir,writeFile,readdir} from 'node:fs/promises';import path from 'node:path';
import {withWriter} from '../workspace/writer-lock.ts';import {say,OperatorError} from './io.ts';import {listArtifacts} from '../artifacts/store.ts';
import {macosSetup} from '../guide/macos.ts';import {desktopScaffold} from '../desktop/scaffold.ts';
import {readGuiRuntime,prepareGuiBase,recoverGuiPreparation} from '../native/gui/provision.ts';import {validateGuiBase} from '../native/gui/verify.ts';
import {approveGui,listGuiApprovals,listGuiRuns,readGuiRun} from '../native/gui/store.ts';import {verifyGui,recoverGui} from '../native/gui/controller.ts';
export async function macosCommand(project:string,args:readonly string[]){
 const [action,id,...extra]=args;if(extra.length)throw new OperatorError('Too many macOS GUI arguments.');
 if(action==='recover-preparation'&&!id){await recoverGuiPreparation();say('GUI preparation resources recovered.');return;}
 if(action==='doctor'&&!id){const r=await readGuiRuntime();say(`macOS GUI ready: Electron ${r.electron}, ${r.profile.arch}, macOS ${r.profile.os}. Offline VM; 2 CPUs, 4 GiB RAM.\nPackaged Electron diagnostics only. Next: harness macos setup`);return;}
 if(action==='provision'&&!id){await prepareGuiBase(say);await validateGuiBase(say);return;}
 if(action==='validate'&&!id){await validateGuiBase(say);return;}
 if(action==='init'&&!id){await withWriter(project,'macOS notes starter',async()=>{if((await readdir(project)).some(f=>f!=='.DS_Store'))throw new OperatorError('Create the notes starter in an empty project folder.');for(const [file,text]of await desktopScaffold()){const p=path.join(project,file);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,text,{flag:'wx'});}say('Created a local Electron notes app. Next: harness macos setup.');});return;}
 if(action==='setup'&&!id)return macosSetup(project);
 if(action==='approve'&&id){await withWriter(project,'macOS GUI approve',async()=>{const a=await approveGui(project,JSON.parse(await readFile(id,'utf8')),await readGuiRuntime());say(`Approved ${a.id}.`);});return;}
 if((!action||action==='list')&&!id){for(const a of await listGuiApprovals(project))say(`${a.id}: ${a.journey.title}`);for(const r of await listGuiRuns(project))say(`${r.id}: ${r.status} · ${r.message}`);return;}
 if(action==='verify'&&id){const r=await verifyGui(project,id,say);say(`Saved result: ${r.id}`);if(r.status!=='passed')throw new OperatorError(r.message);return;}
 if(action==='inspect'&&id){say(JSON.stringify(await readGuiRun(project,id),null,2));for(const a of (await listArtifacts(project)).filter(a=>a.producer===id))say(`${a.name}: ${a.id}; ${a.size} bytes; ${a.verification}`);return;}
 if(action==='recover'&&id)return recoverGui(project,id);
 throw new OperatorError('Use harness macos provision | validate | recover-preparation | doctor | init | setup | approve <file> | list | verify <id> | inspect <id> | recover <id>.');
}
