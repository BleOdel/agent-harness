import http from 'node:http';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {canonicalHash} from './json.mjs';
const p=JSON.parse(await readFile('/harness-checks/request.json','utf8'));
const origin=`http://127.0.0.1:${p.port}`,observations={version:1,complete:false,rounds:[]};
let stopping=false,active;
const stop=()=>{stopping=true;active?.destroy(Error('interrupted'));};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
const budget=setTimeout(stop,p.maxSeconds*1000);
async function save(){await writeFile('/work/samples.tmp',JSON.stringify(observations));await rename('/work/samples.tmp','/work/samples.json');}
function request(){return new Promise(resolve=>{
 const start=performance.now();let settled=false,expired=false;
 const finish=(status,bodyHash,error)=>{if(settled)return;settled=true;clearTimeout(timer);active=undefined;resolve({ms:performance.now()-start,status,bodyHash,error});};
 const req=http.request(origin+p.path,{method:'GET',agent:false,headers:{Origin:origin,Accept:'application/json'}},res=>{
  const chunks=[];let size=0;res.on('data',b=>{size+=b.length;if(size>65536){finish(res.statusCode,null,'body-limit');res.destroy();req.destroy();}else chunks.push(b);});
  res.on('error',()=>finish(res.statusCode,null,expired?'timeout':'network'));
  res.on('end',()=>{try{finish(res.statusCode,canonicalHash(JSON.parse(Buffer.concat(chunks).toString())),null);}catch{finish(res.statusCode,null,'invalid-json');}});
 });
 const timer=setTimeout(()=>{expired=true;finish(null,null,'timeout');req.destroy();},p.requestTimeoutMs);
 active=req;req.on('error',()=>finish(null,null,expired?'timeout':'network'));req.end();
});}
try{
 const deadline=performance.now()+Math.min(10000,p.maxSeconds*1000/3);
 while(!stopping){const ready=await request();if(ready.status!==null)break;if(performance.now()>deadline)throw Error('startup');await new Promise(r=>setTimeout(r,100));}
 for(let i=0;i<p.repetitions&&!stopping;i++){
  const round={warmup:[],samples:[],elapsedMs:0};observations.rounds.push(round);await save();
  for(let j=0;j<p.warmup&&!stopping;j++){round.warmup.push(await request());await save();}
  const start=performance.now();
  for(let j=0;j<p.samples&&!stopping;j++){round.samples.push(await request());round.elapsedMs=performance.now()-start;await save();}
 }
 observations.complete=!stopping&&observations.rounds.length===p.repetitions&&observations.rounds.every(r=>r.warmup.length===p.warmup&&r.samples.length===p.samples);await save();
 if(!observations.complete)process.exitCode=1;
}catch{if(observations.rounds.length)await save();console.error('Performance observation incomplete; no response content retained.');process.exitCode=1;}
finally{clearTimeout(budget);process.off('SIGTERM',stop);process.off('SIGINT',stop);}
