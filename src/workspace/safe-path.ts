/** File mutations refuse aliases outside source, including existing hard links. */
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { BoundaryViolation } from "./changes.ts";
export async function safePath(root:string,file:string):Promise<string>{
 if(path.isAbsolute(file)||file.split(/[\\/]/u).some(p=>!p||p==="."||p===".."))throw new BoundaryViolation(`Invalid source path: ${file}`,file);
 const canonical=await realpath(root);const parts=file.split("/");let current=canonical;
 for(const [index,part]of parts.entries()){
  current=path.join(current,part);
  let stat;try{stat=await lstat(current);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")break;throw error;}
  if(stat.isSymbolicLink()||(stat.isFile()&&stat.nlink!==1))throw new BoundaryViolation(`${file} contains a symlink or hard link.`,file);
  if(index<parts.length-1?!stat.isDirectory():!stat.isFile())throw new BoundaryViolation(`${file} is not a regular file path.`,file);
 }
 return path.join(canonical,file);
}
export async function readSafe(root:string,file:string):Promise<Buffer|undefined>{
 try{return await readFile(await safePath(root,file));}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw error;}
}
