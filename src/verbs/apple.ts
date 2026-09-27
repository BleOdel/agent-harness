import {readFile,mkdir,writeFile,readdir} from 'node:fs/promises';import path from 'node:path';
import {withWriter} from '../workspace/writer-lock.ts';import {say,OperatorError} from './io.ts';import {listArtifacts} from '../artifacts/store.ts';
import {appleSetup} from '../guide/apple.ts';import {appleScaffold} from '../native/apple/scaffold.ts';
import {readAppleRuntime} from '../native/apple/runtime.ts';import {validateApple} from '../native/apple/verify.ts';
import {approveApple,listAppleApprovals,listAppleRuns,readAppleRun} from '../native/apple/store.ts';import {verifyApple,recoverApple} from '../native/apple/controller.ts';
export async function appleCommand(project:string,args:readonly string[]){
 const [action,id,...extra]=args;if(extra.length)throw new OperatorError('Too many SwiftUI/AppKit arguments.');
 if(action==='doctor'&&!id){const r=await readAppleRuntime();say(`SwiftUI/AppKit ready: ${r.profile.arch}, macOS ${r.profile.os}. Offline VM; 2 CPUs, 4 GiB RAM.\nNative accessibility diagnostics; permissions apply only inside each disposable guest. Next: harness macos-native setup`);return;}
 if(action==='validate'&&!id){await validateApple(say);return;}
 if(action==='init'&&(!id||id==='swiftui'||id==='appkit')){await withWriter(project,'macOS notes starter',async()=>{if((await readdir(project)).some(f=>f!=='.DS_Store'))throw new OperatorError('Create the notes starter in an empty project folder.');for(const [file,text]of await appleScaffold(id as 'swiftui'|'appkit'|undefined)){const p=path.join(project,file);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,text,{flag:'wx'});}say('Created a native notes app. Next: harness macos-native setup.');});return;}
 if(action==='setup'&&!id)return appleSetup(project);
 if(action==='approve'&&id){await withWriter(project,'SwiftUI/AppKit approve',async()=>{const a=await approveApple(project,JSON.parse(await readFile(id,'utf8')),await readAppleRuntime());say(`Approved ${a.id}.`);});return;}
 if((!action||action==='list')&&!id){for(const a of await listAppleApprovals(project))say(`${a.id}: ${a.journey.title}`);for(const r of await listAppleRuns(project))say(`${r.id}: ${r.status} · ${r.message}`);return;}
 if(action==='verify'&&id){const r=await verifyApple(project,id,say);say(`Saved result: ${r.id}`);if(r.status!=='passed')throw new OperatorError(r.message);return;}
 if(action==='inspect'&&id){say(JSON.stringify(await readAppleRun(project,id),null,2));for(const a of (await listArtifacts(project)).filter(a=>a.producer===id))say(`${a.name}: ${a.id}; ${a.size} bytes; ${a.verification}`);return;}
 if(action==='recover'&&id)return recoverApple(project,id);
 throw new OperatorError('Use harness macos-native validate | doctor | init [swiftui|appkit] | setup | approve <file> | list | verify <id> | inspect <id> | recover <id>.');
}
