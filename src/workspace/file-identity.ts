/** Portable source semantics: content plus whether any executable bit is set. */
import {createHash} from 'node:crypto';
import {lstat,readFile} from 'node:fs/promises';
export type IdentityVersion=1|2;
export function portableMode(mode:number):number {
 if(mode&0o7000)throw Error('Privileged permission bits are not supported in source files.');
 return mode&0o111?0o755:0o644;
}
export function fileIdentity(bytes:Buffer,mode:number,version:IdentityVersion=2):string {
 const hash=createHash('sha256').update(bytes).digest('hex');
 return version===1?hash:`v2:${portableMode(mode).toString(8)}:${hash}`;
}
export function identityMode(identity:string):number {
 if(!/^v2:(644|755):[a-f0-9]{64}$/.test(identity))throw Error('Legacy or invalid file identity; executable metadata is unavailable.');
 return Number.parseInt(identity.split(':')[1]!,8);
}
export function contentDigest(identity:string|undefined):string|undefined {return identity?.startsWith('v2:')?identity.slice(7):identity;}
export async function identityAt(file:string,version:IdentityVersion=2):Promise<string|undefined>{
 const s=await lstat(file).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return undefined;throw e;});
 if(!s)return undefined;
 if(!s.isFile()||s.nlink!==1)throw Error('Only regular, non-linked source files have an identity.');
 return fileIdentity(await readFile(file),s.mode,version);
}
