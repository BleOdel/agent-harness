import { OperatorError } from '../verbs/io.ts';
export type Step = {action:'fill';selector:string;value:string}|{action:'press';selector:string;key:string}|{action:'click';selector:string}|{action:'text';selector:string;expected:string}|{action:'count';selector:string;expected:number}|{action:'restart'|'screenshot'};
export interface Journey {version:1;title:string;timeoutSeconds:number;steps:Step[];}
function fail(message:string):never {throw new OperatorError(message);}
function object(raw:unknown,keys:string[]):Record<string,unknown> {
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!keys.includes(k)))fail('Invalid or unknown desktop setting/report field.');
 return raw as Record<string,unknown>;
}
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length<=max&&!v.includes('\0');
export function parseJourney(raw:unknown):Journey {
 const s=object(raw,['version','title','timeoutSeconds','steps']);
 if(s.version!==1||!text(s.title,120)||!s.title.trim()||/[\r\n\x1b]/u.test(s.title)||!Number.isSafeInteger(s.timeoutSeconds)||Number(s.timeoutSeconds)<5||Number(s.timeoutSeconds)>300||!Array.isArray(s.steps)||s.steps.length<1||s.steps.length>30)fail('Desktop journeys need a title, 5–300 seconds, and 1–30 UI steps.');
 let assertions=0;
 for(const rawStep of s.steps){
  const step=object(rawStep,['action','selector','value','expected','key']);
  if(!['fill','click','press','text','count','restart','screenshot'].includes(String(step.action)))fail('Unsupported desktop action.');
  const fields=step.action==='press'?['action','selector','key']:step.action==='fill'?['action','selector','value']:['text','count'].includes(String(step.action))?['action','selector','expected']:step.action==='click'?['action','selector']:['action'];
  object(rawStep,fields);if(Object.keys(step).length!==fields.length)fail('Missing desktop step fields.');
  if(fields.includes('selector')&&(!text(step.selector,300)||!step.selector.trim()))fail('Use a nonempty selector of at most 300 characters.');
  if(step.action==='press'&&!['Enter','Tab','Space','Escape','ArrowUp','ArrowDown'].includes(String(step.key)))fail('Unsupported key.');
  if(step.action==='fill'&&!text(step.value,10000))fail('Fill value exceeds 10000 characters.');
  if(step.action==='text'){assertions++;if(!text(step.expected,10000))fail('Expected text must be a string of at most 10000 characters.');}
  if(step.action==='count'){assertions++;if(!Number.isSafeInteger(step.expected)||Number(step.expected)<0||Number(step.expected)>1000)fail('Expected count must be 0–1000.');}
 }
 if(!assertions)fail('Include at least one expected text or count check.');
 return structuredClone(s) as unknown as Journey;
}
export function actionRequest(s:Journey){return {version:1,steps:s.steps.map(step=>{const {expected:_,...action}=step as Step&{expected?:unknown};return action;})};}
export interface Assessment {passed:boolean;checks:number;failures:string[];screenshots:string[];}
export function assessJourney(spec:Journey,raw:unknown):Assessment {
 const report=object(raw,['version','packaged','steps','errors']);
 if(report.version!==1||report.packaged!==true||!Array.isArray(report.steps)||report.steps.length!==spec.steps.length||!Array.isArray(report.errors)||report.errors.length>100||report.errors.some(e=>!text(e,2000)))fail('Incomplete or malformed packaged desktop observations.');
 const failures:string[]=[...(report.errors as string[])],screenshots:string[]=[];let checks=0;
 spec.steps.forEach((step,i)=>{
  const o=object((report.steps as unknown[])[i],step.action==='text'?['action','values']:step.action==='count'?['action','value']:step.action==='screenshot'?['action','file']:['action']);
  if(o.action!==step.action)fail('Desktop observation order/action changed.');
  if(step.action==='text'){
   if(!Array.isArray(o.values)||o.values.length<1||o.values.length>12||o.values.some(v=>!text(v,10000)))fail('Invalid text observations.');checks++;
   if(!o.values.includes(step.expected))failures.push(`Step ${i+1}: ${step.selector} did not show the approved text.`);
  }
  if(step.action==='count'){
   if(!Number.isSafeInteger(o.value)||Number(o.value)<0||Number(o.value)>1000)fail('Invalid count observation.');checks++;
   if(o.value!==step.expected)failures.push(`Step ${i+1}: ${step.selector} count differs from the approved count.`);
  }
  if(step.action==='screenshot'){if(o.file!==`screen-${i}.png`)fail('Invalid screenshot observation path.');screenshots.push(o.file as string);}
 });
 return {passed:failures.length===0,checks,failures,screenshots};
}
export function validateApp(raw:unknown):string {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))fail('Desktop source needs package.json.');
 const pkg=raw as Record<string,unknown>;
 if(!text(pkg.name,100)||!/^[@a-z0-9][a-z0-9._/-]*$/u.test(pkg.name)||!text(pkg.version,40)||!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(pkg.version)||!text(pkg.main,200)||!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\.(?:js|cjs|mjs)$/u.test(pkg.main)||pkg.main.split('/').some(p=>p==='..'||p==='.')||pkg.workspaces)fail('Desktop source needs a package name/version and a local JavaScript main entry.');
 for(const key of ['dependencies','devDependencies','optionalDependencies','peerDependencies'])if(Object.hasOwn(pkg,key)&&(!pkg[key]||typeof pkg[key]!=='object'||Array.isArray(pkg[key])||Object.keys(pkg[key] as object).length))fail('This desktop lane packages dependency-free apps using Electron and Node built-ins. Bundle external dependencies separately before selecting this lane.');
 return pkg.main;
}
