import {constants} from 'node:fs';
import {lstat,readFile,realpath,readdir,open,link,unlink} from 'node:fs/promises';
import path from 'node:path';
import {sha256,ARTIFACT_LIMITS} from '../artifacts/store.ts';
import {syncDirectory} from '../workspace/atomic.ts';
import {canonicalProject} from '../workspace/writer-lock.ts';
import {OperatorError} from '../verbs/io.ts';
import type {Manifest,Release} from './store.ts';
const fail=(message:string):never=>{throw new OperatorError(message);};
export const jsonBytes=(value:unknown)=>Buffer.from(JSON.stringify(value,null,2)+'\n');
export const ownerBytes=(r:Release)=>jsonBytes({schema:1,id:r.id,token:r.token,digest:r.digest});
export const receiptBytes=(r:Release)=>jsonBytes({schema:1,release:r.id,manifestDigest:r.digest,artifactSha256:r.manifest.snapshot.sha256,filename:r.manifest.filename,at:r.deliveryAt,localOnly:true});
async function stat(file:string){try{return await lstat(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}}
export async function destination(project:string,raw:string,name:string,version:string):Promise<Pick<Manifest,'parent'|'target'>>{
 if(typeof raw!=='string'||!raw.trim())fail('Choose an existing local staging folder.');
 const parent=await realpath(path.resolve(raw)),info=await lstat(parent,{bigint:true});if(!info.isDirectory())fail('The staging parent must be an existing directory.');
 const target=path.join(parent,`${name}-${version}`),live=await canonicalProject(project);
 if([live,`${live}-harness`].some(root=>target===root||target.startsWith(root+path.sep)||root.startsWith(target+path.sep)))fail('Choose a staging destination outside project source and harness state.');
 return {parent:{path:parent,device:String(info.dev),inode:String(info.ino)},target};
}
export async function validateDestination(project:string,r:Release):Promise<boolean>{
 const current=await destination(project,r.manifest.parent.path,r.manifest.name,r.manifest.version);
 if(JSON.stringify(current.parent)!==JSON.stringify(r.manifest.parent)||current.target!==r.manifest.target)fail('Staging destination changed since review. Create a new release draft.');
 const target=await stat(r.manifest.target);if(!target)return false;
 if(!target.isDirectory()||target.isSymbolicLink()||await realpath(r.manifest.target)!==r.manifest.target)fail('Staging target is an unsafe directory or symlink.');return true;
}
export async function checkedFile(directory:string,name:string,expected:Buffer):Promise<boolean>{
 const file=path.join(directory,name),info=await stat(file);if(!info)return false;
 const pending=await stat(path.join(directory,`.pending-${name}`));
 // A crash after link but before unlink has one recognized, identical pending link.
 const linked=info.nlink===2&&pending?.isFile()&&!pending.isSymbolicLink()&&pending.ino===info.ino&&pending.dev===info.dev&&pending.nlink===2;
 if(!info.isFile()||info.isSymbolicLink()||(info.nlink!==1&&!linked)||info.size!==expected.length||info.size>ARTIFACT_LIMITS.file)fail(`Staged ${name} is linked, oversized or changed.`);
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{if(sha256(await handle.readFile())!==sha256(expected))fail(`Staged ${name} hash mismatch; refusing overwrite.`);}finally{await handle.close();}return true;
}
export async function checkOwned(r:Release):Promise<void>{
 try{if(!await checkedFile(r.manifest.target,'owner.json',ownerBytes(r))&&!await checkedFile(r.manifest.target,'.pending-owner.json',ownerBytes(r)))fail('Staging ownership is absent. Inspect the existing folder; it will not be overwritten.');}
 catch(error){fail(`Staging ownership mismatch or unavailable: ${(error as Error).message}`);}
 const allowed=new Set(['owner.json',r.manifest.filename,'release.json','receipt.json']);
 for(const name of await readdir(r.manifest.target)){
  if(allowed.has(name))continue;
  if(name.startsWith('.pending-')&&allowed.has(name.slice(9))){const info=(await stat(path.join(r.manifest.target,name)))!;if(info.isFile()&&!info.isSymbolicLink()&&info.nlink<=2&&info.size<=ARTIFACT_LIMITS.file)continue;}
  fail(`Unexpected file in the owned staging folder: ${name}. Preserve it and inspect before retrying.`);
 }
}
/** Installs one complete file without replacing an existing destination. */
export async function installFile(directory:string,name:string,bytes:Buffer):Promise<void>{
 const target=path.join(directory,name),temporary=path.join(directory,`.pending-${name}`);
 if(await checkedFile(directory,name,bytes)){
  const pending=await stat(temporary);if(pending){const complete=(await stat(target))!;if(pending.nlink===2&&pending.ino===complete.ino&&pending.dev===complete.dev)await unlink(temporary);else fail(`Unexpected pending file for completed ${name}.`);}return;
 }
 const prior=await stat(temporary);if(prior){if(!prior.isFile()||prior.isSymbolicLink()||prior.nlink!==1)fail('Unsafe partial staging file.');await unlink(temporary);}
 const handle=await open(temporary,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
 await link(temporary,target);await unlink(temporary);await syncDirectory(directory);
}
