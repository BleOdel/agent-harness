/** Captured processes have one combined stdout/stderr budget. Interactive terminal output is not retained. */
import {spawn} from 'node:child_process';
import {openSync,writeSync,closeSync,fsyncSync} from 'node:fs';
import {StringDecoder} from 'node:string_decoder';
export const DEFAULT_OUTPUT_BYTES=8*1024*1024;
export const MAX_OUTPUT_BYTES=64*1024*1024;
export class OutputLimitError extends Error { constructor(message='Structured output limit exceeded.'){super(message);} }
export interface RunResult {
 readonly code:number|null;readonly stdout:string;readonly stderr:string;readonly timedOut:boolean;
 readonly outputLimited?:boolean;readonly termination?:'output-limit';
 readonly outputProblem?:string;
 readonly diagnosticFile?:string;readonly diagnosticBytes?:number;
}
/** Keep complete code points at both cuts. Returned text is diagnostics, never a complete reply after overflow. */
function prefix(text:string,bytes:number):string {return new StringDecoder('utf8').write(Buffer.from(text).subarray(0,bytes));}
function retain(text:string,bytes:number):string {
 const b=Buffer.from(text);if(b.length<=bytes)return text;
 const head=Math.floor(bytes/2),tail=bytes-head;let start=b.length-tail;
 while(start<b.length&&(b[start]!&0xc0)===0x80)start++;
 return prefix(text,head)+b.subarray(start).toString('utf8');
}
export function run(executable:string,args:readonly string[],options:{
 timeoutMs:number;maxOutputBytes?:number;signal?:AbortSignal;onOutput?:(chunk:string)=>void;
 env?:NodeJS.ProcessEnv;interactive?:boolean;
 /** Host-owned exclusive file. The same byte quota bounds disk writes; callers own retention. */
 diagnosticFile?:string;
}={timeoutMs:300000}):Promise<RunResult>{
 const limit=options.maxOutputBytes??DEFAULT_OUTPUT_BYTES;
 if(!Number.isSafeInteger(limit)||limit<1||limit>MAX_OUTPUT_BYTES)return Promise.reject(Error(`Output limit must be an integer from 1 to ${MAX_OUTPUT_BYTES} bytes.`));
 if(!Number.isFinite(options.timeoutMs)||options.timeoutMs<=0)return Promise.reject(Error('Process timeout must be finite and positive.'));
 options.signal?.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const fd=options.diagnosticFile?openSync(options.diagnosticFile,'wx',0o600):undefined;
  const grouped=process.platform!=='win32'&&options.interactive!==true;
  let child;try{child=spawn(executable,[...args],{detached:grouped,stdio:options.interactive===true?'inherit':['ignore','pipe','pipe'],...(options.env===undefined?{}:{env:options.env})});}catch(error){if(fd!==undefined)closeSync(fd);reject(error);return;}
  let stdout='',stderr='',captured=0,diskBytes=0,diskBroken=false,timedOut=false,outputLimited=false,stopped=false,failure:Error|undefined,outputProblem:string|undefined;
  let drain:NodeJS.Timeout|undefined,forcedDrain=false,groupFailure:Error|undefined;
  const killOwned=()=>{
   try{if(grouped&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}
   catch(error){
    if((error as NodeJS.ErrnoException).code==='ESRCH')return;
    // A reaped process group can report EPERM on macOS. The child handle is still
    // authoritative: wait for natural close, and never accept forced pipe closure as confirmation.
    groupFailure=error as Error;child.kill('SIGKILL');
   }
  };
  const stop=()=>{if(stopped)return;stopped=true;clearTimeout(timer);killOwned();drain=setTimeout(()=>{forcedDrain=true;child.stdout?.destroy();child.stderr?.destroy();},1000);drain.unref();};
  const abort=()=>stop();
  const timer=setTimeout(()=>{if(!stopped){timedOut=true;stop();}},options.timeoutMs);timer.unref();
  options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
  const capture=(text:string,isError:boolean)=>{
   if(stopped&&!outputLimited)return;
   try{
    const b=Buffer.from(text);
    if(fd!==undefined&&!diskBroken&&diskBytes<limit){const bytes=b.subarray(0,limit-diskBytes);let offset=0;try{while(offset<bytes.length){const n=writeSync(fd,bytes,offset,bytes.length-offset);if(n<=0)throw Error('No diagnostic write progress.');offset+=n;diskBytes+=n;}}catch(error){diskBroken=true;throw new OutputLimitError(`Diagnostic storage could not retain output: ${(error as Error).message}`);}}
    if(!outputLimited&&captured+b.length<=limit){captured+=b.length;if(isError)stderr+=text;else{stdout+=text;options.onOutput?.(text);}return;}
    outputLimited=true;outputProblem??=`Combined process output exceeded ${limit} bytes.`;
    // Divide the retained quota between streams, keeping the final arriving diagnostic bytes.
    stdout=retain(stdout+(isError?'':text),Math.floor(limit/2));stderr=retain(stderr+(isError?text:''),Math.floor(limit/2));
    stop();
   }catch(error){if(error instanceof OutputLimitError){outputLimited=true;outputProblem=error.message;stdout=retain(stdout,Math.floor(limit/2));stderr=retain(stderr,Math.floor(limit/2));}else failure=error as Error;stop();}
  };
  child.stdout?.setEncoding('utf8');child.stderr?.setEncoding('utf8');
  child.stdout?.on('data',(text:string)=>capture(text,false));child.stderr?.on('data',(text:string)=>capture(text,true));
  child.once('error',error=>{failure=error;stop();});
  child.once('close',code=>{
   clearTimeout(timer);if(drain)clearTimeout(drain);options.signal?.removeEventListener('abort',abort);
   if(fd!==undefined){try{fsyncSync(fd);}catch(error){outputLimited=true;outputProblem=`Diagnostic storage could not be flushed: ${(error as Error).message}`;}finally{try{closeSync(fd);}catch(error){outputLimited=true;outputProblem=`Diagnostic storage could not be closed: ${(error as Error).message}`;}}}
   if(groupFailure&&forcedDrain)failure??=groupFailure;
   if(failure){reject(failure);return;}
   // Some children finish successfully before SIGKILL arrives. Partial output must still be a failed result.
   resolve({code:outputLimited?1:code,stdout,stderr,timedOut,...(outputLimited?{outputLimited:true,termination:'output-limit' as const,...(outputProblem?{outputProblem}:{})}:{}),...(options.diagnosticFile?{diagnosticFile:options.diagnosticFile,diagnosticBytes:diskBytes}:{})});
  });
 });
}
