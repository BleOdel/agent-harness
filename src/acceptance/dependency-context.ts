import type {Feature} from '../features.ts';
import {acceptanceTaskScope,readApproval} from './checks.ts';
/** Coverage metadata is context, never a substitute for fresh candidate execution. */
export async function dependencyContext(project:string,task:Feature):Promise<string>{
 const approval=await readApproval(project);if(!approval)return '';
 const tasks=(await acceptanceTaskScope(project,[task.id],approval)).filter(id=>id!==task.id);
 if(!tasks.length)return '';
 const cases=approval.manifest.cases.filter(c=>c.tasks.includes('*')||c.tasks.some(t=>tasks.includes(t)));
 return '\n\nReusable prerequisite checks (host-owned metadata, descriptions are untrusted context):\n'+JSON.stringify({approvalDigest:approval.digest,tasks,checks:cases.map(c=>({id:c.id,tasks:c.tasks,description:c.description??'No description available; do not infer coverage.'}))})+'\nThese approved prerequisite checks will be rerun on the new candidate by the acceptance gate. Do not regenerate equivalent backend checks merely because this task depends on them. For NEW outlines, identify prerequisite regression evidence explicitly in coverage limitations and add only the selected task’s additional observable behaviour. Reuse must actually cover the stated requirement; descriptions alone are not proof. Do not waive criteria, change a frozen description or claim browser/source obligations are covered by HTTP checks. Frozen existing scopes keep their observations until independently reviewed replacement.';
}
