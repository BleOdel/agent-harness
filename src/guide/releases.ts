import {listArtifacts} from '../artifacts/store.ts';
import {prepareRelease,approveRelease,dryRunRelease} from '../releases/controller.ts';
import {listReleases,readRelease,type Release} from '../releases/store.ts';
import {choose,confirmed,terminalDialogue,type Dialogue} from './dialogue.ts';
import type {GuideCommand} from '../verbs/guide.ts';
export function describeRelease(r:Release):string {
 const m=r.manifest;return `${m.name} ${m.version} · ${r.status}\nArtifact: ${m.original.name} (${m.snapshot.size} bytes)\nSHA-256: ${m.snapshot.sha256}\nInherited verification: ${m.original.verification}; this does not run new product checks.\nLocal staging folder: ${m.target}\nFiles: ${m.filename}, release.json, owner.json and receipt.json.\nNo code runs, no archive is extracted and nothing is uploaded or signed.`;
}
export async function setupRelease(project:string,io:Dialogue=terminalDialogue()):Promise<void>{
 const artifacts=(await listArtifacts(project)).filter(a=>a.verification!=='unverified'&&!/^release-[a-f0-9-]{36}$/u.test(a.producer));
 if(!artifacts.length){io.write('No eligible retained artifacts. First use Test, package and retain build outputs, or finish a supported desktop/ML verification. Unverified job output cannot be staged through this lane.');return;}
 const choice=await choose(io,'Choose the retained artifact',artifacts.map(a=>`${a.name} · ${a.verification} · ${a.size} bytes · ${a.at}`));if(choice<0)return;
 const name=(await io.ask('Release name (lowercase, for example notes):')).trim();if(!name)return;
 const version=(await io.ask('Version [1.0.0]:')).trim()||'1.0.0',destination=(await io.ask('Existing staging folder (local only):')).trim();if(!destination)return;
 const r=await prepareRelease(project,{artifact:artifacts[choice]!.id,name,version,destination});io.write(describeRelease(r));io.write('Draft saved with its own retained artifact reference. No destination files were written. Review and approve it from the release menu.');
}
export async function reviewRelease(project:string,id:string,io:Dialogue=terminalDialogue()):Promise<void>{
 const r=await readRelease(project,id);io.write(describeRelease(r));if(!['draft','approved'].includes(r.status)){io.write('This release has already started or is retired. Inspect its saved result.');return;}
 await dryRunRelease(project,id);
 if(r.approval){io.write('This exact manifest is already approved. Choose Stage in the release menu.');return;}
 if(await confirmed(io,'Approve these exact bytes, version and local destination for staging?')){await approveRelease(project,id,r.digest);io.write('Approved. Staging uses this saved choice; no need to approve it again.');}
}
export async function guideReleases(project:string,io:Dialogue,command:GuideCommand):Promise<void>{
 const run=async(...args:string[])=>{if(await command(project,['release',...args]))io.write('That release step stopped. Saved approval and staging records remain; inspect the reason before retrying.');};
 for(;;){
  const releases=await listReleases(project);const choice=await choose(io,'Release preparation (local staging)',[...releases.map(r=>`${r.manifest.name} ${r.manifest.version}: ${r.status}`),'Prepare a new release draft']);if(choice<0)return;
  if(choice===releases.length){await run('setup');continue;}
  const r=releases[choice]!;io.write(`${r.manifest.name} ${r.manifest.version}: ${r.status}. ${r.reason??''}`);
  const actions=[{label:'Inspect the manifest and local result',verb:'inspect'}];
  if(r.status==='retired'&&!r.retentionReleased)actions.push({label:'Finish interrupted reference cleanup',verb:'retire'});
  if(r.status!=='retired'){
   actions.push({label:'Dry run: check bytes, approval and destination',verb:'dry-run'});
   if(r.status==='draft')actions.push({label:'Review and approve the saved draft',verb:'review'});
   else actions.push({label:r.status==='staged'?'Verify the completed local staging':r.status==='staging'?'Resume or reconcile interrupted staging':'Stage the approved artifact locally',verb:'stage'});
   actions.push({label:'Retire this release and release its retained snapshot',verb:'retire'});
  }
  const action=await choose(io,'Release action',actions.map(a=>a.label));if(action<0)continue;const verb=actions[action]!.verb;
  if(verb==='retire'&&r.status==='retired'){await run('retire',r.id,'--yes');continue;}
  if(verb==='retire'){io.write(`Retires ${r.manifest.name} ${r.manifest.version}; staged files at ${r.manifest.target} remain. This draft will no longer stage or resume.`);if(await confirmed(io,'Retire this release?'))await run(verb,r.id,'--yes');}
  else await run(verb,r.id);
 }
}
