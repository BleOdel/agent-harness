/** Only the host holds expectations. The isolated driver receives bounded retry/next acknowledgements. */
import {assessObservation,type Journey} from './schema.ts';
import {observationWindow,type TimedSample} from './timing.ts';
import {boundedOutput} from '../desktop/output.ts';
import {atomicWrite} from '../planning/store.ts';
export class BrowserObservationBroker {
 spec:Journey;clock:()=>number;sequence=0;lastAt=-1;lastFrame='';steps:unknown[]=[];lastObservations:unknown[]=[];refs=new Map<string,string>();
 active?:{start:number;hostStart:number;samples:TimedSample[]};
 constructor(spec:Journey,clock=()=>performance.now()){this.spec=spec;this.clock=clock;}
 consume(raw:unknown):{sequence:number;step:number;decision:'retry'|'next'}|undefined{
  const f=raw as {version:number;sequence:number;step:number;at:number;observation:unknown},serialized=JSON.stringify(raw);
  if(!f||Object.keys(f).length!==5||f.version!==1||!Number.isSafeInteger(f.sequence)||!Number.isSafeInteger(f.step)||!Number.isFinite(f.at)||f.at<0||f.at>600000||serialized.length>256*1024)throw Error('Invalid bounded browser observation frame.');
  if(f.sequence===this.sequence){if(serialized!==this.lastFrame)throw Error('Browser frame changed under the same sequence.');return;}
  if(f.sequence!==this.sequence+1||f.sequence>6000||f.step!==this.steps.length||f.at<this.lastAt)throw Error('Browser observation sequence or order changed.');
  const step=this.spec.steps[f.step];if(!step)throw Error('Unexpected browser step.');
  const failures:string[]=[];assessObservation(step,f.observation,f.step,this.refs,failures);
  const w=observationWindow(step);let decision:'retry'|'next'='next';
  if(w){
   this.active??={start:f.at,hostStart:this.clock(),samples:[]};
   this.active.samples.push({at:f.at,observation:f.observation});if(this.active.samples.length>200)throw Error('Browser sample limit exceeded.');
   const elapsed=f.at-this.active.start,hostElapsed=this.clock()-this.active.hostStart;
   const complete=w.mode==='eventually'&&!failures.length&&elapsed<=w.milliseconds;
   decision=complete||(elapsed>=w.milliseconds&&hostElapsed>=w.milliseconds)?'next':'retry';
   if(decision==='next'){this.steps.push({action:step.action,timing:{...w,samples:this.active.samples}});delete this.active;}
  }else this.steps.push(f.observation);
  if(Buffer.byteLength(JSON.stringify({steps:this.steps,active:this.active}))>768*1024)throw Error('Browser observation limit exceeded.');
  if(decision==='next')this.lastObservations.push(f.observation);
  this.sequence=f.sequence;this.lastAt=f.at;this.lastFrame=serialized;return {sequence:f.sequence,step:f.step,decision};
 }
 report(errors:string[]){const steps=[...this.steps];if(this.active){const step=this.spec.steps[steps.length]!;steps.push({action:step.action,timing:{...observationWindow(step),samples:this.active.samples}});}return {version:2,steps,errors};}
 finish(raw:unknown){
  const r=raw as {version:number;steps:unknown[];errors:string[]};
  if(this.active||this.steps.length!==this.spec.steps.length||!r||r.version!==2||!Array.isArray(r.steps)||!Array.isArray(r.errors)||r.errors.length>100||r.errors.some(e=>typeof e!=='string'||e.length>2000)||Object.keys(r).length!==3)throw Error('Incomplete browser observation protocol.');
  if(JSON.stringify(r.steps)!==JSON.stringify(this.lastObservations))throw Error('Driver final observations differ from host-observed frames.');
  return this.report(r.errors);
 }
}
export async function serveObservations(root:string,broker:BrowserObservationBroker,stopped:()=>boolean):Promise<void>{
 while(!stopped()){
  try{const bytes=await boundedOutput(root+'/output','current.json',256*1024),reply=broker.consume(JSON.parse(bytes.toString()));if(reply)await atomicWrite(root+'/checks/decision.json',JSON.stringify(reply));}
  catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  await new Promise(r=>setTimeout(r,20));
 }
}
