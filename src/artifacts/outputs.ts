import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { safePath } from '../workspace/safe-path.ts';
import { ARTIFACT_LIMITS } from './store.ts';
import { OperatorError } from '../verbs/io.ts';
export async function buildOutputs(work:string,roots:readonly string[]):Promise<{name:string;bytes:Buffer}[]>{
 const found:{name:string;bytes:Buffer}[]=[];let total=0, visited=0;
 async function walk(relative:string):Promise<void>{
  if(++visited>4096||relative.split('/').length>16)throw new OperatorError('Build output tree exceeds traversal limits.');
  const file=path.join(work,relative);let stat;
  try{stat=await lstat(file);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
  if(stat.isSymbolicLink()||stat.nlink>1&&!stat.isDirectory())throw new OperatorError('Build outputs cannot contain symlinks or hard links.');
  if(stat.isDirectory()){for(const entry of await readdir(file))await walk(`${relative}/${entry}`);return;}
  if(!stat.isFile()||stat.size>ARTIFACT_LIMITS.file||(total+=stat.size)>ARTIFACT_LIMITS.batch||found.length>=64)throw new OperatorError('Build output retention limit exceeded (32 MiB/file, 64 MiB/batch, 64 files).');
  found.push({name:relative,bytes:await readFile(await safePath(work,relative))});
 }
 for(const root of roots){
  const match=/^([a-zA-Z0-9_-]+)\/\*\.([a-zA-Z0-9]+)$/u.exec(root);
  if(match){
   const directory=path.join(work,match[1]!);
   const stat=await lstat(directory).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return undefined;throw e;});
   if(!stat)continue;if(!stat.isDirectory()||stat.isSymbolicLink())throw new OperatorError('Unsafe build output directory.');
   for(const name of await readdir(directory))if(name.endsWith(`.${match[2]}`))await walk(`${match[1]}/${name}`);
  }else await walk(root);
 }return found;
}
