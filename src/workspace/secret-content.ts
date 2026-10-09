/** Conservative content selection, not a claim to detect every secret. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {OperatorError} from '../verbs/io.ts';
import {safePath} from './safe-path.ts';
export const CONTENT_LIMIT=32*1024*1024;
export const SOURCE_SCAN_LIMIT=128*1024*1024;
export interface ContentException {path:string;sha256:string;reason:string;}
const exceptions=new AsyncLocalStorage<readonly ContentException[]>();
export function withContentExceptions<T>(approved:readonly ContentException[],action:()=>Promise<T>):Promise<T>{return exceptions.run(approved,action);}
export const contentHash=(bytes:string|Buffer):string=>createHash('sha256').update(bytes).digest('hex');
const rules:readonly [string,RegExp][]=[
 ['private-key',/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u],
 ['github-token',/\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/u],
 ['openai-style-key',/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,256}\b/u],
 ['aws-access-key',/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u],
 ['google-api-key',/\bAIza[0-9A-Za-z_-]{35}\b/u],
 ['slack-token',/\bxox[baprs]-[0-9A-Za-z-]{20,255}\b/u],
];
export function contentFindings(bytes:string|Buffer):string[]{
 if(Buffer.byteLength(bytes)>CONTENT_LIMIT)return ['content-scan-limit'];
 // Scan binary bytes too: a NUL is not a way to exempt an embedded ASCII key.
 const text=Buffer.isBuffer(bytes)?bytes.toString('latin1'):bytes;
 return rules.filter(([,rule])=>rule.test(text)).map(([id])=>id);
}
export class ContentWithheld extends OperatorError {
 constructor(file:string,rules:readonly string[]){super(`Content withheld at ${JSON.stringify(file)}: ${rules.join(', ')}. Retained files are unchanged.`, 'Run harness source inspect. Remove credentials from source, or explicitly allow an exact synthetic fixture with harness source allow. No values are printed.');}
}
export function assertContentAllowed(file:string,bytes:string|Buffer,allowExceptions=true):void{
 const found=contentFindings(bytes);if(!found.length)return;
 if(!found.includes('content-scan-limit')&&allowExceptions&&exceptions.getStore()?.some(e=>e.path===file&&e.sha256===contentHash(bytes)))return;
 throw new ContentWithheld(file,found);
}
/** Read a bounded single-link regular file without following aliases or allocating its declared size. */
export async function readBoundedSource(root:string,file:string,limit=CONTENT_LIMIT):Promise<Buffer>{
 const target=await safePath(root,file),handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1)throw new OperatorError('Source must be a regular single-link file.');
  if(stat.size>limit)throw new ContentWithheld(file,['content-scan-limit']);
  const chunks:Buffer[]=[];let total=0;
  for(;;){const buffer=Buffer.alloc(Math.min(64*1024,limit+1-total)),n=(await handle.read(buffer,0,buffer.length,null)).bytesRead;if(!n)break;total+=n;if(total>limit)throw new ContentWithheld(file,['content-scan-limit']);chunks.push(buffer.subarray(0,n));}
  return Buffer.concat(chunks,total);
 }finally{await handle.close();}
}
export async function readSelectedSource(root:string,file:string):Promise<Buffer>{const bytes=await readBoundedSource(root,file);assertContentAllowed(file,bytes);return bytes;}
