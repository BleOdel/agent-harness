/** Legacy acceptance receipts are adapted by observation, never by their summary status alone. */
import type {AcceptanceCase, Approval} from '../acceptance/checks.ts';
import {caseKind} from '../acceptance/evidence-kind.ts';
import {assertRecipeEvidence} from '../acceptance/recipes/catalog.ts';
import {assertOutputExpectations} from '../acceptance/checks.ts';
import {evaluateAdmission,evidenceHash,reference,type EvidenceBinding,type EvidenceFact,type EvidenceRequirement,type EvidenceEnvelope,type DeliveryMode,type Admission} from './admission.ts';
export interface ResolvedEvidence {bytes:Buffer;fact:EvidenceFact;}
export interface AcceptanceEnvelope {
 executionDigest:string|null; runtimeImage:string; envelope:EvidenceEnvelope; binding:EvidenceBinding; requirements:EvidenceRequirement[];
 records:Map<string,ResolvedEvidence>;
}
/** Full new output is bounded by the runner. Legacy previews suffice only when they contain the exact hashed output. */
export function assertCommandObservations(check:AcceptanceCase,observations:unknown):void{
 if(!Array.isArray(observations))throw Error('Acceptance evidence has incomplete command observations.');
 const found=observations.filter(o=>o?.case===check.id);
 if(found.length!==check.steps.length)throw Error('Acceptance evidence has incomplete or duplicate command observations.');
 for(const [index,step] of check.steps.entries()){
  const matches=found.filter(o=>o?.step===index+1),o=matches[0];
  if(matches.length!==1||o.timedOut!==false||o.outputLimited===true||o.exitCode!==step.exitCode)throw Error('Acceptance evidence has failed command observations.');
  const stdout=typeof o.stdout==='string'?o.stdout:o.stdoutPreview;
  if(typeof stdout!=='string'||evidenceHash(stdout)!==o.stdoutHash)throw Error('Acceptance evidence lacks complete retained command output; run verification again.');
  try{
   if(step.recipe)assertRecipeEvidence(step.recipe,stdout);
   assertOutputExpectations(step,stdout,'Retained command evidence');
  }catch{throw Error('Acceptance evidence does not match approved output observations.');}
  for(const f of step.files??[]){
   const actual=o.files?.[f.path];
   if(typeof actual!=='string'||(f.text!==undefined&&actual!==evidenceHash(f.text))||(f.sha256!==undefined&&actual!==f.sha256))throw Error('Acceptance evidence does not match approved file observations.');
  }
 }
}
/** Old receipts need an actual immutable environment identity; missing fields are not guessed. */
export function acceptanceRuntime(receipt:any,execution:string|null):string{
 if(execution!==null)return execution;
 if(typeof receipt.image!=='string'||!/^sha256:[a-f0-9]{64}$/u.test(receipt.image)||!['node-npm','python-pip'].includes(receipt.adapter?.id)||receipt.adapter.version!==1||receipt.runner?.id!=='docker'||receipt.runner.version!==1||typeof receipt.environmentKey!=='string'||!/^[a-f0-9]{64}$/u.test(receipt.environmentKey))throw Error('Acceptance runtime evidence is incomplete. Re-verify the retained candidate.');
 return evidenceHash(JSON.stringify({image:receipt.image,adapter:receipt.adapter,runner:receipt.runner,environmentKey:receipt.environmentKey}));
}
export function acceptanceEnvelope(route:DeliveryMode,approval:Approval,candidate:string,execution:string|null,selected:AcceptanceCase[],artifacts:{approval:Buffer;result:Buffer;resultId:string}):AcceptanceEnvelope{
 const receipt=JSON.parse(artifacts.result.toString());
 const runtime=acceptanceRuntime(receipt,execution);
 const retained=receipt.limitations;
 if(retained!==undefined&&(!Array.isArray(retained)||retained.some(l=>typeof l!=='string'||!l.trim()||l.length>8000)))throw Error('Invalid retained evidence limitations.');
 const limitations=[
  ...(retained??[]),
  'Automated observations cover only approved checks and their declared evidence limits.',
  'Manual observations are operator attestations, not automated proof.',
 ];
 // Contract bytes include scope, manual instructions and all declared case limits.
 const binding:EvidenceBinding={candidate,contract:approval.digest,runtime:evidenceHash(JSON.stringify({runtime,browser:approval.browserRuntime??null})),limitations:evidenceHash(JSON.stringify({retained:retained??[],cases:selected.map(c=>({id:c.id,contract:c.contract??null,manual:c.manual??null}))}))};
 const records=new Map<string,ResolvedEvidence>();
 const requirements:EvidenceRequirement[]=selected.map(c=>({id:c.id,kinds:['design',caseKind(c)==='manual'?'manual':'automatic']}));
 const add=(id:string,bytes:Buffer,kind:EvidenceFact['kind'],obligations:string[])=>{records.set(id,{bytes,fact:{kind,binding,obligations,verdict:'passed',limitations}});};
 add('acceptance/approved.json',artifacts.approval,'design',selected.map(c=>c.id));
 add(artifacts.resultId,artifacts.result,'automatic',selected.filter(c=>caseKind(c)!=='manual').map(c=>c.id));
 return {executionDigest:execution,runtimeImage:receipt.execution?.capabilities?.image??receipt.image,binding,requirements,records,envelope:{version:1,route,binding,references:[...records].map(([id,r])=>reference(id,r.bytes))}};
}
/** Source, human and authorization adapters append separately validated references. */
export function addEvidence(bundle:AcceptanceEnvelope,id:string,value:ResolvedEvidence):void{
 if(bundle.records.has(id))throw Error('Duplicate admission evidence reference.');
 bundle.records.set(id,value);bundle.envelope.references.push(reference(id,value.bytes));
}
export const assessAcceptance=(bundle:AcceptanceEnvelope):Promise<Admission>=>evaluateAdmission(bundle.envelope,bundle.binding,bundle.requirements,async ref=>bundle.records.get(ref.id));
