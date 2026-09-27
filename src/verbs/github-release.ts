import {prepareGitHub,readGitHub,listGitHub,approveGitHub,dryRunGitHub,uploadGitHub,publishGitHub,type GitHubDelivery} from '../releases/github.ts';
import {listReleases} from '../releases/store.ts';
import {choose,confirmed,terminalDialogue,type Dialogue} from '../guide/dialogue.ts';
import {OperatorError,say} from './io.ts';
export function describeGitHub(d:GitHubDelivery){return `${d.manifest.repository} · ${d.manifest.tag} · ${d.status}\nCommit: ${d.manifest.commit}\nArtifact: ${d.manifest.filename} (${d.manifest.size} bytes)\nSHA-256: ${d.manifest.sha256}\nInherited verification: ${d.manifest.verification}\nManifest digest: ${d.digest}\nUpload creates an unpublished prerelease draft with the artifact and SHA256SUMS.txt. Publishing is separate; no signing is performed.`;}
export async function githubSetup(project:string,io:Dialogue=terminalDialogue()):Promise<void>{
 const staged=(await listReleases(project)).filter(r=>r.status==='staged');if(!staged.length){io.write('First prepare, approve and stage a verified artifact through the local release workflow.');return;}
 const index=await choose(io,'Choose the staged artifact',staged.map(r=>`${r.manifest.name} ${r.manifest.version} · ${r.manifest.snapshot.sha256.slice(0,12)}`));if(index<0)return;
 const repository=(await io.ask('GitHub repository (owner/name):')).trim(),tag=(await io.ask('Release tag (for example v1.0.0):')).trim(),commit=(await io.ask('Exact 40-character commit SHA in that repository:')).trim();
 const d=await prepareGitHub(project,{release:staged[index]!.id,repository,tag,commit});io.write(describeGitHub(d));io.write(`Saved ${d.id}. No network request or upload was made.`);
}
export async function githubMenu(project:string,io:Dialogue=terminalDialogue()):Promise<void>{
 for(;;){const releases=await listGitHub(project),choice=await choose(io,'GitHub Releases',[...releases.map(r=>`${r.manifest.repository} ${r.manifest.tag}: ${r.status}`),'Prepare a GitHub destination']);if(choice<0)return;if(choice===releases.length){await githubSetup(project,io);continue;}
 const d=releases[choice]!;io.write(describeGitHub(d));if(d.message)io.write(d.message);
 const options=['Local dry run (no network)',...(d.status==='draft'?['Approve this destination for draft upload']:['Upload or reconcile the draft']),...(d.status==='uploaded'?['Review and publish this prerelease']:[])];
 const action=await choose(io,'GitHub release action',options);if(action<0)continue;
 try{if(action===0)io.write(JSON.stringify(await dryRunGitHub(project,d.id),null,2));
 else if(d.status==='draft'){if(await confirmed(io,'Approve these exact bytes, repository, tag and commit for draft upload?'))await approveGitHub(project,d.id,d.digest);}
 else if(action===1){io.write('Reconciling GitHub state and uploading approved missing assets.');io.write(describeGitHub(await uploadGitHub(project,d.id)));}
 else{io.write(`Publishes ${d.manifest.repository} ${d.manifest.tag} from commit ${d.manifest.commit}. The repository audience can download these artifacts; GitHub may notify watchers. This cannot guarantee removal of downloaded copies.`);if(await confirmed(io,'Publish this exact verified draft as a prerelease now?'))io.write(describeGitHub(await publishGitHub(project,d.id,d.digest)));}
 }catch(e){io.write((e as Error).message);}
 }
}
export async function githubReleaseCommand(project:string,args:readonly string[]):Promise<void>{
 const [action,id,...rest]=args;
 if(action==='setup'&&!id)return githubSetup(project);
 if(action==='menu'&&!id)return githubMenu(project);
 if((!action||action==='list')&&!id){for(const d of await listGitHub(project))say(`${d.id}: ${d.manifest.repository} ${d.manifest.tag} · ${d.status}`);return;}
 if(action==='prepare'&&id){const flags=new Map<string,string>();for(let i=0;i<rest.length;i+=2){const key=rest[i]!,value=rest[i+1];if(!['--repo','--tag','--commit'].includes(key)||!value||flags.has(key))throw new OperatorError('Use release github prepare <local-release-id> --repo owner/name --tag v1.0.0 --commit <sha>.');flags.set(key,value);}if(flags.size!==3)throw new OperatorError('GitHub preparation needs --repo, --tag and --commit.');const d=await prepareGitHub(project,{release:id,repository:flags.get('--repo')!,tag:flags.get('--tag')!,commit:flags.get('--commit')!});say(describeGitHub(d));say(`Saved draft: ${d.id}`);return;}
 if(action==='inspect'&&id&&!rest.length){say(JSON.stringify(await readGitHub(project,id),null,2));return;}
 if(action==='dry-run'&&id&&!rest.length){say(JSON.stringify(await dryRunGitHub(project,id),null,2));return;}
 if(action==='approve'&&id&&rest[0]==='--digest'&&rest.length===2){await approveGitHub(project,id,rest[1]!);say('Destination approved for draft upload. Nothing uploaded.');return;}
 if(action==='upload'&&id&&!rest.length){say('Reconciling the approved GitHub destination…');say(describeGitHub(await uploadGitHub(project,id)));return;}
 if(action==='publish'&&id&&rest[0]==='--digest'&&rest.length===2){say('Publishing the exact reviewed prerelease after verifying its assets…');say(describeGitHub(await publishGitHub(project,id,rest[1]!)));return;}
 throw new OperatorError('Use harness release github setup | menu | list | prepare <local-id> --repo <owner/name> --tag <tag> --commit <sha> | inspect <id> | dry-run <id> | approve <id> --digest <hash> | upload <id> | publish <id> --digest <hash>.');
}
