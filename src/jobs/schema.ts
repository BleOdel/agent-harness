import { artifactName } from '../artifacts/store.ts';
import { OperatorError } from '../verbs/io.ts';
export interface JobSpec {version:1;title:string;command:string[];outputs:string[];checkpoint?:{protocol:string;total:number};limits:{timeoutSeconds:number;totalSeconds:number;maxAttempts:number};}
const fail=(message:string):never=>{throw new OperatorError(message);};
function object(value:unknown,keys:string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))fail('Invalid or unknown job setting.');return value as Record<string,unknown>;}
export function parseJobSpec(raw:unknown):JobSpec{
 const s=object(raw,['version','title','command','outputs','checkpoint','limits']);
 if(s.version!==1||typeof s.title!=='string'||!s.title.trim()||s.title.length>120||/[\x00-\x1f\x7f]/u.test(s.title))fail('Job needs version 1 and a short title.');
 if(!Array.isArray(s.command)||s.command.length<1||s.command.length>64||s.command.some(v=>typeof v!=='string'||!v||v.length>4096||v.includes('\0')))fail('Job command must be a nonempty argv array.');
 if(!Array.isArray(s.outputs)||s.outputs.length>16||s.outputs.some(v=>typeof v!=='string'||!artifactName(v)||['checkpoint.json','context.json','resume.json'].includes(v))||new Set(s.outputs).size!==s.outputs.length)fail('Declare at most 16 unique output paths, relative to .harness-output.');
 const l=object(s.limits,['timeoutSeconds','totalSeconds','maxAttempts']);
 if(![l.timeoutSeconds,l.totalSeconds,l.maxAttempts].every(Number.isSafeInteger)||Number(l.timeoutSeconds)<1||Number(l.totalSeconds)<Number(l.timeoutSeconds)||Number(l.totalSeconds)>86400||Number(l.maxAttempts)<1||Number(l.maxAttempts)>8)fail('Use positive time limits (total up to 24h) and 1–8 attempts.');
 if(s.checkpoint!==undefined){const c=object(s.checkpoint,['protocol','total']);if(c.protocol!=='json-step@1'||!Number.isSafeInteger(c.total)||Number(c.total)<1||Number(c.total)>1000000)fail('Only json-step@1 checkpoints with 1–1000000 steps are supported.');}
 return structuredClone(s) as unknown as JobSpec;
}
export interface Checkpoint {version:1;protocol:'json-step@1';identity:string;completed:number;total:number;payload:Record<string,unknown>;}
/** Installed protocol validation establishes compatibility, not model or algorithm quality. */
export function validateCheckpoint(bytes:Buffer,spec:{protocol:string;total:number},identity:string,minimum=0):Checkpoint{
 if(bytes.length>1024*1024)fail('Checkpoint exceeds 1 MiB.');
 const c=object(JSON.parse(bytes.toString()),['version','protocol','identity','completed','total','payload']);
 if(c.version!==1||spec.protocol!=='json-step@1'||c.protocol!==spec.protocol||c.identity!==identity||c.total!==spec.total||!Number.isSafeInteger(c.completed)||Number(c.completed)<minimum||Number(c.completed)>spec.total||!c.payload||typeof c.payload!=='object'||Array.isArray(c.payload))fail('Checkpoint is incompatible with this job, its inputs or progress.');
 return c as unknown as Checkpoint;
}
