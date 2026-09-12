import {lstat,readFile} from 'node:fs/promises';
import {safePath} from '../workspace/safe-path.ts';
import {ARTIFACT_LIMITS} from '../artifacts/store.ts';
import {OperatorError} from '../verbs/io.ts';
export async function boundedOutput(root:string,file:string,limit:number=ARTIFACT_LIMITS.file):Promise<Buffer>{
 const target=await safePath(root,file),stat=await lstat(target);
 if(!stat.isFile()||stat.size>limit)throw new OperatorError('Desktop output exceeds its size limit or is not a regular file.');return readFile(target);
}
export function validatePng(bytes:Buffer):void{
 if(bytes.length<45||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.toString('ascii',12,16)!=='IHDR'||bytes.readUInt32BE(8)!==13||bytes.readUInt32BE(16)<1||bytes.readUInt32BE(20)<1||bytes.readUInt32BE(16)>4096||bytes.readUInt32BE(20)>4096||bytes.toString('ascii',bytes.length-8,bytes.length-4)!=='IEND')throw new OperatorError('Invalid PNG screenshot or dimensions beyond 4096 pixels.');
}
