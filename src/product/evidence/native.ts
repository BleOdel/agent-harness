/** macOS GUI evidence is linked to the underlying native run; no VM is started here. */
import path from 'node:path';
import {sha256} from '../../artifacts/store.ts';
import {guiProtocol} from '../../native/gui/provision.ts';
import {appleProtocol} from '../../native/apple/runtime.ts';
import {protocolHash,type NativeProfile} from '../../native/provision.ts';
import {parseMacJourney,assessMacJourney} from '../../native/gui/schema.ts';
import {parseAppleJourney,assessAppleJourney,type AppleJourney} from '../../native/apple/schema.ts';
import {parseNativeCheck,assessNative} from '../../native/schema.ts';
import {validatePng} from '../../desktop/output.ts';
import type {Journey} from '../../desktop/schema.ts';
import {EvidenceReader} from './reader.ts';
import {hash,uuidId,timestamp,object,type EvidenceTarget,type EvidenceRecord} from './schema.ts';
export type MacProvider='macos-electron'|'macos-native';
const lanes={
 'macos-electron':{folder:'macos-gui',approval:'macos-check',run:'macos',command:'macos',package:'app.asar',entry:'gui-run.sh',stdout:'macOS GUI observations ready\n',parse:parseMacJourney,assess:assessMacJourney,protocol:guiProtocol},
 'macos-native':{folder:'apple-gui',approval:'apple-check',run:'apple',command:'macos-native',package:'app.zip',entry:'apple-run.sh',stdout:'Native UI observations ready\n',parse:parseAppleJourney,assess:assessAppleJourney,protocol:appleProtocol},
} as const;
interface MacRuntime {profile:NativeProfile;protocol:string;electron?:string;}
interface Approval {version:1;id:string;at:string;journey:Journey|AppleJourney;runtime:MacRuntime;digest:string;}
interface Run {version:1;id:string;approval:string;approvalDigest:string;runtime:MacRuntime;at:string;controllerPid:number;status:string;message:string;source?:string;artifacts:string[];nativeRun?:string;}
function runtime(raw:unknown,kind:MacProvider):MacRuntime{
 const r=object(raw,kind==='macos-electron'?['profile','protocol','electron']:['profile','protocol']);
 if(!hash(r.protocol)||(kind==='macos-electron'&&(typeof r.electron!=='string'||!/^\d+\.\d+\.\d+$/u.test(r.electron))))throw Error('Invalid macOS GUI runtime.');
 const p=object(r.profile,['version','tart','tartHash','networkHash','cloneHash','image','files','identities','protocol','cpu','memoryMiB','os','arch']);
 if(p.version!==1||typeof p.tart!=='string'||p.tart.length>1000||!path.isAbsolute(p.tart)||typeof p.image!=='string'||!/^harness-macos-[a-z0-9-]+$/u.test(p.image)||p.cpu!==2||p.memoryMiB!==4096||p.arch!=='arm64'||typeof p.os!=='string'||!p.os.trim()||p.os.length>80||/[\x00-\x1f]/u.test(p.os)||['tartHash','networkHash','cloneHash','protocol'].some(k=>!hash(p[k])))throw Error('Invalid retained native profile.');
 for(const key of ['files','identities']){const values=object(p[key],['disk.img','nvram.bin','config.json']);if(Object.keys(values).length!==3||Object.values(values).some(v=>!hash(v)))throw Error('Incomplete native base image identity.');}
 return r as unknown as MacRuntime;
}
function approval(raw:unknown,id:string,kind:MacProvider):Approval{
 const a=object(raw,['version','id','at','journey','runtime','digest']),{digest,...body}=a;
 if(a.version!==1||a.id!==id||!uuidId(a.id,lanes[kind].approval)||!timestamp(a.at)||!hash(digest)||sha256(JSON.stringify(body))!==digest)throw Error('Invalid native GUI approval.');
 lanes[kind].parse(a.journey);runtime(a.runtime,kind);return a as unknown as Approval;
}
function run(raw:unknown,id:string,kind:MacProvider):Run{
 const r=object(raw,['version','id','approval','approvalDigest','runtime','at','controllerPid','status','message','source','artifacts','nativeRun','assessment']);
 if(r.version!==1||r.id!==id||!uuidId(id,lanes[kind].run)||!uuidId(r.approval,lanes[kind].approval)||!hash(r.approvalDigest)||!timestamp(r.at)||!Number.isSafeInteger(r.controllerPid)||Number(r.controllerPid)<1||!['preparing','running','passed','failed','interrupted'].includes(String(r.status))||typeof r.message!=='string'||r.message.length>16000||!Array.isArray(r.artifacts)||r.artifacts.length>40||new Set(r.artifacts).size!==r.artifacts.length||r.artifacts.some(id=>!uuidId(id,'artifact'))||(r.source!==undefined&&!hash(r.source))||(r.nativeRun!==undefined&&!uuidId(r.nativeRun,'native')))throw Error('Invalid native GUI run.');
 runtime(r.runtime,kind);return r as unknown as Run;
}
export async function nativeChoices(reader:EvidenceReader){
 const choices:{title:string;target:EvidenceTarget}[]=[];
 for(const kind of Object.keys(lanes) as MacProvider[]){const lane=lanes[kind];
  for(const file of await reader.names(lane.folder+'/approvals')){if(file.startsWith('.harness-write-'))continue;if(!file.endsWith('.json')||!uuidId(file.slice(0,-5),lane.approval))throw Error('Unexpected native GUI approval file.');
   const a=approval(await reader.json(lane.folder+'/approvals/'+file),file.slice(0,-5),kind);choices.push({title:`${kind}: ${a.journey.title}`,target:{provider:kind,approval:a.id,approvalDigest:a.digest,runtime:sha256(JSON.stringify(a.runtime))}});
  }
 }return choices;
}
/** Validate the host-copied bytes against the child run, including cleanup and script exit. */
async function nativeLineage(reader:EvidenceReader,kind:MacProvider,a:Approval,r:Run,outer:Map<string,Awaited<ReturnType<EvidenceReader['artifact']>>>){
 const lane=lanes[kind];if(!r.nativeRun)throw Error('Underlying native execution is missing.');
 const namespace=`${lane.folder}/runs/${r.id}/candidate-harness/`;
 const n=object(await reader.json(`${namespace}native/runs/${r.nativeRun}/state.json`),['version','id','token','approval','profileDigest','status','message','at','artifacts','source','outputMounted','vmStarted','controllerPid']);
 const profileDigest=sha256(JSON.stringify(a.runtime.profile));
 if(n.version!==1||n.id!==r.nativeRun||!uuidId(n.approval,'native-check')||!timestamp(n.at)||!hash(n.source)||n.profileDigest!==profileDigest||n.status!=='passed'||n.outputMounted!==false||n.vmStarted!==true||!Array.isArray(n.artifacts)||n.artifacts.length>40||new Set(n.artifacts).size!==n.artifacts.length||n.artifacts.some(id=>!uuidId(id,'artifact')))throw Error('Native execution is incomplete, changed, or still needs cleanup.');
 const na=object(await reader.json(`${namespace}native/approvals/${n.approval}.json`),['version','id','at','check','profileDigest','digest']);const {digest,...body}=na;
 if(na.version!==1||na.id!==n.approval||!timestamp(na.at)||na.profileDigest!==profileDigest||!hash(digest)||sha256(JSON.stringify(body))!==digest)throw Error('Underlying native approval changed.');
 const check=parseNativeCheck(na.check),screens=a.journey.steps.flatMap((s,i)=>s.action==='screenshot'?[`screen-${i}.png`]:[]);
 if(check.entry!==lane.entry||check.title!==a.journey.title||check.timeoutSeconds!==a.journey.timeoutSeconds||check.expectedExit!==0||check.stdout!==lane.stdout||JSON.stringify(check.artifacts)!==JSON.stringify(['observations.json',lane.package,...screens]))throw Error('Native execution does not match the GUI journey contract.');
 const child=new Map<string,Awaited<ReturnType<EvidenceReader['artifact']>>>();
 for(const id of n.artifacts as string[]){const value=await reader.artifact(id,namespace),v=value.artifact;if(v.producer!==r.nativeRun||v.input!==n.source||v.environment!==profileDigest||child.has(v.name))throw Error('Native artifact provenance changed or names are ambiguous.');child.set(v.name,value);
  const copy=outer.get(v.name);if(!copy||copy.artifact.sha256!==v.sha256)throw Error('Copied GUI artifact differs from its native execution.');
 }
 for(const name of outer.keys())if(name!=='gui-assessment.json'&&!child.has(name))throw Error('GUI artifact has no underlying execution evidence.');
 const stdout=child.get('stdout.txt'),result=child.get('assessment.json');if(!stdout||!result)throw Error('Native exit/output observations are missing.');
 const observed=object(JSON.parse(result.bytes.toString()),['passed','expectedExit','observedExit','stdoutMatches']);
 if(!Number.isInteger(observed.observedExit)||Number(observed.observedExit)<0||Number(observed.observedExit)>255||!assessNative(check,{exit:observed.observedExit,stdout:stdout.bytes.toString()}).passed)throw Error('Native script exit/output did not match expectations.');
 return {provider:'native-script' as const,producer:r.nativeRun,approval:String(n.approval),profile:profileDigest,source:n.source,artifacts:[...child.values()].map(v=>({id:v.artifact.id,name:v.artifact.name,sha256:v.artifact.sha256})).sort((a,b)=>a.id.localeCompare(b.id))};
}
export async function nativeEvidence(reader:EvidenceReader,target:EvidenceTarget,source:string):Promise<EvidenceRecord>{
 const kind=target.provider as MacProvider,lane=lanes[kind];
 const record:EvidenceRecord={...target,version:1,id:`runtime:${kind}:${target.approval}`,required:true,subject:{kind:'application',digest:source},applicability:'missing',outcome:'unknown',artifacts:[],detail:'No matching retained macOS GUI run.',limitations:['Guest GUI observations are diagnostics; independent source acceptance remains separate.','Unsigned/ad-hoc packaged app evidence does not establish signing, distribution readiness or universal accessibility.','Human interaction and accessibility assessment is still required.'],next:`harness ${lane.command} verify ${target.approval}`};
 try{
  if(!uuidId(target.approval,lane.approval))throw Error('Approval does not belong to the selected desktop provider.');
  const raw=await reader.json(`${lane.folder}/approvals/${target.approval}.json`);if(!raw){record.detail='Selected native GUI approval is missing.';return record;}
  const a=approval(raw,target.approval,kind);
  if(a.digest!==target.approvalDigest||sha256(JSON.stringify(a.runtime))!==target.runtime||a.runtime.protocol!==await lane.protocol()||a.runtime.profile.protocol!==await protocolHash()){record.applicability='stale';record.detail='Native approval, runtime selection or harness protocol changed. Review journey and product setup.';record.next='harness product setup';return record;}
  const runs:Run[]=[];
  for(const id of await reader.names(lane.folder+'/runs')){if(id.startsWith('.harness-write-'))continue;if(!uuidId(id,lane.run))throw Error('Unexpected native GUI run directory.');const value=await reader.json(`${lane.folder}/runs/${id}/state.json`);
   if(!value||typeof value!=='object'||Array.isArray(value)||!uuidId((value as any).approval,lane.approval))throw Error('Unidentifiable native GUI run.');if((value as any).approval===target.approval)runs.push(run(value,id,kind));
  }
  const current=runs.filter(r=>(r.source===source||r.source===undefined)&&r.approvalDigest===target.approvalDigest&&sha256(JSON.stringify(r.runtime))===target.runtime),matching=current.length?current:runs;
  matching.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.id.localeCompare(b.id));const last=matching.at(-1);if(!last)return record;if(matching.filter(r=>Date.parse(r.at)===Date.parse(last.at)).length>1)throw Error('Ambiguous native run ordering. Re-run the journey.');
  record.producer=last.id;record.at=last.at;record.outcome=last.status==='passed'?'unknown':last.status==='failed'?'failed':'incomplete';if(last.source)record.subject.digest=last.source;
  if(!current.length){record.applicability='stale';record.detail='Native evidence belongs to other source, approval or runtime.';return record;}
  record.applicability='current';if(!last.source){record.outcome='incomplete';record.detail='Latest native attempt has no captured source. Complete or recover it first.';record.next=`harness ${lane.command} list`;return record;}
  if(last.status!=='passed'){record.detail=`Selected native journey is ${last.status}.`;record.next=`harness ${lane.command} list`;return record;}
  const resolved=new Map<string,Awaited<ReturnType<EvidenceReader['artifact']>>>();
  for(const id of last.artifacts){const value=await reader.artifact(id),v=value.artifact;if(v.producer!==last.id||v.input!==source||v.environment!==target.runtime||resolved.has(v.name))throw Error('Native GUI artifact provenance changed or names are ambiguous.');resolved.set(v.name,value);}
  const observations=resolved.get('observations.json'),pkg=resolved.get(lane.package);if(!observations||!pkg||!pkg.bytes.length)throw Error('Native package or GUI observations are missing.');
  record.execution=await nativeLineage(reader,kind,a,last,resolved);
  const assessment=lane.assess(a.journey,JSON.parse(observations.bytes.toString()));for(const name of assessment.screenshots){const screen=resolved.get(name);if(!screen)throw Error('Required native screenshot is missing.');validatePng(screen.bytes);}
  record.artifacts=[...resolved.values()].map(v=>({id:v.artifact.id,name:v.artifact.name,sha256:v.artifact.sha256})).sort((a,b)=>a.id.localeCompare(b.id));record.outcome=assessment.passed?'passed':'failed';record.detail=assessment.passed?`${assessment.checks} GUI observations matched on macOS ${a.runtime.profile.os} ${a.runtime.profile.arch} (${kind}); package, screenshots and completed native execution retained.`:assessment.failures.join('; ');return record;
 }catch(e){record.applicability='invalid';record.outcome='unknown';record.detail=(e as Error).message;record.next=`harness ${lane.command} list`;return record;}
}
