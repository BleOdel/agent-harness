import {listStages,assertStageCurrent,assertStageReview} from '../staging/store.ts';
import {caseKind} from '../acceptance/evidence-kind.ts';
import {browserChecks} from './evidence/browser.ts';
import {performanceReport,type PerformanceReport} from '../performance/report.ts';
import {securityReport,type SecurityReport} from '../security/report.ts';
/** Evidence summary, never an approval shortcut or a substitute for execution. */
import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {readJson,saveJson,sha256} from '../artifacts/store.ts';
import {readFeatures} from '../features.ts';
import {readProfile,projectTestCommand} from '../project/profile.ts';
import {loadConfig,setting} from '../config.ts';
import {getAdapter} from '../adapters/registry.ts';
import {sourceFiles} from '../workspace/candidate.ts';
import {harnessDirectory} from '../record/record.ts';
import {canonicalProject} from '../workspace/writer-lock.ts';
import {requireStagingChecks,assertAcceptanceProof} from '../acceptance/checks.ts';
import {readProduct,assertProductCurrent,productRoot,verificationPlan} from './spec.ts';
import {collectEvidence} from './evidence/desktop.ts';
import {evidenceStatus,type EvidenceRecord} from './evidence/schema.ts';
export type Status='passed'|'failed'|'missing'|'stale'|'human'|'skipped'|'unavailable'|'accepted-risk';
export interface ReportCheck {id:string;status:Status;detail:string;next?:string;required?:boolean;evidence?:EvidenceRecord;}
export interface ProductReport {version:1;project:string;ready:boolean;checks:ReportCheck[];spec?:string;source?:string;evidenceDigest?:string;kind?:string;plan?:string[];security?:SecurityReport;performance?:PerformanceReport;}
export interface Diagnostic {name:string;status:'passed'|'failed'|'skipped';summary:string;}
export interface VerificationRuntime {image:string;testCommand:readonly string[];}
interface Diagnostics {runtime?:VerificationRuntime;version:1;source:string;spec:string|null;profile:string;at:string;checks:Diagnostic[];}
interface Assessment {evidenceDigest?:string;version:1;source:string;spec:string;passed:boolean;notes:string;at:string;}
const absent=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT';
async function optional(project:string,file:string):Promise<unknown>{try{return await readJson(harnessDirectory(project),file);}catch(e){if(absent(e))return undefined;throw e;}}
async function identity(project:string){
 const profile=await readProfile(project),exclusions=getAdapter(profile.adapter).source.generatedDirectories;
 const files=await sourceFiles(project,'',exclusions);
 return {source:sha256(JSON.stringify(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)))),profile:sha256(JSON.stringify(profile)),exclusions};
}
export async function recordDiagnostics(project:string,source:string,checks:Diagnostic[],runtime?:VerificationRuntime):Promise<void>{
 if(!checks.some(c=>c.status==='failed')&&!checks.some(c=>c.name==='tests'&&c.status==='passed'))throw Error('A diagnostic record needs an executed test check.');
 const spec=await assertProductCurrent(project),profile=await readProfile(project);
 await saveJson(await productRoot(project),'diagnostics.json',{...(runtime?{runtime}:{}),version:1,source,spec:spec?.digest??null,profile:sha256(JSON.stringify(profile)),at:new Date().toISOString(),checks} satisfies Diagnostics);
}
export async function recordAssessment(project:string,expectedSource:string,expectedSpec:string,passed:boolean,notes:string,expectedEvidence?:string):Promise<void>{
 const spec=await assertProductCurrent(project),id=await identity(project);
 if(!spec||spec.digest!==expectedSpec||id.source!==expectedSource)throw Error('Product changed during assessment. Review it again.');
 const evidence=spec.evidence?await collectEvidence(project,id.source,spec.evidence):undefined;
 if(evidence&&evidence.digest!==expectedEvidence)throw Error('Evidence changed during assessment. Review the report again.');
 await evidence?.assertUnchanged();
 if((await identity(project)).source!==id.source||(await assertProductCurrent(project))?.digest!==spec.digest)throw Error('Product changed during assessment. Review it again.');
 if(notes.trim().length<20||notes.length>12000)throw Error('Describe the evidence and remaining limits in 20–12000 characters.');
 await saveJson(await productRoot(project),'assessment.json',{...(evidence?{evidenceDigest:evidence.digest}:{}),version:1,source:id.source,spec:spec.digest,passed,notes:notes.trim(),at:new Date().toISOString()} satisfies Assessment);
}
export async function productReport(project:string):Promise<ProductReport>{
 project=await canonicalProject(project);
 const checks:ReportCheck[]=[];let spec;
 try{spec=await readProduct(project);if(spec)await assertProductCurrent(project);}catch(e){checks.push({id:'specification',status:'stale',detail:(e as Error).message,next:'harness product setup'});}
 if(!spec||checks.length)return {version:1,project,ready:false,checks:checks.length?checks:[{id:'specification',status:'missing' as Status,detail:'No product specification approved.',next:'harness product setup'}]};
 const current=await identity(project);
 const retained=spec.evidence?await collectEvidence(project,current.source,spec.evidence):undefined;
 checks.push({id:'specification',status:'passed',detail:`Approved ${spec.kind} / ${spec.consequence}; requirements and protected documents match.`});
 const features=await readFeatures(project);if(!features?.ok)throw Error('Cannot read accepted work items.');
 const tasks=features.features.filter(t=>t.priority!=='wont');
 const unfinished=tasks.filter(t=>t.status!=='done');
 checks.push({id:'implementation',status:unfinished.length?'missing':'passed',detail:unfinished.length?`Unfinished: ${unfinished.map(t=>t.id).join(', ')}`:'All accepted items marked done. This is status, not proof.',...(unfinished.length?{next:'harness work'}:{})});
 try{
  const d=await optional(project,'product/diagnostics.json') as Diagnostics|undefined;
  if(!d)checks.push({id:'diagnostics',status:'missing',detail:'No retained product diagnostics.',next:'harness product verify'});
  else if(d.version!==1||!Array.isArray(d.checks)||(!d.checks.some(c=>c.status==='failed')&&!d.checks.some(c=>c.name==='tests'&&c.status==='passed'))||d.checks.some(c=>!['passed','failed','skipped'].includes(c.status)))throw Error('Invalid diagnostics record.');
  else {
   const runtimeChanged=d.runtime&&(d.runtime.image!==loadConfig({...process.env,HARNESS_PROJECT:project}).imageId||JSON.stringify(d.runtime.testCommand)!==JSON.stringify(await projectTestCommand(project,setting(process.env,'HARNESS_TEST_COMMAND'))));
   checks.push({id:'diagnostics',status:runtimeChanged||d.source!==current.source||d.spec!==spec.digest||d.profile!==current.profile?'stale':d.checks.some(c=>c.status==='failed')?'failed':'passed',detail:d.checks.map(c=>`${c.name}: ${c.status} (${c.summary})`).join('; '),next:'harness product verify'});
  }
 }catch(e){checks.push({id:'diagnostics',status:'failed',detail:(e as Error).message,next:'harness product verify'});}
 try{
  const approval=await requireStagingChecks(project,tasks.map(t=>t.id));
  const root=path.join(harnessDirectory(project),'acceptance/results');
  const files=await readdir(root).catch(e=>{if(absent(e))return [];throw e;});
  const results=[];
  for(const file of files.filter(f=>/^[a-f0-9-]+\.json$/u.test(f))){const e=await readJson(root,file) as any;if(e?.version!==1||e.project!==project||!Array.isArray(e.tasks)||!Number.isFinite(Date.parse(e.at)))throw Error('Invalid acceptance evidence.');results.push({...e,file});}
  for(const task of tasks){
   const relevant=results.filter(e=>e.tasks.includes(task.id));
   const exact=relevant.filter(e=>e.candidateDigest===current.source&&e.approvalDigest===approval.digest).sort((a,b)=>a.at.localeCompare(b.at));
   const last=exact.at(-1);
   let status:Status=last?'failed':relevant.length?'stale':'missing';
   if(last?.outcome==='passed'){
    const required=approval.manifest.cases.filter(c=>c.tasks.includes('*')||c.tasks.includes(task.id));
    if(!required.every(c=>caseKind(c)==='browser'?last.browserObservations?.some((o:any)=>o.case===c.id&&o.source===current.source&&o.status==='passed'):caseKind(c)==='manual'?false:c.steps.every((step,i)=>last.observations?.some((o:any)=>o.case===c.id&&o.step===i+1&&o.exitCode===step.exitCode&&!o.timedOut))))throw Error(`Acceptance observations incomplete for ${task.id}.`);
    await assertAcceptanceProof(project,{directory:project,digest:current.source,files:{},exclusions:current.exclusions},[task.id],{approvalDigest:approval.digest,candidateDigest:current.source,evidencePath:path.join(root,last.file)});status='passed';
   }
   if(last?.outcome==='automated-passed'){
    const stage=(await listStages(project)).find(s=>s.status==='applied'&&s.tasks.includes(task.id)&&s.candidate.digest===current.source&&s.acceptance.approvalDigest===approval.digest);
    if(stage){await assertStageCurrent(project,stage,true);await assertStageReview(stage);status='passed';}
   }
   checks.push({id:`acceptance:${task.id}`,status,detail:last?`${last.outcome}${last.outcome==='automated-passed'&&status==='passed'?' plus candidate-bound operator review':''}: ${last.file}`:'Needs evidence for the current source and approved checks.',next:'harness product verify'});
  }
 }catch(e){checks.push({id:'acceptance',status:'missing',detail:(e as Error).message,next:'harness checks setup'});}
 let browser:Awaited<ReturnType<typeof browserChecks>>|undefined;
 if(spec.kind==='web'){try{browser=await browserChecks(project,current.source);checks.push(...browser.checks);}catch{checks.push({id:'browser',status:'failed',detail:'Browser evidence is unavailable, changed or inconsistent. Inspect retained journeys.',next:'harness browser list'});}}
 if(retained)for(const e of retained.records)checks.push({id:e.id,status:evidenceStatus(e),required:true,detail:e.detail,next:e.next,evidence:e});
 if((spec.kind==='desktop'||spec.kind==='ml')&&!spec.evidence?.targets.length)checks.push({id:'runtime',status:'human',detail:spec.kind==='desktop'?'Review the packaged GUI run on the intended OS and identify its exact artifact. Select required Linux or macOS journeys with product setup; each target needs its own retained GUI evidence.':'Review the selected dataset, recipe, held-out evaluation, model artifact and checkpoint recovery. Select ML workflows with product setup. Quality, checkpoint, recovery and application integration are separate evidence requirements.',next:spec.kind==='desktop'?'harness guide':'harness torch list'});
 let assessment:Assessment|undefined;
 try{assessment=await optional(project,'product/assessment.json') as Assessment|undefined;if(assessment&&(assessment.version!==1||typeof assessment.passed!=='boolean'||typeof assessment.notes!=='string'||assessment.notes.trim().length<20))throw Error('Invalid human assessment.');}catch(e){checks.push({id:'assessment-record',status:'failed',detail:(e as Error).message});assessment=undefined;}
 const status:Status=!assessment?'human':assessment.source!==current.source||assessment.spec!==spec.digest||(retained&&assessment.evidenceDigest!==retained.digest)?'stale':assessment.passed?'passed':'failed';
 checks.push({id:'human-assessment',status,detail:assessment?`Operator assessment: ${assessment.notes}`:'Assess requirement coverage, remaining evidence limits and user experience. Automated tests cannot establish all of these.',next:'harness product assess'});
 const security=await securityReport(project,{source:current.source,product:spec.digest,consequence:spec.consequence,acceptance:checks});
 if(spec.consequence==='sensitive'||security.configured)checks.push({id:'security',status:security.status,detail:security.complete?'Scoped security assessment complete; accepted risk remains distinct from passed testing.':'Scoped security assessment needs attention. '+security.requirements.filter(r=>!['passed','not-applicable','accepted-risk'].includes(r.status)).map(r=>r.id+': '+r.status).join('; '),next:security.next});
 const performance=await performanceReport(project,{source:current.source,product:spec.digest});
 if(spec.consequence==='sensitive'||performance.configured)checks.push({id:'performance',status:performance.status,detail:performance.detail,next:performance.next});
 if((await identity(project)).source!==current.source||(await assertProductCurrent(project))?.digest!==spec.digest)throw Error("Project changed while reading evidence; run the report again.");
 await retained?.assertUnchanged();await browser?.assertUnchanged();
 return {version:1,project,spec:spec.digest,source:current.source,...(retained?{evidenceDigest:retained.digest}:{}),kind:spec.kind,plan:verificationPlan(spec.kind,spec.consequence),ready:checks.every(c=>c.status==='passed'||(c.status==='skipped'&&c.required===false)||(c.id==='security'&&c.status==='accepted-risk'&&security.complete&&spec.consequence==='prototype')),security,performance,checks};
}
