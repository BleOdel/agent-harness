import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {artifactBytes,listArtifacts,putArtifact,releaseArtifacts,sha256} from '../artifacts/store.ts';
import {withWriter} from '../workspace/writer-lock.ts';
import {syncDirectory} from '../workspace/atomic.ts';
import {OperatorError} from '../verbs/io.ts';
import {validateNames,releaseId,readRelease,saveRelease,type Release} from './store.ts';
import {destination,validateDestination,jsonBytes,ownerBytes,receiptBytes,checkedFile,checkOwned,installFile} from './destination.ts';
const fail=(message:string):never=>{throw new OperatorError(message);};
export interface Proposal {artifact:string;name:string;version:string;destination:string;}
export async function prepareRelease(project:string,proposal:Proposal):Promise<Release>{return withWriter(project,'release prepare',async()=>{
 validateNames(proposal.name,proposal.version);const original=(await listArtifacts(project)).find(a=>a.id===proposal.artifact);if(!original)fail('Select a retained artifact with harness release setup.');if(original!.verification==='unverified')fail('An unverified artifact cannot enter this release lane. Run its supported verification first.');
 const bytes=await artifactBytes(project,proposal.artifact),target=await destination(project,proposal.destination,proposal.name,proposal.version),id=releaseId();
 const a=original!,snapshot=await putArtifact(project,a.name,bytes,{producer:id,input:a.input,environment:a.environment,verification:a.verification,...(a.evaluation?{evaluation:a.evaluation}:{})});
 const manifest={schema:1 as const,targetType:'local-directory@1' as const,name:proposal.name,version:proposal.version,...target,filename:`artifact-${a.name.split('/').at(-1)!}`,original:a,snapshot};
 const r:Release={schema:1,id,token:randomUUID(),createdAt:new Date().toISOString(),manifest,digest:sha256(JSON.stringify(manifest)),status:'draft'};
 try{await saveRelease(project,r);}catch(error){await releaseArtifacts(project,id,new Set());throw error;}return r;
});}
async function validatedBytes(project:string,r:Release):Promise<Buffer>{
 if(r.status==='retired')fail('Release is retired; create a new draft to stage again.');
 const a=(await listArtifacts(project)).find(a=>a.id===r.manifest.snapshot.id);
 if(!a||JSON.stringify(a)!==JSON.stringify(r.manifest.snapshot))fail('Retained release provenance changed or is missing.');return artifactBytes(project,a!.id);
}
export async function dryRunRelease(project:string,id:string):Promise<{approved:boolean;target:string;status:string;bytes:number}>{return withWriter(project,'release dry-run',async()=>{
 const r=await readRelease(project,id),bytes=await validatedBytes(project,r),exists=await validateDestination(project,r);
 if(exists){await checkOwned(r);const payload=await checkedFile(r.manifest.target,r.manifest.filename,bytes),manifest=await checkedFile(r.manifest.target,'release.json',jsonBytes(r.manifest));
  const receipt=await checkedFile(r.manifest.target,'receipt.json',receiptBytes(r));if(receipt&&(!payload||!manifest))fail('Completion receipt exists but staged files are missing.');if(r.status==='staged'&&r.receiptHash!==sha256(receiptBytes(r)))fail('Saved receipt identity changed.');if(r.status==='staged'&&!receipt)fail('Staged receipt is missing.');
 }
 if(!exists&&r.status==='staged')fail('Previously staged output is missing. Create a new draft instead of silently recreating it.');
 return {approved:!!r.approval,target:r.manifest.target,status:r.status,bytes:bytes.length};
});}
export async function approveRelease(project:string,id:string,digest:string):Promise<Release>{return withWriter(project,'release approve',async()=>{
 const r=await readRelease(project,id);if(r.digest!==digest)fail('Reviewed digest changed; inspect the current draft before approving.');if(r.status!=='draft'&&r.status!=='approved')fail('Only a saved draft can be approved.');await dryRunRelease(project,id);r.approval={digest,at:new Date().toISOString()};r.status='approved';await saveRelease(project,r);return r;
});}
export async function stageRelease(project:string,id:string,onStep:(step:string)=>Promise<void>=async()=>{}):Promise<Release>{return withWriter(project,'release stage',async()=>{
 const r=await readRelease(project,id);if(r.status==='retired')fail('Release is retired.');if(!r.approval||r.approval.digest!==r.digest)fail('Release approval is required before staging. Review the saved manifest first.');
 const bytes=await validatedBytes(project,r);await dryRunRelease(project,id);if(r.status==='staged')return r;
 r.status='staging';r.deliveryAt??=new Date().toISOString();delete r.reason;await saveRelease(project,r);
 try{
  if(!await validateDestination(project,r)){await mkdir(r.manifest.target,{mode:0o700});await syncDirectory(r.manifest.parent.path);await installFile(r.manifest.target,'owner.json',ownerBytes(r));}
  await checkOwned(r);await installFile(r.manifest.target,'owner.json',ownerBytes(r));await onStep('reserved');
  await validateDestination(project,r);await checkOwned(r);await installFile(r.manifest.target,r.manifest.filename,bytes);await onStep('payload');
  await validateDestination(project,r);await checkOwned(r);await installFile(r.manifest.target,'release.json',jsonBytes(r.manifest));await onStep('manifest');
  // Receipt is the commit marker; every staged byte is checked before it appears.
  await dryRunRelease(project,id);await installFile(r.manifest.target,'receipt.json',receiptBytes(r));await onStep('receipt');
  await dryRunRelease(project,id);r.receiptHash=sha256(receiptBytes(r));r.status='staged';await saveRelease(project,r);await onStep('staged');return r;
 }catch(error){r.reason=(error as Error).message;await saveRelease(project,r);throw error;}
});}
export async function retireRelease(project:string,id:string):Promise<void>{return withWriter(project,'release retire',async()=>{
 const r=await readRelease(project,id);r.status='retired';r.reason='Retired; finishing retained-reference cleanup. Staged files and audit remain.';await saveRelease(project,r);await releaseArtifacts(project,id,new Set());r.retentionReleased=true;r.reason='Retired. Staged files and audit are preserved; retained snapshot references released.';await saveRelease(project,r);
});}
