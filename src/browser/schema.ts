import {OperatorError} from '../verbs/io.ts';
export type Step = {action:'goto';path:string}|{action:'fill';selector:string;value:string}|{action:'click';selector:string}|{action:'press';selector:string;key:string}|{action:'text';selector:string;expected:string}|{action:'count';selector:string;expected:number}|{action:'focused';selector:string}|{action:'viewport';width:number;height:number}|{action:'motion';value:'reduce'|'no-preference'}|{action:'reload'|'overflow'|'accessibility'|'screenshot'};
export interface Journey {version:1;title:string;entry:string;port:number;databaseEnv?:string;timeoutSeconds:number;steps:Step[];}
export interface Assessment {passed:boolean;checks:number;failures:string[];screenshots:string[];}
function fail(m:string):never{throw new OperatorError(m);}
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length<=max&&!v.includes('\0');
function object(raw:unknown,keys:string[]):Record<string,unknown>{if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!keys.includes(k)))fail('Invalid browser journey or observation fields.');return raw as Record<string,unknown>;}
const int=(v:unknown,min:number,max:number)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max;
export function parseJourney(raw:unknown):Journey{
 const s=object(raw,['version','title','entry','port','databaseEnv','timeoutSeconds','steps']);
 if(s.version!==1||!text(s.title,120)||!s.title.trim()||/[\r\n\x1b]/u.test(s.title)||!text(s.entry,200)||!/^[\w-]+(?:\/[\w.-]+)*\.(?:js|mjs|cjs)$/u.test(s.entry)||s.entry.split('/').some(p=>p==='..'||p==='.')||!int(s.port,1024,65535)||!int(s.timeoutSeconds,10,300)||!Array.isArray(s.steps)||s.steps.length<1||s.steps.length>60)fail('Browser journeys need a title, local Node entry, port 1024–65535, 10–300 seconds and 1–60 steps.');
 if(s.databaseEnv!==undefined&&(!text(s.databaseEnv,80)||!/^([A-Z][A-Z0-9_]*_)?(DB|DATABASE)(_PATH|_FILE)?$/u.test(s.databaseEnv)))fail('Use an application database variable such as TO_BE_HEARD_DB.');
 let checks=0;
 for(const rawStep of s.steps){
  const step=object(rawStep,['action','selector','value','expected','key','path','width','height']);
  const fields:Record<string,string[]>={goto:['path'],fill:['selector','value'],click:['selector'],press:['selector','key'],text:['selector','expected'],count:['selector','expected'],focused:['selector'],viewport:['width','height'],motion:['value'],reload:[],overflow:[],accessibility:[],screenshot:[]};
  const keys=fields[String(step.action)];if(!keys)fail('Unsupported browser action.');object(step,['action',...keys]);if(Object.keys(step).length!==keys.length+1)fail('Missing browser step fields.');
  if(keys.includes('selector')&&(!text(step.selector,300)||!step.selector.trim()))fail('Use a nonempty element selector.');
  if(step.action==='goto'&&(!text(step.path,500)||!/^\/(?!\/)/u.test(step.path)||/[\\\s\x00-\x1f\x7f]/u.test(step.path)))fail('Navigate only to a path on the isolated application origin.');
  if(step.action==='fill'&&!text(step.value,12000))fail('Fill text exceeds 12000 characters.');
  if(step.action==='press'&&!['Enter','Tab','Shift+Tab','Space','Escape','ArrowUp','ArrowDown'].includes(String(step.key)))fail('Unsupported browser key.');
  if(step.action==='text'&&!text(step.expected,12000))fail('Expected browser text is invalid.');
  if(step.action==='count'&&!int(step.expected,0,1000))fail('Expected browser count must be 0–1000.');
  if(step.action==='viewport'&&(!int(step.width,320,1920)||!int(step.height,320,1440)))fail('Viewport must be 320–1920 wide and 320–1440 high.');
  if(step.action==='motion'&&!['reduce','no-preference'].includes(String(step.value)))fail('Invalid motion preference.');
  if(['text','count','focused','overflow','accessibility'].includes(String(step.action)))checks++;
 }
 if(!checks)fail('Include an observable text, count, focus, overflow or accessibility expectation.');
 return structuredClone(s) as unknown as Journey;
}
export function actionRequest(s:Journey){return {version:1,port:s.port,timeoutSeconds:s.timeoutSeconds,steps:s.steps.map(step=>{const {expected:_,...action}=step as Step&{expected?:unknown};return action;})};}
export function assessJourney(spec:Journey,raw:unknown):Assessment{
 const r=object(raw,['version','steps','errors']);
 if(r.version!==1||!Array.isArray(r.steps)||r.steps.length!==spec.steps.length||!Array.isArray(r.errors)||r.errors.length>100||r.errors.some(e=>!text(e,2000)))fail('Incomplete browser observations.');
 const failures=[...(r.errors as string[])],screenshots:string[]=[];let checks=0;
 spec.steps.forEach((step,i)=>{
  const extra:Record<string,string[]>={goto:['status'],reload:['status'],text:['values'],count:['value'],focused:['value'],overflow:['client','scroll'],accessibility:['violations'],screenshot:['file']};
  const keys=['action',...(extra[step.action]??[])],o=object((r.steps as unknown[])[i],keys);
  if(o.action!==step.action||Object.keys(o).length!==keys.length)fail('Browser observation order or shape changed.');
  const mismatch=(m:string)=>failures.push(`Step ${i+1}: ${m}`);
  if(step.action==='goto'||step.action==='reload'){checks++;if(!int(o.status,100,599))fail('Invalid navigation response.');if(o.status!==200)mismatch('application navigation did not return 200.');}
  if(step.action==='text'){checks++;if(!Array.isArray(o.values)||o.values.length>12||o.values.some(v=>!text(v,12000)))fail('Invalid text observations.');if(o.values.length!==1||o.values[0]!==step.expected)mismatch('exact text differs.');}
  if(step.action==='count'){checks++;if(!int(o.value,0,1000))fail('Invalid element count.');if(o.value!==step.expected)mismatch('element count differs.');}
  if(step.action==='focused'){checks++;if(typeof o.value!=='boolean')fail('Invalid focus observation.');if(!o.value)mismatch('element does not have keyboard focus.');}
  if(step.action==='overflow'){checks++;if(!int(o.client,1,1920)||!int(o.scroll,1,100000))fail('Invalid viewport observation.');if(Number(o.scroll)>Number(o.client)+1)mismatch('horizontal page overflow.');}
  if(step.action==='accessibility'){checks++;if(!Array.isArray(o.violations)||o.violations.length>200||o.violations.some(v=>!text(v,200)))fail('Invalid accessibility observations.');if(o.violations.length)mismatch(`axe violations: ${o.violations.join(', ')}.`);}
  if(step.action==='screenshot'){if(o.file!==`screen-${i}.png`)fail('Invalid screenshot filename.');screenshots.push(o.file as string);}
 });
 return {passed:failures.length===0,checks,failures,screenshots};
}
