import test from 'node:test';import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,open,rename,rm,link,symlink} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {readObservationFrame,readObservationHandle} from '../src/browser/observation-frame.ts';
test('an atomically replaced browser frame is retried, not treated as a hard link',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'browser-frame-'));
 try{await writeFile(root+'/current.json','{"sequence":1}');const handle=await open(root+'/current.json','r');try{await writeFile(root+'/next','{"sequence":2}');await rename(root+'/next',root+'/current.json');assert.equal(await readObservationHandle(handle),undefined);}finally{await handle.close();}assert.equal((await readObservationFrame(root))?.toString(),'{"sequence":2}');}finally{await rm(root,{recursive:true,force:true});}
});
test('browser frame reader rejects symlinks, hard links, directories and oversized frames',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'browser-frame-'));
 try{assert.equal(await readObservationFrame(root),undefined);await writeFile(root+'/data','{}');await symlink(root+'/data',root+'/current.json');await assert.rejects(readObservationFrame(root));await rm(root+'/current.json');await link(root+'/data',root+'/current.json');await assert.rejects(readObservationFrame(root),/single-link/);await rm(root+'/current.json');await mkdir(root+'/current.json');await assert.rejects(readObservationFrame(root),/single-link/);await rm(root+'/current.json',{recursive:true});await writeFile(root+'/current.json','x'.repeat(256*1024+1));await assert.rejects(readObservationFrame(root),/bounded/);}finally{await rm(root,{recursive:true,force:true});}
});
