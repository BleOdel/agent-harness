import {readFile} from 'node:fs/promises';
import {withWriter} from '../workspace/writer-lock.ts';
import {listArtifacts} from '../artifacts/store.ts';
import {desktopSetup} from '../guide/desktop.ts';
import {buildDesktopImage,inspectDesktop} from '../desktop/runtime.ts';
import {listApprovals,listDesktopRuns,readDesktopRun,saveApproval} from '../desktop/store.ts';
import {verifyDesktop,recoverDesktop,exportDesktop,releaseDesktop} from '../desktop/controller.ts';
import {OperatorError,say} from './io.ts';
export async function desktopCommand(project:string,args:readonly string[]):Promise<void>{
 const [action,id,destination,...extra]=args;
 if(extra.length)throw new OperatorError('Too many desktop arguments.');
 if(action==='image'&&!id){await buildDesktopImage(say);return;}
 if(action==='doctor'&&!id){const r=await inspectDesktop();say(`Linux desktop ready: Electron ${r.electron}; ${r.arch}; ${r.image}.\nVirtual display inside Docker; 2 CPUs, 2 GiB RAM; offline. Packaged UI support is checked by running an approved journey.\nNative macOS, Windows, mobile, GPU and installers are deferred. Next: harness desktop setup`);return;}
 if(action==='setup'&&!id)return desktopSetup(project);
 if(action==='approve'&&id&&!destination){await withWriter(project,'desktop approve',async()=>{const a=await saveApproval(project,JSON.parse(await readFile(id,'utf8')),await inspectDesktop());say(`Approved ${a.id}: ${a.journey.title}. Continue with harness guide.`);});return;}
 if((!action||action==='list')&&!id){for(const a of await listApprovals(project))say(`${a.id}: ${a.journey.title}`);for(const j of await listDesktopRuns(project))say(`${j.id}: ${j.status} · ${j.message}`);say('Continue with harness guide → Linux desktop apps.');return;}
 if(action==='inspect'&&id&&!destination){const j=await readDesktopRun(project,id);say(JSON.stringify(j,null,2));for(const a of (await listArtifacts(project)).filter(a=>a.producer===id))say(`${a.name}: ${a.id}; ${a.size} bytes; ${a.verification}`);say('Passing results: use guide to export package, report and screenshots together. Any retained log/screenshot: harness artifacts export <artifact-id> <new-file>.');return;}
 if(action==='verify'&&id&&!destination){const j=await verifyDesktop(project,id,say);say(`Saved result: ${j.id}.`);if(j.status!=='passed')throw new OperatorError(j.message,'Inspect this result through harness guide. A retry runs the same approval against fresh source and a fresh app.');return;}
 if(action==='recover'&&id&&!destination){await recoverDesktop(project,id);say('Resources reconciled. Run the approved journey again from the beginning.');return;}
 if(action==='export'&&id&&destination){await exportDesktop(project,id,destination);say(`Exported package, runtime descriptor, report and screenshots to ${destination}. External Linux Electron runtime required; this is not an installer.`);return;}
 if(action==='release'&&id&&destination==='--yes'){await releaseDesktop(project,id);say('Desktop output references released. Use harness artifacts cleanup to reclaim unused bytes.');return;}
 throw new OperatorError('Use: harness desktop image | doctor | setup | approve <file> | list | inspect <run> | verify <journey> | recover <run> | export <run> <new-folder> | release <run> --yes');
}
