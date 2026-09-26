/** Operator attestations live outside worker mounts. They never constitute an automatic pass. */
import {mkdir,realpath,lstat} from 'node:fs/promises';
import path from 'node:path';
import {digest,readArtifact,atomicWrite} from '../planning/store.ts';
import {harnessDirectory} from '../record/record.ts';
import {assertSnapshot} from '../workspace/candidate.ts';
import type {WorkCheckpoint} from '../workspace/work-checkpoints.ts';
import {OperatorError} from '../verbs/io.ts';

export interface BrowserBinding {
 goal:string;sourceDigest:string;baselineDigest:string;workDigest:string;approvalDigest:string;executionDigest:string;
}
export interface BrowserObservations {environment:string;observations:string;limitations:string;}
export interface BrowserEvidence extends BrowserObservations {
 version:1;kind:'operator-reported-browser-observations';project:string;runId:string;recordedAt:string;
 inspectedDirectory:string;binding:BrowserBinding;bindingDigest:string;digest:string;
}
export const browserBinding=(c:WorkCheckpoint):BrowserBinding=>({goal:c.goal,sourceDigest:c.partial.digest,baselineDigest:c.baseline.digest,workDigest:c.workDigest,approvalDigest:c.approvalDigest,executionDigest:c.executionDigest});
function bindingKey(b:BrowserBinding):string {
 if(typeof b.goal!=='string'||!b.goal||!['sourceDigest','baselineDigest','workDigest','approvalDigest','executionDigest'].every(k=>/^[a-f0-9]{64}$/.test(b[k as keyof BrowserBinding])))throw new OperatorError('Invalid browser evidence binding.');
 return digest(JSON.stringify([b.goal,b.sourceDigest,b.baselineDigest,b.workDigest,b.approvalDigest,b.executionDigest]));
}
function validateObservations(o:BrowserObservations):void {
 for(const key of ['environment','observations','limitations'] as const)if(typeof o[key]!=='string'||!o[key].trim()||o[key].length>(key==='observations'?12000:4000))throw new OperatorError(`Browser evidence ${key} must be nonempty, bounded text.`);
}
export async function assertInspectedSource(c:WorkCheckpoint,directory:string):Promise<string> {
 const canonical=await realpath(directory);
 if(!(await lstat(canonical)).isDirectory())throw new OperatorError('Inspected source must be a directory.');
 await assertSnapshot({...c.partial,directory:path.join(c.directory,'source')});
 await assertSnapshot({...c.partial,directory:canonical});
 return canonical;
}
export async function saveBrowserEvidence(c:WorkCheckpoint,inspectedDirectory:string,observations:BrowserObservations):Promise<BrowserEvidence> {
 validateObservations(observations);
 const inspected=await assertInspectedSource(c,inspectedDirectory),binding=browserBinding(c),bindingDigest=bindingKey(binding);
 const body={version:1 as const,kind:'operator-reported-browser-observations' as const,project:c.project,runId:c.runId,recordedAt:new Date().toISOString(),inspectedDirectory:inspected,binding,bindingDigest,
  environment:observations.environment,observations:observations.observations,limitations:observations.limitations};
 const receipt={...body,digest:digest(JSON.stringify(body))};
 const root=path.join(harnessDirectory(c.project),'browser-evidence');await mkdir(path.join(root,'archive'),{recursive:true,mode:0o700});
 const text=JSON.stringify(receipt,null,2)+'\n';
 if(Buffer.byteLength(text)>32000)throw new OperatorError('Browser evidence exceeds the 32,000-byte receipt limit. Shorten observations or limitations.');
 await atomicWrite(path.join(root,'archive',receipt.digest+'.json'),text);
 await atomicWrite(path.join(root,bindingDigest+'.json'),text);
 return receipt;
}
export async function loadBrowserEvidence(project:string,binding:BrowserBinding):Promise<BrowserEvidence|undefined> {
 project=await realpath(project);const key=bindingKey(binding);
 const raw=await readArtifact(path.join(harnessDirectory(project),'browser-evidence'),key+'.json',32000);
 if(!raw)return;
 let receipt:BrowserEvidence;
 try{receipt=JSON.parse(raw) as BrowserEvidence;}catch{throw new OperatorError('Browser evidence integrity check failed.');}
 if(!receipt||typeof receipt!=='object'||Array.isArray(receipt))throw new OperatorError('Browser evidence integrity check failed.');
 const {digest:recorded,...body}=receipt;
 if(recorded!==digest(JSON.stringify(body))||receipt.version!==1||receipt.kind!=='operator-reported-browser-observations'||receipt.project!==project||receipt.bindingDigest!==key||bindingKey(receipt.binding)!==key)throw new OperatorError('Browser evidence integrity check failed.');
 validateObservations(receipt);
 return receipt;
}
