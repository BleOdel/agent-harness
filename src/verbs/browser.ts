import {readFile} from 'node:fs/promises';
import {browserSetup} from '../guide/browser.ts';
import {buildBrowserImage,inspectBrowser} from '../browser/runtime.ts';
import {saveApproval,listApprovals,listBrowserRuns,readBrowserRun} from '../browser/store.ts';
import {verifyBrowser,recoverBrowser} from '../browser/controller.ts';
import {listArtifacts} from '../artifacts/store.ts';
import {withWriter} from '../workspace/writer-lock.ts';
import {OperatorError,say} from './io.ts';
export async function browserCommand(project:string,args:readonly string[]):Promise<void>{
 const [action,id,...extra]=args;if(extra.length)throw new OperatorError('Too many browser arguments.');
 if(action==='image'&&!id)return buildBrowserImage(say);
 if(action==='doctor'&&!id){const r=await inspectBrowser();say(`Browser ready: Chromium ${r.chromium}, Playwright ${r.playwright}, axe ${r.axe}; Linux ${r.arch}.\nOffline application and browser containers; dependency-free Node servers.\nNext: harness browser setup`);return;}
 if(action==='setup'&&!id)return browserSetup(project);
 if(action==='approve'&&id){await withWriter(project,'browser approve',async()=>{const a=await saveApproval(project,JSON.parse(await readFile(id,'utf8')),await inspectBrowser());say(`Approved ${a.id}: ${a.journey.title}. Run through harness guide → Browser UI checks.`);});return;}
 if((!action||action==='list')&&!id){for(const a of await listApprovals(project))say(`${a.id}: ${a.journey.title}`);for(const r of await listBrowserRuns(project))say(`${r.id}: ${r.status} · ${r.message}`);return;}
 if(action==='verify'&&id){const r=await verifyBrowser(project,id,say);say(`Saved result: ${r.id}`);if(r.status!=='passed')throw new OperatorError(r.message);return;}
 if(action==='recover'&&id)return recoverBrowser(project,id);
 if(action==='inspect'&&id){const r=await readBrowserRun(project,id);say(JSON.stringify(r,null,2));for(const a of (await listArtifacts(project)).filter(a=>a.producer===id))say(`${a.name}: ${a.id}; ${a.size} bytes`);say('Export a screenshot or report: harness artifacts export <artifact-id> <new-file>');return;}
 throw new OperatorError('Use harness browser image | doctor | setup | approve <file> | list | verify <journey-id> | inspect <run-id> | recover <run-id>.');
}
