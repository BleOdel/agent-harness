import {OperatorError} from '../verbs/io.ts';
export interface ObservationWindow {mode:'eventually'|'during';milliseconds:number;}
export const timedActions=new Set(['value','text','count','attribute','requestCount','storage']);
/** Defaults apply only to positive observations. Absence needs an approved interval. */
export function observationWindow(step:any):ObservationWindow|undefined{
 if(!step||typeof step!=='object'||Array.isArray(step))return undefined;
 if(!timedActions.has(step.action)){if(step.observation!==undefined)throw new OperatorError('This action does not support an observation window.');return undefined;}
 const negative=step.action==='storage'||((step.action==='count'||step.action==='requestCount')&&step.expected===0)||((step.action==='text'||step.action==='value')&&step.expected==='');
 const w=step.observation;
 if(w===undefined){if(negative)throw new OperatorError('Absence and no-request claims require an explicit during observation window.','Choose a bounded interval and review the changed journey before approval.');return {mode:'eventually',milliseconds:5000};}
 if(!w||typeof w!=='object'||Array.isArray(w)||Object.keys(w).length!==2||!['mode','milliseconds'].every(k=>Object.hasOwn(w,k))||!['eventually','during'].includes(w.mode)||!Number.isSafeInteger(w.milliseconds)||w.milliseconds<100||w.milliseconds>10000)throw new OperatorError('Observation windows require mode eventually or during and 100–10000 milliseconds.');
 if(negative&&w.mode!=='during')throw new OperatorError('Absence requires a during observation window; eventual zero is not evidence.');
 return {...w};
}
export interface TimedSample {at:number;observation:unknown;}
export interface TimedObservation {action:string;timing:ObservationWindow&{samples:TimedSample[]};}
export function assessTiming(step:any,raw:unknown,compare:(sample:unknown)=>{checks:number;failures:string[]}):{checks:number;failures:string[]}{
 const w=observationWindow(step)!;const o=raw as TimedObservation;
 if(!o||o.action!==step.action||Object.keys(o).length!==2||!o.timing||Object.keys(o.timing).length!==3||o.timing.mode!==w.mode||o.timing.milliseconds!==w.milliseconds||!Array.isArray(o.timing.samples)||!o.timing.samples.length||o.timing.samples.length>200)throw new OperatorError('Missing or invalid timed browser observations.');
 let previous=-1;const samples=o.timing.samples;
 for(const s of samples){if(!s||Object.keys(s).length!==2||!Object.hasOwn(s,'observation')||!Number.isFinite(s.at)||s.at<0||s.at<previous||s.at>600000)throw new OperatorError('Invalid browser sample timestamp or order.');previous=s.at;}
 const start=samples[0]!.at,elapsed=samples.at(-1)!.at-start;
 const results=samples.map(s=>({...compare(s.observation),elapsed:s.at-start}));const last=results.at(-1)!;
 const passed=w.mode==='eventually'?results.some(r=>r.elapsed<=w.milliseconds&&!r.failures.length):elapsed>=w.milliseconds&&results.every(r=>!r.failures.length);
 if(passed&&elapsed<=w.milliseconds+2000)return {checks:last.checks,failures:[]};
 const diagnosis=JSON.stringify(samples.at(-1)!.observation).slice(0,500);
 return {checks:last.checks,failures:[`${step.action}: ${w.mode} observation failed after ${Math.round(elapsed)}ms (limit/window ${w.milliseconds}ms); last observed ${diagnosis}.`,...last.failures]};
}
