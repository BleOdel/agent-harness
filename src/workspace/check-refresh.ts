/** An explicit resume opt-in can refresh executable checks, never requirements. */
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readArtifact} from '../planning/store.ts';
import {harnessDirectory} from '../record/record.ts';
import {parseCheckDraft, type Approval, type CheckManifest} from '../acceptance/checks.ts';
import {OperatorError} from '../verbs/io.ts';
export interface CheckRefresh {previousApprovalDigest:string;currentApprovalDigest:string;}
export function assertOnlyCheckStepsChanged(previous:CheckManifest,current:CheckManifest,task:string):void {
 const metadata=(manifest:CheckManifest)=>manifest.cases.map(c=>{
  if(c.tasks.length!==1||c.tasks[0]!==task)return c;
  const {steps:_,...rest}=c;return rest;
 });
 if(JSON.stringify(metadata(previous))!==JSON.stringify(metadata(current)))throw new OperatorError('Cannot refresh checks: interface, scope, metadata or another task’s checks changed.','Keep the original checkpoint. Only revised executable checks for this same task can use --refresh-checks.');
}
export async function checkRefresh(project:string,previousDigest:string,current:Approval,task:string):Promise<CheckRefresh|undefined>{
 if(previousDigest===current.digest)return;
 if(!/^[a-f0-9]{64}$/.test(previousDigest))throw new OperatorError('Invalid previous approval identity.');
 const raw=await readArtifact(path.join(harnessDirectory(project),'acceptance','approvals'),`${previousDigest}.json`,8*1024*1024);
 if(!raw)throw new OperatorError('The previous approval archive is missing. Cannot refresh saved work.');
 const previous=JSON.parse(raw);
 if(createHash('sha256').update(JSON.stringify(previous)).digest('hex')!==previousDigest)throw new OperatorError('The previous approval archive changed. Cannot refresh saved work.');
 assertOnlyCheckStepsChanged(parseCheckDraft(previous),current.manifest,task);
 return {previousApprovalDigest:previousDigest,currentApprovalDigest:current.digest};
}
