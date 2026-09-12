import {listReleases,readRelease} from '../releases/store.ts';
import {prepareRelease,approveRelease,dryRunRelease,stageRelease,retireRelease} from '../releases/controller.ts';
import {setupRelease,reviewRelease,describeRelease} from '../guide/releases.ts';
import {OperatorError,say} from './io.ts';
export async function releaseCommand(project:string,args:readonly string[]):Promise<void>{
 const [action,id,extra,...rest]=args;
 if(action==='setup'&&!id)return setupRelease(project);
 if((!action||action==='list')&&(!id||id==='--json')&&!extra){const releases=await listReleases(project);if(id==='--json')say(JSON.stringify(releases));else{releases.forEach(r=>say(`${r.id} · ${r.manifest.name} ${r.manifest.version} · ${r.status}`));say('Continue with harness guide → Prepare and stage a release.');}return;}
 if(action==='prepare'&&id){const flags=new Map<string,string>();const values=args.slice(2);for(let i=0;i<values.length;i+=2){const flag=values[i]!,value=values[i+1];if(!['--name','--version','--to'].includes(flag)||!value||flags.has(flag))throw new OperatorError('Use: harness release prepare <artifact-id> --name <name> --version <version> --to <existing-folder>');flags.set(flag,value);}if(flags.size!==3)throw new OperatorError('Release preparation needs --name, --version and --to.');const r=await prepareRelease(project,{artifact:id,name:flags.get('--name')!,version:flags.get('--version')!,destination:flags.get('--to')!});say(`${describeRelease(r)}\nSaved draft: ${r.id}\nReview digest: ${r.digest}\nNo destination files written.`);return;}
 if(action==='inspect'&&id&&(!extra||extra==='--json')&&!rest.length){const r=await readRelease(project,id);say(extra==='--json'?JSON.stringify(r):`${describeRelease(r)}\nManifest digest: ${r.digest}\n${r.reason??''}`);return;}
 if(action==='review'&&id&&!extra)return reviewRelease(project,id);
 if(action==='approve'&&id&&extra==='--digest'&&rest.length===1){await approveRelease(project,id,rest[0]!);say('Exact release manifest approved. Nothing staged yet.');return;}
 if(action==='dry-run'&&id&&(!extra||extra==='--json')&&!rest.length){const result=await dryRunRelease(project,id);say(extra==='--json'?JSON.stringify(result):`Dry run passed: ${result.bytes} bytes; ${result.approved?'approved':'approval still required'}; ${result.status}.\nDestination: ${result.target}\nNo destination files written.`);return;}
 if(action==='stage'&&id&&!extra){const r=await stageRelease(project,id,async step=>say(`Local staging: ${{reserved:'destination reserved',payload:'artifact bytes copied',manifest:'release manifest saved',receipt:'completion receipt written',staged:'release record saved'}[step]??step}.`));say(`Staged ${r.manifest.name} ${r.manifest.version}: ${r.manifest.target}\nReceipt and artifact hashes verified. Nothing published.`);return;}
 if(action==='retire'&&id&&extra==='--yes'&&!rest.length){await retireRelease(project,id);say('Release retired. Audit and staged files remain; its retained snapshot reference was released.');return;}
 throw new OperatorError('Use: harness release setup | prepare <artifact-id> --name <name> --version <version> --to <folder> | list [--json] | inspect <id> [--json] | review <id> | approve <id> --digest <hash> | dry-run <id> [--json] | stage <id> | retire <id> --yes');
}
