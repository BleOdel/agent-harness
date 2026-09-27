import {OperatorError} from '../verbs/io.ts';
export interface NativeCheck {version:1;title:string;entry:string;timeoutSeconds:number;expectedExit:number;stdout:string;artifacts:string[];}
const fail=(message:string):never=>{throw new OperatorError(message);};
export function relativeFile(value:unknown):value is string{return typeof value==='string'&&value.length<=180&&/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/u.test(value)&&!value.split('/').some(p=>p==='.'||p==='..'||!p);}
export function parseNativeCheck(value:unknown):NativeCheck{
 if(!value||typeof value!=='object'||Array.isArray(value))fail('Expected a native check object.');
 const c=value as NativeCheck;
 if(Object.keys(c).some(k=>!['version','title','entry','timeoutSeconds','expectedExit','stdout','artifacts'].includes(k))||c.version!==1||typeof c.title!=='string'||!c.title.trim()||c.title.length>120||!relativeFile(c.entry)||!c.entry.endsWith('.sh')||!Number.isInteger(c.timeoutSeconds)||c.timeoutSeconds<10||c.timeoutSeconds>600||!Number.isInteger(c.expectedExit)||c.expectedExit<0||c.expectedExit>255||typeof c.stdout!=='string'||!c.stdout.length||c.stdout.length>8192||!Array.isArray(c.artifacts)||c.artifacts.length>8||c.artifacts.some(p=>!relativeFile(p))||new Set(c.artifacts).size!==c.artifacts.length)fail('Use a relative .sh entry, a 10–600s limit, exact expected output/exit and at most eight relative artifact paths.');
 return {version:1,title:c.title.trim(),entry:c.entry,timeoutSeconds:c.timeoutSeconds,expectedExit:c.expectedExit,stdout:c.stdout,artifacts:[...c.artifacts]};
}
export function assessNative(check:NativeCheck,observed:{exit:unknown;stdout:unknown}){return {passed:observed.exit===check.expectedExit&&observed.stdout===check.stdout,expectedExit:check.expectedExit,observedExit:observed.exit,stdoutMatches:observed.stdout===check.stdout};}
