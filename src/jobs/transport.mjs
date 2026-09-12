// Transfer only bounded regular bytes. Never unpack a worker-supplied archive on the host.
import fs from 'node:fs';
import path from 'node:path';
const name=process.argv[2];
if(!name||name.startsWith('/')||name.includes('\\')||name.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('Invalid transport path');
let file='/work';for(const [i,part]of name.split('/').entries()){file=path.join(file,part);const stat=fs.lstatSync(file);if(stat.isSymbolicLink()||(i===name.split('/').length-1?(!stat.isFile()||stat.nlink!==1||stat.size>33554432):!stat.isDirectory()))throw Error('Unsafe or oversized output');}
const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{
 const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size>33554432)throw Error('Unsafe output');
 const bytes=Buffer.alloc(stat.size);let offset=0;while(offset<bytes.length){const n=fs.readSync(fd,bytes,offset,bytes.length-offset,null);if(!n)break;offset+=n;}
 const after=fs.fstatSync(fd);if(offset!==bytes.length||stat.size!==after.size||stat.mtimeMs!==after.mtimeMs)throw Error('Output changed during transfer');
 process.stdout.write(bytes.toString('base64'));
}finally{fs.closeSync(fd);}
