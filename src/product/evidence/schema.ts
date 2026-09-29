/** Evidence outcomes and applicability are deliberately separate. */
export const providers=['linux-electron','macos-electron','macos-native','cpu-regression','torch-cpu','metal-regression'] as const;
export type Provider=typeof providers[number];
export interface EvidenceTarget {provider:Provider;approval:string;approvalDigest:string;runtime:string;}
export interface EvidenceScope {version:1;targets:EvidenceTarget[];}
export interface EvidenceRecord extends EvidenceTarget {
 version:1;id:string;required:true;subject:{kind:'application'|'model'|'unresolved';digest?:string};
 applicability:'current'|'stale'|'missing'|'unavailable'|'invalid';outcome:'passed'|'failed'|'incomplete'|'unknown';
 execution?:{provider:'native-script';producer:string;approval:string;profile:string;source:string;artifacts:{id:string;name:string;sha256:string}[]};
 metrics?:{name:string;value:number;unit:string;threshold:number;comparison:'at-most'|'at-least';baseline?:number;samples:number}[];
 lineage?:{model:string;train:string;holdout:string;preprocessing:string;recipe:string;trainingSource?:string};
 producer?:string;at?:string;artifacts:{id:string;name:string;sha256:string}[];
 detail:string;limitations:string[];next:string;
}
export const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
export const uuidId=(v:unknown,prefix:string):v is string=>typeof v==='string'&&new RegExp(`^${prefix}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`,'u').test(v);
export function timestamp(v:unknown):v is string{return typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().replace('.000Z','Z')===v.replace('.000Z','Z');}
export function object(value:unknown,allowed:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw Error('Invalid or unknown evidence fields.');return value as Record<string,unknown>;
}
export function parseEvidenceScope(raw:unknown,kind:string):EvidenceScope{
 const s=object(raw,['version','targets']);if(s.version!==1||!Array.isArray(s.targets)||s.targets.length>16)throw Error('Evidence scope needs version 1 and at most 16 targets.');
 const seen=new Set<string>();const targets=s.targets.map(raw=>{
  const t=object(raw,['provider','approval','approvalDigest','runtime']);
  if(!providers.includes(t.provider as Provider)||typeof t.approval!=='string'||!/^[-a-z0-9]{1,100}$/u.test(t.approval)||!hash(t.approvalDigest)||!hash(t.runtime))throw Error('Invalid evidence selection.');
  const desktop=['linux-electron','macos-electron','macos-native'].includes(t.provider as string);
  if(desktop?kind!=='desktop':kind!=='ml')throw Error('Evidence target does not match product kind.');
  if(t.provider==='linux-electron'&&!uuidId(t.approval,'journey'))throw Error('Invalid Linux journey selection.');
  if(t.provider==='macos-electron'&&!uuidId(t.approval,'macos-check'))throw Error('Invalid macOS Electron journey selection.');
  if(t.provider==='macos-native'&&!uuidId(t.approval,'apple-check'))throw Error('Invalid native macOS journey selection.');
  for(const [provider,prefix] of [['cpu-regression','ml'],['torch-cpu','torch'],['metal-regression','metal']])if(t.provider===provider&&!uuidId(t.approval,prefix!))throw Error('Invalid ML workflow selection.');
  const key=t.provider+':'+t.approval;if(seen.has(key))throw Error('Duplicate evidence target.');seen.add(key);return {provider:t.provider as Provider,approval:t.approval,approvalDigest:t.approvalDigest,runtime:t.runtime};
 });return {version:1,targets:targets.sort((a,b)=>(a.provider+':'+a.approval).localeCompare(b.provider+':'+b.approval))};
}
export function evidenceStatus(e:EvidenceRecord):'passed'|'failed'|'missing'|'stale'|'unavailable'{
 if(e.applicability==='invalid')return 'failed';if(e.applicability!=='current')return e.applicability;
 return e.outcome==='passed'?'passed':e.outcome==='unknown'?'missing':'failed';
}
