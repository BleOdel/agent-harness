/** Delivery adapters reuse the policy; manual observations and final consent are separate facts. */
import path from 'node:path';
import {EvidenceReader} from '../product/evidence/reader.ts';
import {harnessDirectory,type RunRecord} from '../record/record.ts';
import {acceptanceAdmission,type AcceptanceProof} from '../acceptance/checks.ts';
import type {Snapshot} from '../workspace/candidate.ts';
import {addEvidence,assessAcceptance,type AcceptanceEnvelope} from './acceptance.ts';
import {evidenceHash,type DeliveryMode,type Admission} from './admission.ts';
import {OperatorError} from '../verbs/io.ts';
export interface HumanEvidence {
 expectedBinding:string;
 recorded?:{binding:string;at:string;environment:string;observations:{id:string;passed:boolean;notes:string}[];approved:boolean};
}
export async function sourceReviewEvidence(project:string,bundle:AcceptanceEnvelope,review:RunRecord['review']):Promise<void>{
 if(!review||review.verdict!=='pass'||!Array.isArray(review.findings)||review.findings.length||!review.evidencePath)throw new OperatorError('Passing source review evidence is missing. Re-review the retained candidate.');
 const root=harnessDirectory(project),relative=path.relative(root,review.evidencePath);
 if(!/^candidates\/r[1-9][0-9]*\/review-attempt-[1-9][0-9]*\.json$/u.test(relative))throw new OperatorError('Invalid source review evidence location.');
 const reader=new EvidenceReader(root),bytes=await reader.bytes(relative);
 if(!bytes)throw new OperatorError('Source review evidence is missing.');
 if(review.evidenceDigest!==undefined&&evidenceHash(bytes)!==review.evidenceDigest)throw new OperatorError('Source review evidence artifact changed.');
 const e=JSON.parse(bytes.toString());
 // Existing review files retain the gate packet; the host run/stage owns the independent verdict.
 if(e.acceptanceApprovalDigest!==bundle.binding.contract)throw new OperatorError('Source review evidence has no current approved-contract binding. Re-review the retained candidate.');
 if(e.version!==1||e.sourceDigest!==bundle.binding.candidate||!Array.isArray(e.gates)||!e.gates.length||e.gates.some((g:any)=>g?.passed!==true)||e.acceptance!=='not-run')throw new OperatorError('Source review evidence does not match the passed candidate.');
 if(bundle.executionDigest!==null&&e.executionDigest!==bundle.executionDigest)throw new OperatorError('Source review evidence runtime changed.');
 if(bundle.executionDigest===null&&e.runtime?.image!==bundle.runtimeImage)throw new OperatorError('Source review evidence lacks the acceptance runtime identity.');
 const original=Buffer.from(JSON.stringify({packet:evidenceHash(bytes),review}));
 const obligations=bundle.requirements.map(r=>r.id);
 for(const requirement of bundle.requirements)requirement.kinds.push('source-review');
 addEvidence(bundle,relative,{bytes,fact:{kind:'source-review',binding:bundle.binding,obligations,verdict:'passed',limitations:['Source review is a model assessment of the retained gate packet and candidate; it is separate from application observations.']}});
 addEvidence(bundle,relative+'#host-verdict',{bytes:original,fact:{kind:'source-review',binding:bundle.binding,obligations,verdict:'passed',limitations:[]}});
 await reader.assertUnchanged();
}
export function humanEvidence(bundle:AcceptanceEnvelope,human:HumanEvidence):void{
 for(const requirement of bundle.requirements)requirement.kinds.push('authorization');
 const r=human.recorded;
 if(!r)return;
 const valid=r.binding===human.expectedBinding&&typeof r.environment==='string'&&!!r.environment.trim()&&r.environment.length<=4000&&typeof r.at==='string'&&Number.isFinite(Date.parse(r.at))&&Array.isArray(r.observations);
 const manual=bundle.requirements.filter(r=>r.kinds.includes('manual')).map(r=>r.id);
 if(!valid||r.observations.length!==manual.length||r.observations.some(o=>!manual.includes(o.id)||typeof o.passed!=='boolean'||typeof o.notes!=='string'||!o.notes.trim()||o.notes.length>8000)||manual.some(id=>r.observations.filter(o=>o.id===id).length!==1))throw new OperatorError('Final review has missing, changed or invalid manual observations.');
 const bytes=Buffer.from(JSON.stringify(r));
 if(manual.length)addEvidence(bundle,'operator-review#observations',{bytes,fact:{kind:'manual',binding:bundle.binding,obligations:manual,verdict:r.observations.every(o=>o.passed)?'passed':'failed',limitations:['Human observations are candidate-bound operator attestations.']}});
 addEvidence(bundle,'operator-review#authorization',{bytes,fact:{kind:'authorization',binding:bundle.binding,obligations:bundle.requirements.map(r=>r.id),verdict:r.approved===true?'passed':'incomplete',limitations:['Final authorization does not waive any requirement or evidence limitation.']}});
}
export async function deliveryAdmission(project:string,candidate:Snapshot,tasks:readonly string[],proof:AcceptanceProof|undefined,options:{route:DeliveryMode;review:RunRecord['review'];human?:HumanEvidence;legacyRecovery?:boolean}):Promise<Admission>{
 const bundle=await acceptanceAdmission(project,candidate,tasks,proof,options.route,options.legacyRecovery??false);
 await sourceReviewEvidence(project,bundle,options.review);
 if(options.human)humanEvidence(bundle,options.human);
 return assessAcceptance(bundle);
}
export async function assertDeliveryAdmission(...args:Parameters<typeof deliveryAdmission>):Promise<Admission>{
 const result=await deliveryAdmission(...args),options=args[4];
 const allowed=options.human?['authorized']:options.route==='staged'?['verified','automated-passed']:['verified'];
 if(!allowed.includes(result.status))throw new OperatorError('Delivery evidence or final review is incomplete: '+[...result.missing,...result.failures].join('; '));
 return result;
}
