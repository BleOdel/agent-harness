/** Controller-owned blobs and provenance. Workers never mount this store. */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, unlink, open } from 'node:fs/promises';
import path from 'node:path';
import { canonicalProject } from '../workspace/writer-lock.ts';
import { safePath } from '../workspace/safe-path.ts';
import { atomicBytes } from '../workspace/atomic.ts';
import { OperatorError } from '../verbs/io.ts';
export const ARTIFACT_LIMITS = { file:32*1024*1024, batch:64*1024*1024, store:512*1024*1024, manifests:256 } as const;
const pending = (name:string):boolean => /^\.harness-write-[a-f0-9-]{36}$/u.test(name);
export const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
export const artifactName = (name: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_./+-]{0,199}$/u.test(name) && name.split('/').every(p=>p!=='.'&&p!=='..'&&p!=='');
export interface Provenance { producer:string; input:string; environment:string; verification:'unverified'|'diagnostics-passed'|'evaluation-passed'; evaluation?:{approval:string;reportHash:string}; }
export interface Artifact extends Provenance { version:1; id:string; name:string; sha256:string; size:number; at:string; }
export async function stateRoot(project:string):Promise<string> {
 const root=`${await canonicalProject(project)}-harness`;
 await safeDirectory(root); return root;
}
export async function safeDirectory(directory:string):Promise<void> {
 const parent=path.dirname(directory); if(parent!==directory) {
  const actual=await realpath(parent).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return undefined;throw e;});
  if(actual===undefined) await safeDirectory(parent);
  else if(actual!==parent) throw new OperatorError(`State directory contains a symlink: ${directory}`);
 }
 try {await mkdir(directory,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
 const stat=await lstat(directory); if(!stat.isDirectory()||stat.isSymbolicLink())throw new OperatorError(`Unsafe state directory or symlink: ${directory}`);
}
async function store(project:string):Promise<string> {
 const directory=path.join(await stateRoot(project),'artifacts');
 await safeDirectory(directory);for(const name of ['blobs','manifests'])await safeDirectory(path.join(directory,name));return directory;
}
export async function saveJson(root:string,file:string,value:unknown):Promise<void> {await atomicBytes(await safePath(root,file),Buffer.from(JSON.stringify(value,null,2)+'\n'),0o600);}
export async function readJson(root:string,file:string):Promise<unknown> {const target=await safePath(root,file);if((await lstat(target)).size>2*1024*1024)throw new OperatorError('State file exceeds 2 MiB.');return JSON.parse(await readFile(target,'utf8'));}
function parseArtifact(value:unknown):Artifact {
 const a=value as Artifact;
 if(!a||a.version!==1||!/^artifact-[a-f0-9-]{36}$/u.test(a.id)||!artifactName(a.name)||!/^[-a-zA-Z0-9]+$/u.test(a.producer)||![a.input,a.environment,a.sha256].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v))||!Number.isSafeInteger(a.size)||a.size<0||a.size>ARTIFACT_LIMITS.file||!['unverified','diagnostics-passed','evaluation-passed'].includes(a.verification)||!Number.isFinite(Date.parse(a.at)))throw new OperatorError('Invalid artifact manifest.');
 if(a.verification==='evaluation-passed'&&(!a.evaluation||![a.evaluation.approval,a.evaluation.reportHash].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v))))throw new OperatorError('Evaluated artifacts require an approval and report identity.');return a;
}
export async function listArtifacts(project:string):Promise<Artifact[]> {
 const root=await store(project), files=(await readdir(path.join(root,'manifests'))).filter(name=>!pending(name)).sort();
 if(files.length>ARTIFACT_LIMITS.manifests)throw new OperatorError('Artifact manifest limit exceeded.');
 const artifacts:Artifact[]=[];for(const file of files){if(!/^artifact-[a-f0-9-]{36}\.json$/u.test(file))throw new OperatorError('Unexpected artifact manifest file.');const a=parseArtifact(await readJson(root,`manifests/${file}`));if(`${a.id}.json`!==file)throw new OperatorError('Artifact identity mismatch.');artifacts.push(a);}return artifacts;
}
export async function putArtifact(project:string,name:string,bytes:Buffer,provenance:Provenance):Promise<Artifact> {
 if(!artifactName(name))throw new OperatorError('Invalid artifact name/path.');
 if(bytes.length>ARTIFACT_LIMITS.file)throw new OperatorError('Artifact exceeds 32 MiB limit.');
 const root=await store(project), manifests=await listArtifacts(project);
 if(manifests.length>=ARTIFACT_LIMITS.manifests)throw new OperatorError('Artifact retention limit reached. Use harness artifacts cleanup after releasing finished jobs.');
 const a=parseArtifact({version:1,id:`artifact-${randomUUID()}`,name,sha256:sha256(bytes),size:bytes.length,at:new Date().toISOString(),...provenance});
 let size=0;const blobs=(await readdir(path.join(root,'blobs'))).filter(name=>!pending(name));
 for(const blob of blobs){if(!/^[a-f0-9]{64}$/u.test(blob))throw new OperatorError('Unexpected blob name.');size+=(await lstat(await safePath(root,`blobs/${blob}`))).size;}
 if(size+(blobs.includes(a.sha256)?0:bytes.length)>ARTIFACT_LIMITS.store)throw new OperatorError('Artifact store limit (512 MiB) reached. Release unused results, then run harness artifacts cleanup.');
 const target=await safePath(root,`blobs/${a.sha256}`);
 if(blobs.includes(a.sha256)){if(sha256(await readFile(target))!==a.sha256)throw new OperatorError('Existing artifact blob is corrupt.');}
 else await atomicBytes(target,bytes,0o600);
 await saveJson(root,`manifests/${a.id}.json`,a);return a;
}
export async function artifactBytes(project:string,id:string):Promise<Buffer>{
 const a=(await listArtifacts(project)).find(a=>a.id===id);if(!a)throw new OperatorError(`Unknown artifact ${id}. Use harness artifacts list.`);
 const root=await store(project),file=await safePath(root,`blobs/${a.sha256}`),stat=await lstat(file);
 if(stat.size!==a.size)throw new OperatorError('Artifact size/hash mismatch; blob is corrupt.');
 const bytes=await readFile(file);if(sha256(bytes)!==a.sha256)throw new OperatorError('Artifact hash mismatch; blob is corrupt.');return bytes;
}
export async function exportArtifact(project:string,id:string,destination:string):Promise<void>{
 const bytes=await artifactBytes(project,id),parent=await realpath(path.dirname(path.resolve(destination))),absolute=path.join(parent,path.basename(destination));
 const canonical=await canonicalProject(project),state=await stateRoot(project);
 if([canonical,state].some(root=>absolute===root||absolute.startsWith(root+path.sep)))throw new OperatorError('Export outside project source and harness state. Choose a separate output folder.');
 const handle=await open(absolute,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
}
export async function releaseArtifacts(project:string,producer:string,protectedProducers:ReadonlySet<string>):Promise<void>{
 if(/^release-[a-f0-9-]{36}$/u.test(producer)&&await (await import('../releases/store.ts')).releaseProtected(project,producer))throw new OperatorError('Release snapshot is retained. Retire its release before removing these artifact references.');
 if(protectedProducers.has(producer))throw new OperatorError('Cannot release artifacts referenced by an active or recoverable job/workflow. Retire it through harness guide (job release, ml release or desktop release) first.');
 const root=await store(project);for(const a of await listArtifacts(project))if(a.producer===producer)await unlink(await safePath(root,`manifests/${a.id}.json`));
}
export async function collectArtifacts(project:string):Promise<number>{
 const root=await store(project),referenced=new Set((await listArtifacts(project)).map(a=>a.sha256));let removed=0;
 for(const blob of await readdir(path.join(root,'blobs'))){if(pending(blob)){await unlink(await safePath(root,`blobs/${blob}`));removed++;continue;}if(!/^[a-f0-9]{64}$/u.test(blob))throw new OperatorError('Unexpected blob name.');if(!referenced.has(blob)){await unlink(await safePath(root,`blobs/${blob}`));removed++;}}
 for(const file of await readdir(path.join(root,'manifests')))if(pending(file))await unlink(await safePath(root,`manifests/${file}`));
 return removed;
}
