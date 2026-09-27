import {openSync,writeSync,closeSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {readFile,statfs} from 'node:fs/promises';
// The guardian owns its own deadline even if the calling controller is killed.
// Host space monitoring is a best-effort reserve, not a per-VM disk quota.
const spec=JSON.parse(await readFile(process.argv[2],'utf8'));
let logBytes=0;const log=spec.log?openSync(spec.log,'wx',0o600):undefined;
const child=spawn(spec.tart,spec.args,{env:spec.env,stdio:['ignore','pipe','pipe']});
let terminating=false,killTimer;
function stop(){if(terminating)return;terminating=true;child.kill('SIGINT');killTimer=setTimeout(()=>child.kill('SIGKILL'),5000);}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{if(log!==undefined&&logBytes<65536){const part=chunk.subarray(0,65536-logBytes);writeSync(log,part);logBytes+=part.length;}});
child.on('error',()=>{process.exitCode=1;});
const deadline=setTimeout(stop,spec.timeoutMs);
const space=setInterval(async()=>{try{const fs=await statfs(spec.home);if(fs.bavail*fs.bsize<12*1024**3)stop();}catch{stop();}},1000);
child.on('close',code=>{clearTimeout(deadline);clearInterval(space);clearTimeout(killTimer);if(log!==undefined)closeSync(log);process.exitCode=terminating?124:(code??1);});
