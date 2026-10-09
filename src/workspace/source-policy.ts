/** Only the host's project state can authorize an exact synthetic fixture. */
import path from 'node:path';
import {lstat} from 'node:fs/promises';
import {readBoundedSource,withContentExceptions,type ContentException,assertContentAllowed} from './secret-content.ts';
import {sourceExclusion} from './changes.ts';
import {OperatorError} from '../verbs/io.ts';
export async function readContentExceptions(project:string):Promise<ContentException[]>{
 const root=project+'-harness';
 try{const stat=await lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink())throw new OperatorError('Host source policy directory must not be a symlink or special file.');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
 let bytes:Buffer;try{bytes=await readBoundedSource(project+'-harness','source-policy.json',64*1024);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
 let value;try{value=JSON.parse(bytes.toString());}catch{throw new OperatorError('Invalid host source policy. Retain it and inspect it before retrying.');}
 if(value?.version!==1||!Array.isArray(value.exceptions)||value.exceptions.length>100)throw new OperatorError('Invalid host source policy.');
 const seen=new Set<string>();for(const e of value.exceptions){
  if(!e||typeof e.path!=='string'||e.path.length>500||path.isAbsolute(e.path)||e.path.split(/[\\/]/u).some((s:string)=>!s||s==='.'||s==='..')||e.path.includes('\\')||sourceExclusion(e.path)||seen.has(e.path)||typeof e.sha256!=='string'||!(/^[a-f0-9]{64}$/u.test(e.sha256))||typeof e.reason!=='string'||!e.reason.trim()||e.reason.length>300)throw new OperatorError('Invalid host source exception.');
  assertContentAllowed('exception reason',e.reason,false);seen.add(e.path);
 }
 return value.exceptions;
}
export async function withSourcePolicy<T>(project:string,action:()=>Promise<T>):Promise<T>{return withContentExceptions(await readContentExceptions(project),action);}
