import { listDesktopRuns } from '../desktop/store.ts';
import { listArtifacts, exportArtifact, artifactBytes, collectArtifacts, releaseArtifacts } from '../artifacts/store.ts';
import { listMl, readMlState } from '../ml/store.ts';
import { listJobs } from '../jobs/state.ts';
import { withWriter } from '../workspace/writer-lock.ts';
import { OperatorError, say } from './io.ts';
export async function artifactsCommand(project:string,args:readonly string[]):Promise<void>{
 const [action,id,destination,...extra]=args;
 if((!action||action==='list')&&(!id||id==='--json')&&!destination){const all=await listArtifacts(project);if(id==='--json')say(JSON.stringify(all));else{for(const a of all)say(`${a.id} · ${a.name} · ${a.size} bytes · ${a.verification} · ${a.producer}`);if(!all.length)say('No retained artifacts. Use harness verify --retain, or run a saved job.');}return;}
 if(action==='inspect'&&id&&!destination){await artifactBytes(project,id);say(JSON.stringify((await listArtifacts(project)).find(a=>a.id===id),null,2));return;}
 if(action==='export'&&id&&destination&&!extra.length){await withWriter(project,'artifact export',()=>exportArtifact(project,id,destination));say(`Exported verified bytes to ${destination}. Content remains unverified unless its manifest says otherwise; nothing published.`);return;}
 if(action==='release'&&id&&destination==='--yes'&&!extra.length){await withWriter(project,'artifact release',async()=>{const protectedIds=new Set((await listJobs(project)).filter(j=>j.status!=='released').map(j=>j.id));for(const a of await listMl(project))if((await readMlState(project,a.id)).status!=='released')protectedIds.add(a.id);for(const j of await listDesktopRuns(project))if(j.status!=='released')protectedIds.add(j.id);await releaseArtifacts(project,id,protectedIds);});say('Producer references released. Use harness artifacts cleanup to reclaim bytes.');return;}
 if(action==='cleanup'&&!id){const count=await withWriter(project,'artifact cleanup',()=>collectArtifacts(project));say(`Removed ${count} unreferenced blobs; all referenced artifacts preserved.`);return;}
 throw new OperatorError('Use: harness artifacts list [--json] | inspect <id> | export <id> <new-file> | release <producer> --yes | cleanup');
}
