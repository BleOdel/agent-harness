/** Approved expectations are evaluated by the host and never mounted into candidate processes. */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { harnessDirectory } from "../record/record.ts";
import { atomicWrite, readArtifact } from "../planning/store.ts";
import { readSafe, safePath } from "../workspace/safe-path.ts";
import { assertSnapshot, type Snapshot } from "../workspace/candidate.ts";
import { getAdapter } from "../adapters/registry.ts";
import { readProfile } from "../project/profile.ts";
import { assertExecutionCompatible, assertExecutionPin, type ExecutionPin } from "../project/execution.ts";
import { dockerRunner } from "../runners/docker.ts";
import { buildVerificationArguments, type SandboxLayout } from "../containment/sandbox.ts";
import { runContained } from "../containment/process.ts";
import type { Config } from "../config.ts";
import { OperatorError } from "../verbs/io.ts";

export interface ExpectFile { path:string; text?:string; sha256?:string; }
export interface CheckStep { command:string[]; exitCode:number; stdout?:string; stdoutIncludes?:string; files?:ExpectFile[]; }
export interface AcceptanceCase { id:string; tasks:string[]; steps:CheckStep[]; }
export interface CheckManifest { version:1; cases:AcceptanceCase[]; }
export interface Approval { version:1; digest:string; approvedAt:string; manifest:CheckManifest; }
const hash=(text:string|Buffer)=>createHash("sha256").update(text).digest("hex");
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const json = (text: string, name: string): unknown => {
  try { return JSON.parse(text); }
  catch { throw new OperatorError(`${name} contains invalid JSON.`, "Review the document and approve valid acceptance checks before building."); }
};
const strings=(v:unknown):v is string[]=>Array.isArray(v)&&v.length>0&&v.every(s=>typeof s==="string"&&s.trim());
export function parseChecks(raw:unknown):CheckManifest{
 if(!object(raw)||raw.version!==1||!Array.isArray(raw.cases)||!raw.cases.length)throw new OperatorError("Acceptance checks need version: 1 and at least one case.");
 const ids=new Set<string>();
 for(const entry of raw.cases){
  if(!object(entry)||typeof entry.id!=="string"||!entry.id.trim()||ids.has(entry.id)||!strings(entry.tasks)||!Array.isArray(entry.steps)||!entry.steps.length)throw new OperatorError("Each acceptance case needs a unique id, task ids (or *), and steps.");
  ids.add(entry.id);
  for(const step of entry.steps){
   if(!object(step)||!Array.isArray(step.command)||!step.command.length||typeof step.command[0]!=="string"||!step.command[0].trim()||step.command.some(v=>typeof v!=="string"||v.includes("\0"))||!Number.isInteger(step.exitCode)||(step.exitCode as number)<0||(step.exitCode as number)>255)throw new OperatorError(`${entry.id}: each step needs a command array and exitCode.`);
   if(step.stdout!==undefined&&typeof step.stdout!=="string")throw new OperatorError(`${entry.id}: stdout must be exact text.`);
   if(step.stdoutIncludes!==undefined&&(typeof step.stdoutIncludes!=="string"||!step.stdoutIncludes))throw new OperatorError(`${entry.id}: stdoutIncludes must be nonempty text.`);
   if(step.files!==undefined&&(!Array.isArray(step.files)||!step.files.length))throw new OperatorError(`${entry.id}: files must be a nonempty list.`);
   for(const file of (step.files??[]) as unknown[]){
    if(!object(file)||typeof file.path!=="string"||path.isAbsolute(file.path)||file.path.split(/[\\/]/u).some(p=>!p||p==="."||p==="..")
     ||(file.text===undefined&&file.sha256===undefined)||(file.text!==undefined&&typeof file.text!=="string")
     ||(file.sha256!==undefined&&(typeof file.sha256!=="string"||! /^[a-f0-9]{64}$/u.test(file.sha256))))throw new OperatorError(`${entry.id}: expected files need a safe relative path and exact text or sha256.`);
   }
   if(!step.stdout&&!step.stdoutIncludes&&!(step.files as unknown[]|undefined)?.length)throw new OperatorError(`${entry.id}: exit code alone is not acceptance evidence; specify expected application output or file content.`);
  }
 }
 return raw as unknown as CheckManifest;
}
export const approvalPath=(project:string)=>path.join(harnessDirectory(project),"acceptance","approved.json");
export async function approveChecks(project:string,source:string):Promise<Approval>{
 const canonical=await realpath(project);const raw=await readArtifact(path.dirname(source),path.basename(source));
 if(!raw)throw new OperatorError("No acceptance-check document at that path.");
 const manifest=parseChecks(json(raw, "Acceptance document"));const approval:Approval={version:1,digest:hash(JSON.stringify(manifest)),approvedAt:new Date().toISOString(),manifest};
 await mkdir(path.dirname(approvalPath(canonical)),{recursive:true,mode:0o700});
 const archive=path.join(path.dirname(approvalPath(canonical)),"approvals");
 await mkdir(archive,{recursive:true,mode:0o700});
 await writeFile(path.join(archive,`${approval.digest}.json`),JSON.stringify(manifest),{flag:"wx",mode:0o600}).catch((error:NodeJS.ErrnoException)=>{if(error.code!=="EEXIST")throw error;});
 await atomicWrite(approvalPath(canonical),JSON.stringify(approval,null,2)+"\n");return approval;
}
export async function readApproval(project:string):Promise<Approval|undefined>{
 const canonical=await realpath(project);const raw=await readArtifact(path.dirname(approvalPath(canonical)),"approved.json");
 if(raw===undefined)return undefined;
 const parsed=json(raw, "Saved approval");
 if(!object(parsed))throw new OperatorError("Saved approval is malformed. Review and approve checks again.");
 const approval=parsed as unknown as Approval;
 const manifest=parseChecks(approval.manifest);
 if(approval.version!==1||approval.digest!==hash(JSON.stringify(manifest)))throw new OperatorError("Approved acceptance checks changed. Review and approve them again.");
 return approval;
}
export async function requireChecks(project:string,tasks:readonly string[]):Promise<Approval>{
 const approved=await readApproval(project);
 if(!approved)throw new OperatorError("Acceptance checks have not been approved for this project.","Run harness checks to prepare and review expected application behaviour, then approve the checks. No model work has started.");
 const missing=tasks.filter(task=>!approved.manifest.cases.some(c=>c.tasks.includes("*")||c.tasks.includes(task)));
 if(missing.length)throw new OperatorError(`No approved acceptance checks cover: ${missing.join(", ")}.`,"Add cases for those tasks, then run harness checks approve <file>.");
 return approved;
}
export async function assertApprovalCurrent(project:string,expected:Approval):Promise<void>{
 if((await readApproval(project))?.digest!==expected.digest)throw new OperatorError("Acceptance checks changed during this run. Re-verify before applying.");
}
export interface AcceptanceProof {
  approvalDigest: string;
  candidateDigest: string;
  evidencePath: string;
  executionDigest?: string;
}
export interface AcceptanceResult extends AcceptanceProof { summaries: string[]; }
export class AcceptanceFailure extends OperatorError {
  readonly proof: AcceptanceProof;
  constructor(message: string, proof: AcceptanceProof) {
    super(message, `Nothing applied. Evidence: ${proof.evidencePath}\nInspect the application behaviour or review the approved expectations, then retry.`);
    this.proof = proof;
  }
}

/** The caller is trusted host code; a candidate never receives this evidence directory. */
export async function assertAcceptanceProof(project: string, candidate: Snapshot, tasks: readonly string[], proof?: AcceptanceProof): Promise<void> {
  if (!proof) throw new OperatorError("Application requires approved acceptance evidence.", "Run verification before applying this candidate.");
  const approved = await requireChecks(project, tasks);
  const root = path.join(harnessDirectory(await realpath(project)), "acceptance", "results");
  if (path.dirname(proof.evidencePath) !== root || !/^[a-f0-9-]+\.json$/u.test(path.basename(proof.evidencePath))) throw new OperatorError("Invalid acceptance evidence location.");
  const evidence = JSON.parse(await readArtifact(root, path.basename(proof.evidencePath)) ?? "null");
  if (!evidence || evidence.version !== 1 || evidence.outcome !== "passed"
    || evidence.project !== await realpath(project) || evidence.approvalDigest !== approved.digest
    || evidence.approvalDigest !== proof.approvalDigest || evidence.candidateDigest !== candidate.digest
    || proof.candidateDigest !== candidate.digest || !Array.isArray(evidence.tasks)
    || tasks.some(t => !evidence.tasks.includes(t))) throw new OperatorError("Acceptance evidence does not cover the current candidate and approved checks.");
  if (candidate.executionDigest) assertExecutionPin(evidence.execution);
  if (candidate.executionDigest && (proof.executionDigest !== candidate.executionDigest || evidence.execution?.digest !== candidate.executionDigest)) throw new OperatorError("Acceptance evidence does not match the candidate execution environment.");
  await assertSnapshot(candidate);
}

export async function verifyAcceptance(project: string, candidate: Snapshot, tasks: readonly string[], config: Config, approved: Approval, execution?: ExecutionPin): Promise<AcceptanceResult> {
  project = await realpath(project);
  await assertApprovalCurrent(project, approved);
  await assertSnapshot(candidate);
  if (execution) await assertExecutionCompatible(execution, project, config, execution.settings.testCommand);
  const adapter = getAdapter((execution?.settings.profile ?? await readProfile(project, true)).adapter);
  const evidenceRoot = path.join(harnessDirectory(project), "acceptance", "results");
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const proof: AcceptanceProof = { ...(execution ? { executionDigest: execution.digest } : {}), approvalDigest: approved.digest, candidateDigest: candidate.digest, evidencePath: path.join(evidenceRoot, `${randomUUID()}.json`) };
  let environmentKey: string | undefined;
  const observations: { runner?: ReturnType<typeof dockerRunner.evidence>; case: string; step: number; exitCode: number | null; timedOut: boolean; stdoutHash: string; stdoutPreview: string; stderrTail: string; files: Record<string, string | null> }[] = [];
  const save = async (outcome: "passed" | "failed", error?: string) => atomicWrite(proof.evidencePath, JSON.stringify({
    version: 1, at: new Date().toISOString(), project, ...proof, execution, adapter: adapter.reference, runner: dockerRunner.reference, image: config.imageId, environmentKey, tasks, outcome, observations, ...(error ? { error } : {}),
  }, null, 2) + "\n");
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "harness-acceptance-")));
  const base: SandboxLayout = {
    dockerExecutable: config.dockerExecutable, imageId: config.imageId,
    containerName: `harness-acceptance-${path.basename(root)}`, workDirectory: candidate.directory,
    agentDirectory: config.agentDirectory, piPackageDirectory: config.piPackageDirectory,
    user: `${process.getuid?.() ?? 501}:${process.getgid?.() ?? 20}`,
  };
  const summaries: string[] = [];
  try {
    const environment = await adapter.prepare(candidate.directory, path.join(root, "environment"), base, config.gateTimeoutMs, config.installPolicy);
    environmentKey = environment.key;
    const selected = approved.manifest.cases.filter(c => c.tasks.includes("*") || tasks.some(t => c.tasks.includes(t)));
    if (!selected.length) throw new OperatorError("No approved acceptance cases apply to this work.");
    for (const [index, check] of selected.entries()) {
      const work = path.join(root, `case-${index}`);
      await adapter.install(candidate.directory, work, environment, base, config.gateTimeoutMs);
      const layout = { ...base, workDirectory: work };
      for (const [number, step] of check.steps.entries()) {
        const label = `acceptance ${check.id}, step ${number + 1}`;
        const result = await runContained(layout, buildVerificationArguments(layout, "none", step.command), { timeoutMs: config.gateTimeoutMs, maxOutputBytes: 2 * 1024 * 1024 });
        const observation = { runner: dockerRunner.evidence(layout, result), case: check.id, step: number + 1, exitCode: result.code, timedOut: result.timedOut, stdoutHash: hash(result.stdout), stdoutPreview: result.stdout.slice(0, 4000), stderrTail: result.stderr.slice(-2000), files: Object.create(null) as Record<string, string | null> };
        observations.push(observation);
        if (result.outputLimited) throw new OperatorError(`${label}: application output exceeded 2 MiB.`);
        if (result.timedOut || result.code !== step.exitCode) throw new OperatorError(`${label}: ${result.timedOut ? "timed out" : `expected exit ${step.exitCode}, got ${result.code}`}.`);
        if (step.stdout !== undefined && result.stdout !== step.stdout) throw new OperatorError(`${label}: application output did not match approved text.`);
        if (step.stdoutIncludes !== undefined && !result.stdout.includes(step.stdoutIncludes)) throw new OperatorError(`${label}: application output is missing approved text.`);
        for (const expected of step.files ?? []) {
          const file = await safePath(work, expected.path);
          const stat = await lstat(file).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; });
          if (stat && stat.size > 8 * 1024 * 1024) throw new OperatorError(`${label}: expected file exceeds the 8 MiB acceptance limit.`);
          const actual = await readSafe(work, expected.path);
          observation.files[expected.path] = actual ? hash(actual) : null;
          if (!actual || (expected.text !== undefined && !actual.equals(Buffer.from(expected.text))) || (expected.sha256 !== undefined && hash(actual) !== expected.sha256)) throw new OperatorError(`${label}: ${expected.path} did not match approved content.`);
        }
      }
      summaries.push(`acceptance: ${check.id} passed against operator-approved expectations`);
    }
    await assertSnapshot(candidate);
    await assertApprovalCurrent(project, approved);
    if (execution) await assertExecutionCompatible(execution, project, config, execution.settings.testCommand);
    await save("passed");
    return { ...proof, summaries };
  } catch (error) {
    await save("failed", (error as Error).message);
    throw new AcceptanceFailure((error as Error).message, proof);
  } finally { await rm(root, { recursive: true, force: true }); }
}
