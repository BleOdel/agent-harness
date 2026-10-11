/** Check selected product routes without executing application code or treating old results as proof. */
import {sha256} from '../artifacts/store.ts';
import {uuidId,type EvidenceTarget} from '../product/evidence/schema.ts';
import {EvidenceReader} from '../product/evidence/reader.ts';
import type {EvidenceGap,RouteInput} from './feasibility.ts';
interface Inspections {
 choices:(project:string)=>Promise<EvidenceTarget[]>;
 runtime:(target:EvidenceTarget,project:string)=>Promise<string>;
}
const installed:Inspections={
 choices:async project=>(await (await import('../product/evidence/desktop.ts')).desktopChoices(project)).map(c=>c.target),
 runtime:async(target,project)=>{
  if(target.provider==='linux-electron')return sha256(JSON.stringify(await (await import('../desktop/runtime.ts')).inspectDesktop(undefined,await selectedDesktopImage(project,target))));
  if(target.provider==='macos-electron')return sha256(JSON.stringify(await (await import('../native/gui/provision.ts')).readGuiRuntime()));
  if(target.provider==='macos-native')return sha256(JSON.stringify(await (await import('../native/apple/runtime.ts')).readAppleRuntime()));
  throw Error('No ordinary application evidence runtime for '+target.provider);
 },
};
export async function inspectProductTargets(project:string,input:RouteInput,inspect:Inspections=installed):Promise<EvidenceGap[]>{
 const product=input.product;if(!product||product.kind!=='desktop')return [];
 const gaps:EvidenceGap[]=[];
 let choices:EvidenceTarget[];
 try{choices=await inspect.choices(project);}catch{ return [{kind:'unqualified-runtime',stage:'product/approvals',detail:'Selected desktop approvals could not be validated. Inspect product setup; retained approvals were not changed.'}]; }
 for(const target of product.targets){
  const stage='product/'+target.provider;
  const selected=choices.find(c=>c.provider===target.provider&&c.approval===target.approval);
  if(!selected||selected.approvalDigest!==target.approvalDigest||selected.runtime!==target.runtime){gaps.push({kind:'unqualified-runtime',stage,detail:'The selected approval or its runtime binding is missing or changed. Review product setup.'});continue;}
  try{if(await inspect.runtime(target,project)!==target.runtime)gaps.push({kind:'unqualified-runtime',stage,detail:'Installed runtime differs from the selected product approval. Revalidate the runtime and review product setup.'});}
  catch(error){const message=(error as Error).message;gaps.push({kind:(error as NodeJS.ErrnoException).code==='ENOENT'||/unavailable|not provisioned|installed Docker/i.test(message)?'missing-installation':'unqualified-runtime',stage,detail:message});}
 }
 return gaps;
}

/** Recheck the selected approval before using its image; a global default can legitimately differ. */
export async function selectedDesktopImage(project:string,target:EvidenceTarget):Promise<string>{
 if(target.provider!=='linux-electron'||!uuidId(target.approval,'journey'))throw Error('Invalid desktop selection.');
 const reader=new EvidenceReader(project+'-harness'),raw=await reader.json('desktop/approvals/'+target.approval+'.json');
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Selected desktop approval is missing or changed.');
 const {digest,...body}=raw as {digest?:unknown;runtime?:{image?:unknown}};
 if(digest!==target.approvalDigest||sha256(JSON.stringify(body))!==digest||sha256(JSON.stringify(body.runtime))!==target.runtime||typeof body.runtime?.image!=='string'||!/^sha256:[a-f0-9]{64}$/.test(body.runtime.image))throw Error('Selected desktop approval or image changed.');
 await reader.assertUnchanged();return body.runtime.image;
}
