/** First evidence adapter: Linux packaged GUI diagnostics, not independent source acceptance. */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {sha256} from '../../artifacts/store.ts';
import {desktopResources,type Runtime} from '../../desktop/runtime.ts';
import {parseJourney,assessJourney} from '../../desktop/schema.ts';
import {validatePng} from '../../desktop/output.ts';
import type {Approval,DesktopRun} from '../../desktop/store.ts';
import {EvidenceReader} from './reader.ts';
import {hash,uuidId,timestamp,object,type EvidenceScope,type EvidenceTarget,type EvidenceRecord} from './schema.ts';
export async function desktopProtocol(){return sha256(Buffer.concat(await Promise.all(['driver.mjs','package.mjs','probe.mjs','../schema.ts','../runtime.ts'].map(f=>readFile(path.join(desktopResources,f))))));}
function runtime(raw:unknown):Runtime{
 const r=object(raw,['image','arch','electron','playwright','asar','node','protocol']);
 if(typeof r.image!=='string'||!/^sha256:[a-f0-9]{64}$/u.test(r.image)||!['arm64','x64'].includes(String(r.arch))||!hash(r.protocol)||['electron','playwright','asar','node'].some(k=>typeof r[k]!=='string'||!/^v?\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?$/u.test(r[k] as string)))throw Error('Invalid retained desktop runtime.');return r as unknown as Runtime;
}
function approval(raw:unknown,id:string):Approval{
 const a=object(raw,['version','id','at','journey','runtime','digest']);const {digest,...body}=a;
 if(a.version!==1||a.id!==id||!uuidId(a.id,'journey')||!timestamp(a.at)||!hash(digest)||sha256(JSON.stringify(body))!==digest)throw Error('Invalid desktop approval identity.');parseJourney(a.journey);runtime(a.runtime);return a as unknown as Approval;
}
function run(raw:unknown,id:string):DesktopRun{
 const r=object(raw,['version','id','approval','approvalDigest','runtime','docker','token','status','at','message','artifacts','container','source','identity','package','report','assessment']);
 if(r.version!==1||r.id!==id||!uuidId(r.id,'desktop')||!uuidId(r.approval,'journey')||!hash(r.approvalDigest)||!timestamp(r.at)||!['preparing','running','passed','failed','interrupted','released'].includes(String(r.status))||typeof r.message!=='string'||r.message.length>16000||!Array.isArray(r.artifacts)||r.artifacts.length>40||new Set(r.artifacts).size!==r.artifacts.length||r.artifacts.some(a=>!uuidId(a,'artifact')))throw Error('Invalid selected desktop run.');
 runtime(r.runtime);for(const key of ['source','identity'])if(r[key]!==undefined&&!hash(r[key]))throw Error('Invalid desktop subject identity.');for(const key of ['package','report'])if(r[key]!==undefined&&!uuidId(r[key],'artifact'))throw Error('Invalid desktop artifact reference.');
 return r as unknown as DesktopRun;
}
export async function desktopChoices(project:string){
 const reader=new EvidenceReader(project+'-harness'),choices=[];
 for(const name of await reader.names('desktop/approvals')){if(name.startsWith('.harness-write-'))continue;if(!uuidId(name.slice(0,-5),'journey')||!name.endsWith('.json'))throw Error('Unexpected desktop approval file.');
  const a=approval(await reader.json('desktop/approvals/'+name),name.slice(0,-5));choices.push({title:a.journey.title,target:{provider:'linux-electron' as const,approval:a.id,approvalDigest:a.digest,runtime:sha256(JSON.stringify(a.runtime))}});
 }await reader.assertUnchanged();return choices.sort((a,b)=>a.target.approval.localeCompare(b.target.approval));
}
function base(target:EvidenceTarget,source:string):EvidenceRecord{return {...target,version:1,id:`runtime:${target.provider}:${target.approval}`,required:true,subject:{kind:'application',digest:source},applicability:'missing',outcome:'unknown',artifacts:[],detail:'No matching retained run.',limitations:['Packaged GUI observations are diagnostics; independent source acceptance remains separate.','Human review of interaction and accessibility is still required.'],next:'harness desktop verify '+target.approval};}
async function linux(reader:EvidenceReader,target:EvidenceTarget,source:string):Promise<EvidenceRecord>{
 const record=base(target,source);
 try{
  const raw=await reader.json(`desktop/approvals/${target.approval}.json`);if(!raw){record.detail='Selected journey approval is missing.';return record;}
  const a=approval(raw,target.approval);
  if(a.digest!==target.approvalDigest||sha256(JSON.stringify(a.runtime))!==target.runtime||a.runtime.protocol!==await desktopProtocol()){record.applicability='stale';record.detail='Selected approval or harness desktop protocol changed. Review product setup and journey settings.';record.next='harness product setup';return record;}
  const runs:DesktopRun[]=[];
  for(const id of await reader.names('desktop/runs')){
   if(id.startsWith('.harness-write-'))continue;if(!uuidId(id,'desktop'))throw Error('Unexpected desktop run directory.');
   const value=await reader.json(`desktop/runs/${id}/state.json`);
   // Unselected experiments are not requirements. Unidentifiable state cannot be safely ignored.
   if(!value||typeof value!=='object'||Array.isArray(value)||!uuidId((value as any).approval,'journey'))throw Error('Unidentifiable desktop run.');
   if((value as any).approval!==target.approval)continue;runs.push(run(value,id));
  }
  const current=runs.filter(r=>(r.source===source||r.source===undefined)&&r.approvalDigest===target.approvalDigest&&sha256(JSON.stringify(r.runtime))===target.runtime);
  const matching=current.length?current:runs;
  matching.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.id.localeCompare(b.id));const last=matching.at(-1);if(!last)return record;
  // Equal timestamps do not justify selecting a pass over another outcome.
  const tied=matching.filter(r=>Date.parse(r.at)===Date.parse(last.at));if(tied.length>1)throw Error('Ambiguous run ordering. Re-run the selected journey.');
  record.producer=last.id;record.at=last.at;record.outcome=last.status==='passed'?'unknown':last.status==='failed'?'failed':'incomplete';
  if(last.source)record.subject.digest=last.source;
  if(!current.length){record.applicability='stale';record.detail='Retained results belong to different source, approval or runtime.';return record;}
  record.applicability='current';
  if(!last.source){record.outcome='incomplete';record.detail='Latest selected attempt has no captured source; complete or recover it before relying on an older result.';record.next='harness desktop list';return record;}
  if(last.status!=='passed'){record.detail=`Selected journey is ${last.status}; no successful current evidence can be adopted.`;record.next='harness desktop list';return record;}
  const identity=sha256(JSON.stringify({source,approval:a.digest,runtime:last.runtime}));if(last.identity!==identity)throw Error('Desktop run identity changed.');
  if(!last.package||!last.report||!last.artifacts.includes(last.package)||!last.artifacts.includes(last.report))throw Error('Package or observation reference is missing.');
  const resolved=new Map<string,Awaited<ReturnType<EvidenceReader['artifact']>>>();
  for(const id of last.artifacts){const value=await reader.artifact(id),v=value.artifact;if(v.producer!==last.id||v.input!==source||v.environment!==identity)throw Error('Desktop artifact provenance changed.');resolved.set(id,value);}
  const observations=resolved.get(last.report)!,pkg=resolved.get(last.package)!;
  if(observations.artifact.name!=='observations.json'||pkg.artifact.name!=='app.asar'||pkg.artifact.verification!=='diagnostics-passed'||!pkg.bytes.length)throw Error('Package/report identity or diagnostic provenance changed.');
  const assessment=assessJourney(a.journey,JSON.parse(observations.bytes.toString()));
  for(const name of assessment.screenshots){const candidates=[...resolved.values()].filter(v=>v.artifact.name===name);if(candidates.length!==1)throw Error('Required screenshot is missing or ambiguous.');validatePng(candidates[0]!.bytes);}
  record.artifacts=[...resolved.values()].map(v=>({id:v.artifact.id,name:v.artifact.name,sha256:v.artifact.sha256})).sort((a,b)=>a.id.localeCompare(b.id));
  record.outcome=assessment.passed?'passed':'failed';record.detail=assessment.passed?`${assessment.checks} approved GUI observations matched on Linux ${last.runtime.arch}, Electron ${last.runtime.electron}; package and required screenshots retained.`:assessment.failures.join('; ');return record;
 }catch(e){record.applicability='invalid';record.outcome='unknown';record.detail=(e as Error).message;record.next='harness desktop list';return record;}
}
export async function collectEvidence(project:string,source:string,scope:EvidenceScope){
 const reader=new EvidenceReader(project+'-harness'),records:EvidenceRecord[]=[];
 for(const target of scope.targets){
  if(target.provider==='linux-electron')records.push(await linux(reader,target,source));
  else records.push({...base(target,source),subject:{kind:'unresolved'},applicability:'unavailable',detail:`${target.provider} aggregation is not implemented. Existing evidence remains retained.`,next:'harness guide'});
 }
 await reader.assertUnchanged();
 return {version:1 as const,records,digest:sha256(JSON.stringify(records)),assertUnchanged:()=>reader.assertUnchanged()};
}
