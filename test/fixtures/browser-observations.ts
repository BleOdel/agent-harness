/** Synthetic comparison fixtures only. Real timing evidence comes from the isolated driver and host broker. */
import type {Journey} from '../../src/browser/schema.ts';import {observationWindow} from '../../src/browser/timing.ts';
export function observationFixture(spec:Journey,raw:any){return {...raw,version:2,steps:raw.steps.map((o:any,i:number)=>{const step=spec.steps[i],w=step&&observationWindow(step);return w?{action:o.action,timing:{...w,samples:[{at:0,observation:o},...(w.mode==='during'?[{at:w.milliseconds,observation:o}]:[])]}}:o;})};}
