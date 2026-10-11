/** Poll a flat, host-created output mount without confusing atomic replacement with a hard link. */
import {constants} from 'node:fs';
import {open,type FileHandle} from 'node:fs/promises';
import path from 'node:path';
const LIMIT=256*1024;
export async function readObservationHandle(handle:FileHandle):Promise<Buffer|undefined>{
 const before=await handle.stat();
 if(!before.isFile()||before.nlink>1)throw Error('Browser observation must be a single-link regular file.');
 // An atomic rename may unlink the opened previous frame. The driver waits for
 // this frame's acknowledgement, so retrying cannot skip an accepted sequence.
 if(before.nlink===0)return undefined;
 if(before.size>LIMIT)throw Error('Browser observation exceeds its bounded size.');
 const bytes=Buffer.alloc(LIMIT+1),result=await handle.read(bytes,0,bytes.length,0),after=await handle.stat();
 if(after.nlink>1)throw Error('Browser observation must be a single-link regular file.');
 if(after.nlink===0)return undefined;
 if(after.size>LIMIT||result.bytesRead>LIMIT)throw Error('Browser observation exceeds its bounded size.');
 if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||result.bytesRead!==after.size)throw Error('Browser observation changed while being read.');
 return bytes.subarray(0,result.bytesRead);
}
export async function readObservationFrame(directory:string):Promise<Buffer|undefined>{
 let handle;try{handle=await open(path.join(directory,'current.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
 try{return await readObservationHandle(handle);}finally{await handle.close();}
}
