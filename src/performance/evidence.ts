import {EvidenceReader} from '../product/evidence/reader.ts';
import {uuidId} from '../product/evidence/schema.ts';
import {parseRun,parseApproval,runIdentity,type Approval,type Environment,type Baseline} from './store.ts';
import {parseObservation,compare,canonicalHash,workloadDigest,type Profile} from './schema.ts';
export async function execution(reader:EvidenceReader,id:string){
 if(!uuidId(id,'performance-run'))throw Error('Invalid benchmark run reference.');
 const raw=await reader.json(`performance/runs/${id}/state.json`),r=parseRun(raw);
 if(r.verified!==true||r.id!==id||r.containers.length||!['passed','failed'].includes(r.status)||!r.report||!r.source)throw Error('Benchmark execution is incomplete.');
 const a=parseApproval(await reader.json(`performance/approvals/${r.approvalId}.json`));
 if(a.id!==r.approvalId||a.digest!==r.approval||a.product!==r.product||a.protocol!==r.protocol||a.environment.image!==r.image||r.identity!==runIdentity(r.source,a))throw Error('Benchmark provenance changed.');
 const result=await reader.artifact(r.report),artifact=result.artifact;
 if(artifact.name!=='performance-samples.json'||artifact.producer!==r.id||artifact.input!==r.source||artifact.environment!==r.identity)throw Error('Benchmark sample artifact substituted.');
 const observations=parseObservation(JSON.parse(result.bytes.toString()));return {r,a,observations,record:canonicalHash(raw)};
}
export async function selectBaseline(project:string,id:string,profile:Profile,environment:Environment,protocol:string):Promise<Baseline>{
 const reader=new EvidenceReader(project+'-harness'),e=await execution(reader,id);
 if(e.a.protocol!==protocol||canonicalHash(e.a.environment)!==canonicalHash(environment)||workloadDigest(e.a.profile)!==workloadDigest(profile))throw Error('Baseline workload, runtime or measurement rules differ.');
 const prior=await validateBaseline(reader,e.a);const compared=compare(e.a.profile,e.observations,prior);if(!compared.passed||compared.metrics.errors)throw Error('Baseline needs complete, correct, passing measurements.');
 await reader.assertUnchanged();return {run:id,artifact:e.r.report!,record:e.record,source:e.r.source!,meanMs:compared.metrics.meanMs,throughputRps:compared.metrics.throughputRps};
}
export async function validateBaseline(reader:EvidenceReader,a:Approval,seen=new Set<string>()):Promise<Baseline|undefined>{
 if(!a.baseline)return;const b=a.baseline;if(seen.has(b.run)||seen.size>=16)throw Error('Baseline chain is cyclic or exceeds 16 links.');seen.add(b.run);const e=await execution(reader,b.run),prior=await validateBaseline(reader,e.a,seen),c=compare(e.a.profile,e.observations,prior);
 if(e.r.report!==b.artifact||e.record!==b.record||e.r.source!==b.source||e.a.protocol!==a.protocol||canonicalHash(e.a.environment)!==canonicalHash(a.environment)||workloadDigest(e.a.profile)!==workloadDigest(a.profile)||!c.passed||c.metrics.errors||c.metrics.meanMs!==b.meanMs||c.metrics.throughputRps!==b.throughputRps)throw Error('Approved baseline changed or is unavailable.');return b;
}
