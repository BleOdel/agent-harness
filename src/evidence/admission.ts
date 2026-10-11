/** Host-only policy. References are resolved by domain adapters, never by application code. */
import {createHash} from 'node:crypto';
export type DeliveryMode = 'ordinary' | 'staged' | 'team' | 'worktree';
export type EvidenceKind = 'design' | 'automatic' | 'source-review' | 'manual' | 'authorization';
export interface EvidenceBinding {candidate:string; contract:string; runtime:string; limitations:string;}
export interface EvidenceReference {id:string; sha256:string;}
export interface EvidenceEnvelope {version:1; route:DeliveryMode; binding:EvidenceBinding; references:EvidenceReference[];}
export interface EvidenceRequirement {id:string; kinds:EvidenceKind[];}
export interface EvidenceFact {
 kind:EvidenceKind; binding:EvidenceBinding; obligations:string[];
 verdict:'passed'|'failed'|'incomplete'; limitations:string[];
}
export interface Admission {
 status:'incomplete'|'failed'|'automated-passed'|'verified'|'authorized';
 missing:string[]; failures:string[]; limitations:string[]; references:EvidenceReference[];
}
export const evidenceHash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
export const reference=(id:string,bytes:Buffer|string):EvidenceReference=>({id,sha256:evidenceHash(bytes)});
const kinds:EvidenceKind[]=['design','automatic','source-review','manual','authorization'];
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const id=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=1000&&!v.includes('\0');
function fields(v:unknown,keys:string[]):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));}
function validBinding(v:unknown):v is EvidenceBinding{return fields(v,['candidate','contract','runtime','limitations'])&&Object.values(v).every(hash);}
function same(a:EvidenceBinding,b:EvidenceBinding){return validBinding(a)&&validBinding(b)&&Object.keys(a).every(k=>a[k as keyof EvidenceBinding]===b[k as keyof EvidenceBinding]);}
/** Required facets come from current host policy, not a receipt's claimed status or coverage. */
export async function evaluateAdmission(
 raw:EvidenceEnvelope, expected:EvidenceBinding, requirements:EvidenceRequirement[],
 resolve:(ref:EvidenceReference)=>Promise<{bytes:Buffer;fact:EvidenceFact}|undefined>,
):Promise<Admission>{
 const result:Admission={status:'incomplete',missing:[],failures:[],limitations:[],references:[]};
 if(!fields(raw,['version','route','binding','references'])||raw.version!==1||!['ordinary','staged','team','worktree'].includes(raw.route)||!same(raw.binding,expected)
  ||!Array.isArray(raw.references)||raw.references.length>2048||raw.references.some(r=>!fields(r,['id','sha256'])||!id(r.id)||!hash(r.sha256))||new Set(raw.references.map(r=>r.id)).size!==raw.references.length
  ||!Array.isArray(requirements)||!requirements.length||requirements.length>2048||requirements.some(r=>!fields(r,['id','kinds'])||!id(r.id)||!Array.isArray(r.kinds)||!r.kinds.length||r.kinds.some(k=>!kinds.includes(k))||new Set(r.kinds).size!==r.kinds.length)||new Set(requirements.map(r=>r.id)).size!==requirements.length){
  result.failures.push('Invalid evidence envelope, requirement policy or current binding.');return result;
 }
 const observed=new Set<string>();
 for(const ref of raw.references){
  let resolved;
  try{resolved=await resolve(ref);}catch(error){result.failures.push(`${ref.id}: ${(error as Error).message}`);continue;}
  if(!resolved){result.failures.push(`${ref.id}: missing evidence artifact.`);continue;}
  const {bytes,fact}=resolved;
  if(!Buffer.isBuffer(bytes)||evidenceHash(bytes)!==ref.sha256||!fields(fact,['kind','binding','obligations','verdict','limitations'])||!kinds.includes(fact.kind)||!same(fact.binding,expected)
   ||!Array.isArray(fact.obligations)||fact.obligations.length>2048||fact.obligations.some(o=>!id(o))||new Set(fact.obligations).size!==fact.obligations.length
   ||!['passed','failed','incomplete'].includes(fact.verdict)||!Array.isArray(fact.limitations)||fact.limitations.some(l=>typeof l!=='string'||!l.trim()||l.length>8000)){
   result.failures.push(`${ref.id}: changed, malformed or stale evidence.`);continue;
  }
  result.references.push({...ref});result.limitations.push(...fact.limitations);
  if(fact.verdict!=='passed'){result.failures.push(`${ref.id}: ${fact.verdict} evidence.`);continue;}
  for(const obligation of fact.obligations)observed.add(`${obligation}:${fact.kind}`);
 }
 result.limitations=[...new Set(result.limitations)];
 result.missing=requirements.flatMap(r=>r.kinds.filter(k=>!observed.has(`${r.id}:${k}`)).map(k=>`${r.id}:${k}`));
 if(result.failures.length)result.status='failed';
 else if(result.missing.some(m=>!m.endsWith(':manual')&&!m.endsWith(':authorization')))result.status='incomplete';
 else if(result.missing.some(m=>m.endsWith(':manual')))result.status='automated-passed';
 else if(result.missing.length||!requirements.some(r=>r.kinds.includes('authorization')))result.status='verified';
 else result.status='authorized';
 return result;
}
