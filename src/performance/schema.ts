import {object,hash} from '../product/evidence/schema.ts';
import {canonical,canonicalHash} from './instrumentation/json.mjs';
export {canonicalHash};
export interface Profile {version:1;entry:string;port:number;databaseEnv?:string;path:string;expectedStatus:number;expectedJson:unknown;warmup:number;repetitions:number;samples:number;requestTimeoutMs:number;maxSeconds:number;meanMs:number;minRps:number;maxErrorPercent:number;maxSpreadPercent:number;maxRegressionPercent:number;}
const finite=(v:unknown,min:number,max:number)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
const integer=(v:unknown,min:number,max:number)=>Number.isInteger(v)&&finite(v,min,max);
export function parseProfile(raw:unknown):Profile{
 const p=object(raw,['version','entry','port','databaseEnv','path','expectedStatus','expectedJson','warmup','repetitions','samples','requestTimeoutMs','maxSeconds','meanMs','minRps','maxErrorPercent','maxSpreadPercent','maxRegressionPercent']);
 if(p.version!==1||typeof p.entry!=='string'||! /^[\w-]+(?:\/[\w.-]+)*\.(?:js|mjs|cjs)$/u.test(p.entry)||p.entry.length>200||p.entry.split('/').some(x=>x==='..'||x==='.')||!integer(p.port,1024,65535)||typeof p.path!=='string'||!/^\/(?:[A-Za-z0-9_-]+\/?)*$/u.test(p.path)||p.path.length>200||!integer(p.expectedStatus,200,299)||!integer(p.warmup,1,50)||!integer(p.repetitions,3,10)||!integer(p.samples,5,100)||!integer(p.requestTimeoutMs,50,3000)||!integer(p.maxSeconds,15,300)||!finite(p.meanMs,0.01,10000)||!finite(p.minRps,0.01,100000)||!finite(p.maxErrorPercent,0,10)||!finite(p.maxSpreadPercent,0,500)||!finite(p.maxRegressionPercent,0,500))throw Error('Invalid bounded performance profile.');
 if(p.databaseEnv!==undefined&&(typeof p.databaseEnv!=='string'||!/^([A-Z][A-Z0-9_]*_)?(DB|DATABASE)(_PATH|_FILE)?$/u.test(p.databaseEnv)))throw Error('Invalid database environment variable.');
 if(canonical(p.expectedJson).length>8192)throw Error('Expected JSON exceeds 8 KiB.');return structuredClone(p) as unknown as Profile;
}
export function workloadDigest(profile:Profile){const {meanMs:_,minRps:_r,maxErrorPercent:_e,maxSpreadPercent:_s,maxRegressionPercent:_b,...workload}=parseProfile(profile);return canonicalHash(workload);}
export interface Sample {ms:number;status:number|null;bodyHash:string|null;error:null|'timeout'|'network'|'body-limit'|'invalid-json';}
export interface Round {warmup:Sample[];samples:Sample[];elapsedMs:number;}
export interface Observation {version:1;complete:boolean;rounds:Round[];}
export function parseObservation(raw:unknown):Observation{
 const o=object(raw,['version','complete','rounds']);if(o.version!==1||typeof o.complete!=='boolean'||!Array.isArray(o.rounds)||o.rounds.length<1||o.rounds.length>10)throw Error('Incomplete performance observations.');
 for(const rawRound of o.rounds){const r=object(rawRound,['warmup','samples','elapsedMs']);if(!finite(r.elapsedMs,0,310000)||!Array.isArray(r.warmup)||r.warmup.length>50||!Array.isArray(r.samples)||r.samples.length>100)throw Error('Invalid repetition.');for(const rawSample of [...r.warmup,...r.samples]){const s=object(rawSample,['ms','status','bodyHash','error']);if(!finite(s.ms,0,310000)||!(s.status===null||integer(s.status,100,599))||!(s.bodyHash===null||hash(s.bodyHash))||![null,'timeout','network','body-limit','invalid-json'].includes(s.error as null)|| (s.error===null&&(s.status===null||s.bodyHash===null)))throw Error('Malformed timing sample.');}}
 return o as unknown as Observation;
}
export interface Metrics {samples:number;errors:number;errorPercent:number;meanMs:number;throughputRps:number;spreadPercent:number;repetitions:{meanMs:number;throughputRps:number;errors:number}[];}
export function compare(rawProfile:Profile,raw:unknown,baseline?:{meanMs:number;throughputRps:number}){
 const p=parseProfile(rawProfile),o=parseObservation(raw),expected=canonicalHash(p.expectedJson);
 if(!o.complete||o.rounds.length!==p.repetitions||o.rounds.some(r=>r.warmup.length!==p.warmup||r.samples.length!==p.samples||r.elapsedMs<=0||r.elapsedMs+1<r.samples.reduce((n,s)=>n+s.ms,0)))throw Error('Missing or inconsistent measured samples.');
 const correct=(s:Sample)=>s.error===null&&s.status===p.expectedStatus&&s.bodyHash===expected;
 const samples=o.rounds.flatMap(r=>r.samples),errors=samples.filter(s=>!correct(s)).length,meanMs=samples.reduce((n,s)=>n+s.ms,0)/samples.length,elapsed=o.rounds.reduce((n,r)=>n+r.elapsedMs,0);
 const repetitions=o.rounds.map(r=>({meanMs:r.samples.reduce((n,s)=>n+s.ms,0)/r.samples.length,throughputRps:r.samples.filter(correct).length*1000/r.elapsedMs,errors:r.samples.filter(s=>!correct(s)).length}));
 const means=repetitions.map(r=>r.meanMs),spreadPercent=meanMs===0?0:(Math.max(...means)-Math.min(...means))/meanMs*100;
 const metrics:Metrics={samples:samples.length,errors,errorPercent:errors/samples.length*100,meanMs,throughputRps:(samples.length-errors)*1000/elapsed,spreadPercent,repetitions},failures:string[]=[];
 if(o.rounds.some(r=>r.warmup.some(s=>!correct(s)))||samples.some(s=>s.error!=='timeout'&&s.error!=='network'&&!correct(s)))failures.push('response correctness');
 if(meanMs>p.meanMs)failures.push('mean latency');if(metrics.throughputRps<p.minRps)failures.push('successful throughput');if(metrics.errorPercent>p.maxErrorPercent)failures.push('error rate');if(spreadPercent>p.maxSpreadPercent)failures.push('repeat stability');
 if(baseline&&(meanMs>baseline.meanMs*(1+p.maxRegressionPercent/100)||metrics.throughputRps<baseline.throughputRps/(1+p.maxRegressionPercent/100)))failures.push('approved baseline regression');
 return {passed:failures.length===0,metrics,failures};
}
