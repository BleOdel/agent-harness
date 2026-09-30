import {saveJson} from '../artifacts/store.ts';
import {EvidenceReader} from '../product/evidence/reader.ts';
import {object,hash,timestamp,uuidId} from '../product/evidence/schema.ts';
import {parseApproval,parseRun,performanceProtocol,performanceRoot,type Environment,type PerformanceRun} from './store.ts';
import {execution,validateBaseline} from './evidence.ts';
import {compare,canonicalHash,type Metrics,type Profile} from './schema.ts';
export interface PerformanceReport {version:1;status:'passed'|'failed'|'missing'|'stale'|'unavailable';configured:boolean;complete:boolean;source:string;scope?:string;run?:string;artifact?:string;environment?:Environment;profile?:Profile;metrics?:Metrics;baseline?:{run:string;source:string;meanMs:number;throughputRps:number};failures:string[];evidenceDigest?:string;assessment:'missing'|'passed'|'failed'|'stale';detail:string;limitations:string[];next:string;}
const limitations=['Warmed application, fresh connection per request, sequential closed-loop GETs. Startup/cold latency and concurrent production load are not measured.','Throughput includes observer scheduling and between-request sample persistence. Laptop/VM contention can affect results.','No tail percentiles are claimed from this bounded sample. Memory, GPU and desktop/ML timings are unavailable.','Only the approved endpoint and exact JSON response are checked. This is not a complete correctness or production-capacity assessment.','Runtime is the recorded Docker environment, not a live assertion about the current host. Reporting starts no compute.'];
export async function performanceReport(project:string,context:{source:string;product:string}):Promise<PerformanceReport>{
 const reader=new EvidenceReader(project+'-harness'),out:PerformanceReport={version:1,status:'missing',configured:false,complete:false,source:context.source,failures:[],assessment:'missing',detail:'Approve a local API benchmark profile.',limitations,next:'harness performance setup'};
 try{
  const raw=await reader.json('performance/approved.json');if(!raw)return out;out.configured=true;const a=parseApproval(raw);out.scope=a.digest;out.environment=a.environment;out.profile=a.profile;
  if(a.product!==context.product||a.protocol!==await performanceProtocol()){out.status='stale';out.detail='Benchmark profile or measurement rules changed.';return out;}
  const runs:PerformanceRun[]=[];for(const id of await reader.names('performance/runs')){if(id.startsWith('.'))continue;if(!uuidId(id,'performance-run'))throw Error('Invalid run directory.');const r=parseRun(await reader.json(`performance/runs/${id}/state.json`));if(r.id!==id)throw Error('Run identity changed.');if(r.approval===a.digest)runs.push(r);}
  const matching=runs.filter(r=>r.source===context.source||!r.source).sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id)),last=matching.at(-1);
  if(last&&matching.filter(r=>r.at===last.at).length!==1)throw Error('Ambiguous benchmark order.');out.next='harness performance verify';
  if(!last){out.status=runs.length?'stale':'missing';out.detail='No matching current-source benchmark.';return out;}
  out.run=last.id;if(last.report)out.artifact=last.report;
  if(last.containers.length||['preparing','running'].includes(last.status)){out.status='failed';out.detail='Benchmark or owned cleanup is unfinished.';out.next='harness performance recover '+last.id;return out;}
  if(!last.verified||!['passed','failed'].includes(last.status)||!last.report){out.status='failed';out.detail='Incomplete trial; retained partial samples cannot pass.';return out;}
  const e=await execution(reader,last.id);if(e.a.digest!==a.digest)throw Error('Benchmark scope substituted.');const baseline=await validateBaseline(reader,a),c=compare(a.profile,e.observations,baseline);
  out.metrics=c.metrics;out.failures=c.failures;if(baseline)out.baseline={run:baseline.run,source:baseline.source,meanMs:baseline.meanMs,throughputRps:baseline.throughputRps};
  out.evidenceDigest=canonicalHash({source:context.source,scope:a.digest,read:reader.digest(),metrics:c.metrics,failures:c.failures});
  const assessment=await reader.json('performance/assessment.json');if(assessment){const s=object(assessment,['version','scope','evidence','at','passed','notes']);if(s.version!==1||!hash(s.scope)||!hash(s.evidence)||!timestamp(s.at)||typeof s.passed!=='boolean')throw Error('Invalid performance assessment.');notes(s.notes);out.assessment=s.scope!==a.digest||s.evidence!==out.evidenceDigest?'stale':s.passed?'passed':'failed';}
  out.complete=c.passed&&out.assessment==='passed';out.status=!c.passed||out.assessment==='failed'?'failed':out.assessment==='stale'?'stale':out.complete?'passed':'missing';
  out.detail=!c.passed?'Approved benchmark comparisons failed: '+c.failures.join(', '):out.complete?'Scoped performance evidence and separate assessment complete.':'Measurements matched; review workload relevance and environment limits separately.';
  out.next=c.passed?(out.complete?'harness product report':'harness performance assess'):'harness performance verify';await reader.assertUnchanged();return out;
 }catch{out.status='failed';out.complete=false;delete out.metrics;out.detail='Performance evidence is malformed, incomplete, substituted or inconsistent. No raw response content is displayed.';out.next='harness performance verify';return out;}
}
function notes(v:unknown):string{if(typeof v!=='string'||v.trim().length<20||v.length>1500||/[\x00-\x1f\x7f]/u.test(v))throw Error('Explain workload relevance and limits in 20–1500 characters without secrets.');return v;}
export async function recordPerformanceAssessment(project:string,report:PerformanceReport,passed:boolean,text:string){if(!report.scope||!report.evidenceDigest)throw Error('Review complete current measurements before assessment.');await saveJson(await performanceRoot(project),'assessment.json',{version:1,scope:report.scope,evidence:report.evidenceDigest,at:new Date().toISOString(),passed,notes:notes(text)});}
