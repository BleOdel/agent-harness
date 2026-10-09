/** Verification launchers must not qualify a partial test report. */
import {run} from './run.ts';
export async function verificationProcess(args:readonly string[],env:NodeJS.ProcessEnv=process.env,output:(text:string)=>void=text=>{process.stdout.write(text);}) {
 const result=await run(process.execPath,args,{timeoutMs:30*60*1000,env,onOutput:output});
 if(result.stderr)process.stderr.write(result.stderr);
 if(result.outputLimited||result.timedOut)throw Error(result.outputLimited?'Verification output-limit: incomplete report.':'Verification timed out: incomplete report.');
 return result;
}
