import {approvalDigest,parseChecks,type Approval as AcceptanceApproval} from '../../acceptance/checks.ts';
/** Read-only browser projection: reporting must not initialize runner/artifact stores. */
import type {ReportCheck} from '../report.ts';
import type {Approval,BrowserRun} from '../../browser/store.ts';
import {parseJourney,assessJourney} from '../../browser/schema.ts';
import {sha256} from '../../artifacts/store.ts';
import {EvidenceReader} from './reader.ts';
import {hash,uuidId,timestamp} from './schema.ts';
export async function browserChecks(project:string,source:string){
 const reader=new EvidenceReader(project+'-harness'),approvals:Approval[]=[],runs:BrowserRun[]=[],checks:ReportCheck[]=[];
 for(const file of await reader.names('browser/approvals')){if(file.startsWith('.'))continue;if(!file.endsWith('.json')||!uuidId(file.slice(0,-5),'web-journey'))throw Error('Invalid browser approval filename.');const a=await reader.json('browser/approvals/'+file) as Approval;if(!a)throw Error('Missing browser approval.');const {digest,...body}=a;if(a.version!==1||a.id!==file.slice(0,-5)||!timestamp(a.at)||digest!==sha256(JSON.stringify(body)))throw Error('Browser approval changed.');parseJourney(a.journey);if(!a.runtime||!hash(a.runtime.protocol)||!/^sha256:[a-f0-9]{64}$/u.test(a.runtime.image))throw Error('Browser runtime missing.');if(a.acceptance){
 const current=await reader.json('acceptance/approved.json') as AcceptanceApproval|undefined;
 if(!current||current.digest!==a.acceptance.approvalDigest)continue;
 const manifest=parseChecks(current.manifest);if(current.digest!==approvalDigest(manifest,current.browserRuntime))throw Error('Acceptance approval changed.');
 if(!manifest.cases.some(c=>c.id===a.acceptance!.caseId&&c.kind==='browser'&&JSON.stringify(c.browser)===JSON.stringify(a.journey))||JSON.stringify(current.browserRuntime)!==JSON.stringify(a.runtime))throw Error('Derived browser journey no longer matches approved acceptance.');
 }approvals.push(a);}
 for(const id of await reader.names('browser/runs')){if(id.startsWith('.'))continue;if(!uuidId(id,'browser'))throw Error('Invalid browser run directory.');const r=await reader.json(`browser/runs/${id}/state.json`) as BrowserRun;if(!r||r.version!==1||r.id!==id||!uuidId(r.approval,'web-journey')||!hash(r.approvalDigest)||!timestamp(r.at)||!['preparing','running','passed','failed','interrupted','released'].includes(r.status)||typeof r.message!=='string'||!Array.isArray(r.containers))throw Error('Invalid browser run evidence.');runs.push(r);}
 if(!approvals.length)checks.push({id:'browser',status:'missing',detail:'No approved browser journey.',next:'harness browser setup'});
 for(const a of approvals){
  const matching=runs.filter(r=>r.approval===a.id&&r.status!=='released').sort((a,b)=>a.at.localeCompare(b.at));const last=matching.at(-1);if(last&&matching.filter(r=>r.at===last.at).length>1)throw Error('Ambiguous browser run ordering.');
  let status:ReportCheck['status']=!last?'missing':last.source!==source?'stale':'failed';
  if(last?.status==='passed'&&last.source===source&&last.approvalDigest===a.digest&&last.report&&!last.containers.length){
   const {artifact,bytes}=await reader.artifact(last.report),identity=sha256(JSON.stringify({source,approval:a.digest,runtime:last.runtime}));
   if(artifact.producer!==last.id||artifact.input!==source||artifact.environment!==identity||last.identity!==identity||JSON.stringify(last.runtime)!==JSON.stringify(a.runtime))throw Error('Browser artifact provenance changed.');
   if(assessJourney(a.journey,JSON.parse(bytes.toString())).passed)status='passed';
  }
  checks.push({id:'browser',status,detail:`${a.id}: ${last?.message??'No run yet.'}`,next:last&&['preparing','running'].includes(last.status)?'harness browser list':`harness browser verify ${a.id}`});
 }
 await reader.assertUnchanged();return {checks,assertUnchanged:()=>reader.assertUnchanged()};
}
