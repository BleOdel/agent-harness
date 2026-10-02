/** Bounded browser actions; generated journeys never supply JavaScript. */
import {repeatedInput,type RepeatedInput} from './instrumentation/input.ts';
import {OperatorError} from '../verbs/io.ts';
type Input={value:string;valueFrom?:never;valueRepeat?:never}|{valueFrom:string;value?:never;valueRepeat?:never}|{valueRepeat:RepeatedInput;value?:never;valueFrom?:never};
type Expected={expected:string;expectedFrom?:never}|{expectedFrom:string;expected?:never};
export type CapabilityStep={action:'type';selector:string;value:string}|({action:'fill'|'paste';selector:string}&Input)|{action:'capture';selector:string;name:string;source:'text'|'value'}|({action:'clipboard'}&Expected)|({action:'download';selector:string}&Expected)|{action:'storage';absentFrom:string}|{action:'context'|'page';name:string}|{action:'network';path:string;method:string;mode:'normal'|'abort'|'503'}|{action:'requestCount';path:string;method:string;expected:number}|{action:'attribute';selector:string;name:string;expected:string}|{action:'select';selector:string;value:string};
export const capabilityActions=new Set(['type','fill','paste','capture','clipboard','download','storage','context','page','network','requestCount','attribute','select']);
const fail=(m:string):never=>{throw new OperatorError(m);};
const text=(v:unknown,n=12000):v is string=>typeof v==='string'&&v.length<=n&&!v.includes('\0');
const label=(v:unknown):v is string=>typeof v==='string'&&/^[a-z][a-z0-9-]{0,39}$/u.test(v);
export function validateCapability(s:Record<string,unknown>,refs:Set<string>,contexts:Set<string>,pages:Set<string>,active:{context:string}):number{
 const a=String(s.action);let keys:string[]=[],checks=0;
 const selector=()=>{if(!text(s.selector,300)||!s.selector.trim())fail('Invalid capability selector.');};
 const reference=(v:unknown)=>{if(!label(v)||!refs.has(v))fail('Browser reference must name an earlier capture.');};
 const input=()=>{if(s.valueRepeat!==undefined){try{repeatedInput(s.valueRepeat);}catch(e){fail((e as Error).message);}return 'valueRepeat';}if(s.valueFrom!==undefined){reference(s.valueFrom);return 'valueFrom';}if(!text(s.value))fail('Invalid browser input.');return 'value';};
 const expected=()=>{if(s.expectedFrom!==undefined){reference(s.expectedFrom);return 'expectedFrom';}if(!text(s.expected))fail('Invalid browser expectation.');return 'expected';};
 if(a==='fill'||a==='paste'){selector();keys=['selector',input()];}
 if(a==='type'){selector();if(typeof s.value!=='string'||! /^[\x20-\x7e]{1,256}$/u.test(s.value))fail('Typing requires 1..256 printable ASCII characters. Use fill or paste for larger or Unicode input.');keys=['selector','value'];}
 if(a==='select'){selector();if(!text(s.value,300))fail('Invalid option value.');keys=['selector','value'];}
 if(a==='capture'){selector();if(!label(s.name)||refs.has(s.name)||refs.size>=20||!['text','value'].includes(String(s.source)))fail('Invalid or duplicate capture.');refs.add(s.name as string);keys=['selector','name','source'];}
 if(a==='clipboard'||a==='download'){if(a==='download')selector();keys=[...(a==='download'?['selector']:[]),expected()];checks++;}
 if(a==='storage'){reference(s.absentFrom);keys=['absentFrom'];checks++;}
 if(a==='context'||a==='page'){if(!label(s.name))fail('Invalid browser session name.');if(a==='context'){contexts.add(s.name as string);active.context=s.name as string;pages.add(active.context+'/main');}else pages.add(active.context+'/'+String(s.name));if(contexts.size>4||pages.size>12)fail('Browser session limit reached.');keys=['name'];}
 if(a==='network'||a==='requestCount'){
  if(!text(s.path,500)||!/^\/(?!\/)/u.test(s.path)||/[\\\s?#\x00-\x1f\x7f]/u.test(s.path)||!['GET','POST','PUT','PATCH','DELETE'].includes(String(s.method)))fail('Use an exact same-origin request path and supported method.');
  keys=['path','method'];if(a==='network'){if(!['normal','abort','503'].includes(String(s.mode)))fail('Invalid controlled failure mode.');keys.push('mode');}else{if(!Number.isSafeInteger(s.expected)||Number(s.expected)<0||Number(s.expected)>1000)fail('Invalid request count.');keys.push('expected');checks++;}
 }
 if(a==='attribute'){selector();if(!text(s.name,80)||!/^aria-[a-z-]+$|^(?:role|type|disabled|required|readonly|maxlength|minlength)$/u.test(s.name)||!text(s.expected,300))fail('Unsupported attribute observation.');keys=['selector','name','expected'];checks++;}
 if(Object.keys(s).length!==keys.length+1||Object.keys(s).some(k=>k!=='action'&&!keys.includes(k)))fail('Invalid browser capability fields.');
 return checks;
}
export function assessCapability(s:CapabilityStep,raw:unknown,refs:Map<string,string>,failures:string[]):number{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))fail('Invalid capability observation.');const o=raw as Record<string,unknown>;
 const a=s.action;const extra=a==='capture'||a==='attribute'?['values']:a==='clipboard'||a==='download'||a==='requestCount'?['value']:a==='storage'?['local','session','databases','cache','cookies']:[];
 if(o.action!==a||Object.keys(o).length!==extra.length+1||Object.keys(o).some(k=>k!=='action'&&!extra.includes(k)))fail('Invalid capability observation fields.');
 const mismatch=(message:string)=>failures.push(`${a}: ${message}`);
 const expected=(step:Expected)=>step.expectedFrom!==undefined?refs.get(step.expectedFrom):step.expected;
 if(a==='capture'||a==='attribute'){
  if(!Array.isArray(o.values)||o.values.length>12||o.values.some(v=>v!==null&&!text(v)))fail('Invalid captured values.');
  const values=o.values as unknown[];
  if(a==='capture'){if(values.length!==1||!text(values[0])||!values[0])mismatch('capture requires exactly one nonempty value.');else refs.set(s.name,values[0] as string);return 0;}
  if(values.length!==1||values[0]!==s.expected)mismatch('attribute differs.');return 1;
 }
 if(a==='clipboard'||a==='download'){if(!text(o.value,65536))fail('Invalid text output.');const wanted=expected(s);if(wanted===undefined||o.value!==wanted)mismatch('text differs from expected value.');return 1;}
 if(a==='requestCount'){if(!Number.isSafeInteger(o.value)||Number(o.value)<0||Number(o.value)>1000)fail('Invalid request count observation.');if(o.value!==s.expected)mismatch('request count differs.');return 1;}
 if(a==='storage'){
  const value=refs.get(s.absentFrom);if(!value)mismatch('missing captured privacy marker.');
  for(const kind of ['local','session','databases','cache','cookies']){const entries=o[kind];if(!Array.isArray(entries)||entries.length>200||entries.some(e=>!Array.isArray(e)||e.length!==2||e.some(v=>!text(v,65536))))fail('Invalid storage observation.');if(value){const encodings=[value,encodeURIComponent(value),Buffer.from(value).toString('base64'),Buffer.from(value).toString('hex')];if((entries as string[][]).some(e=>e.some((v:string)=>encodings.some(secret=>v.includes(secret)))))mismatch(`private marker found in ${kind} storage.`);}}
  return 1;
 }
 return 0;
}
