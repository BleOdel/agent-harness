/** One read-only proposal can repair bookkeeping, never application source or evidence. */
import {CheckResponse} from '../acceptance/response.ts';
import {assertModelEffort} from '../model-settings.ts';
import {buildReviewCommand,type ReviewRequest} from '../review/reviewer.ts';
import {buildRunArguments,type SandboxLayout} from '../containment/sandbox.ts';
import {runContained} from '../containment/process.ts';
import {assertSnapshot,type Candidate} from '../workspace/candidate.ts';
import {checkClaim,checkCriteriaEvidence,parseClaim,type Claim,type ClaimResult} from '../gates/claim.ts';
import type {AgentUsage} from './events.ts';

export async function repairClaim(layout:SandboxLayout,request:ReviewRequest&{
 candidate:Candidate;existing:ClaimResult;failure:string;onUsage:(usage:AgentUsage)=>void;
}):Promise<Claim>{
 await assertModelEffort(layout.piPackageDirectory,request);
 await assertSnapshot(request.candidate);
 const prompt=[
  'Correct only the completion claim. Source is read-only. Do not propose or make source edits.',
  'Return only JSON: {"files":["changed or added paths"],"deletions":["deleted paths"],"criteria":[{"criterion":"exact requested criterion","verifiedBy":"existing relative source or test path"}]}.',
  'Account for the ENTIRE diff against the original project, including earlier attempts. Do not list only the latest repair.',
  'Use the observed change list below for files and deletions. For every requested criterion, inspect the source and cite a real evidence file. Do not invent evidence or treat a claim as proof that the behaviour passed.',
  'If you cannot truthfully produce a complete claim, return {"blocked":"reason"}; the implementation will be retained for repair.',
  JSON.stringify({title:request.title,criteria:request.criteria,approvedContext:request.approvedContext,changes:request.candidate.changes,previousClaim:request.existing,failure:request.failure}),
 ].join('\n\n');
 if(Buffer.byteLength(prompt)>512*1024)throw Error('Claim correction context exceeds its 512 KiB limit.');
 const command=buildReviewCommand(request);command.pop();command.push('--mode','json',prompt);
 const isolated:SandboxLayout={...layout,purpose:'review',workDirectory:request.candidate.directory};
 const response=new CheckResponse();let result;
 try {result=await runContained(isolated,buildRunArguments(isolated,'bridge',command),{
  timeoutMs:Math.min(request.timeoutMs,180000),maxOutputBytes:512*1024,onOutput:chunk=>response.push(chunk),
 });}finally{response.finish();request.onUsage(response.usage);}
 await assertSnapshot(request.candidate);
 if(result.timedOut)throw Error('Claim-only correction timed out.');
 if(result.code!==0||result.outputLimited||!response.complete)throw Error(response.failure??'Claim-only correction did not return a complete response.');
 const parsed=parseClaim(response.text.trim().replace(/^```(?:json)?\s*/u,'').replace(/\s*```$/u,''));
 if(!parsed.ok)throw Error(parsed.reason);
 const claimed=parsed.claim.criteria.map(c=>c.criterion);
 if(request.criteria.length&&(claimed.length!==request.criteria.length||new Set(claimed).size!==claimed.length||request.criteria.some(c=>!claimed.includes(c))))throw Error('Corrected claim does not account for every requested criterion exactly once.');
 for(const verdict of [checkClaim(parsed.claim,request.candidate.changes),checkCriteriaEvidence(parsed.claim,new Set(Object.keys(request.candidate.files)))])if(!verdict.passed)throw Error(verdict.detail||verdict.summary);
 return parsed.claim;
}
