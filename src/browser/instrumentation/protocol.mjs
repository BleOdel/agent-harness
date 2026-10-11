/** Read-only host acknowledgements release actions; no expectations enter this process. */
import {readFile,writeFile,rename} from 'node:fs/promises';
export function observationProtocol(deadline){
 let sequence=0;
 return async(step,observation)=>{
  const frame={version:1,sequence:++sequence,step,at:performance.now(),observation},bytes=JSON.stringify(frame);
  if(Buffer.byteLength(bytes)>256*1024||sequence>6000)throw Error('Browser observation protocol limit exceeded.');
  await writeFile('/work/current.tmp',bytes);await rename('/work/current.tmp','/work/current.json');
  const until=Math.min(deadline,Date.now()+5000);
  while(Date.now()<until){
   try{const text=await readFile('/harness-checks/decision.json','utf8');if(text.length>1000)throw Error('Invalid host acknowledgement.');const reply=JSON.parse(text);
    if(reply.sequence===sequence){if(reply.step!==step||!['retry','next'].includes(reply.decision)||Object.keys(reply).length!==3)throw Error('Invalid host acknowledgement.');return reply.decision;}
    if(reply.sequence>sequence)throw Error('Host acknowledgement order changed.');
   }catch(e){if(e.code!=='ENOENT')throw e;}
   await new Promise(r=>setTimeout(r,20));
  }
  throw Error('Host observation acknowledgement or journey deadline exceeded.');
 };
}
