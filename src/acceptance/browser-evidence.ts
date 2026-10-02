import {realpath} from 'node:fs/promises';
/** Re-assess retained Chromium observations before trusting acceptance or product reports. */
import {createHash} from 'node:crypto';import {EvidenceReader} from '../product/evidence/reader.ts';import {assessJourney} from '../browser/schema.ts';import type {Runtime} from '../browser/runtime.ts';import type {AcceptanceCase} from './checks.ts';import {OperatorError} from '../verbs/io.ts';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export async function assertBrowserEvidence(project:string,check:AcceptanceCase,runtime:Runtime|undefined,source:string,observations:unknown):Promise<void>{
 const fail=()=>{throw new OperatorError('Browser acceptance evidence is missing, changed or belongs to another candidate.');};
 const matches=Array.isArray(observations)?observations.filter(o=>o?.case===check.id):[];
 if(!runtime||!check.browser||matches.length!==1)fail();const o=matches[0];if(!o||o.status!=='passed'||o.source!==source||typeof o.run!=='string'||!/^browser-[a-f0-9-]{36}$/u.test(o.run))fail();
 const reader=new EvidenceReader((await realpath(project))+'-harness'),run=await reader.json(`browser/runs/${o.run}/state.json`) as any;
 if(!run||run.id!==o.run||run.status!=='passed'||run.source!==source||!Array.isArray(run.containers)||run.containers.length||JSON.stringify(run.runtime)!==JSON.stringify(runtime)||!/^web-journey-[a-f0-9-]{36}$/u.test(run.approval)||typeof run.report!=='string')fail();
 const approval=await reader.json(`browser/approvals/${run.approval}.json`) as any;if(!approval)fail();const {digest,...body}=approval;
 if(digest!==hash(body)||digest!==run.approvalDigest||JSON.stringify(approval.journey)!==JSON.stringify(check.browser)||JSON.stringify(approval.runtime)!==JSON.stringify(runtime))fail();
 const identity=hash({source,approval:digest,runtime:run.runtime});const {artifact,bytes}=await reader.artifact(run.report);
 if(run.identity!==identity||artifact.producer!==run.id||artifact.input!==source||artifact.environment!==identity||!assessJourney(check.browser!,JSON.parse(bytes.toString())).passed)fail();
 await reader.assertUnchanged();
}
