/** Host observations of this candidate, separate from builder claims and acceptance. */
import type { PipelineResult } from "../pipeline.ts";
import { assertExecutionPin, type ExecutionPin } from "../project/execution.ts";

export interface VerificationEvidence {
 readonly version: 1;
 readonly sourceDigest: string;
 readonly baselineDigest: string;
 readonly executionDigest: string;
 readonly environmentKey: string;
 readonly runtime: { image: string; os: string; arch: string; toolchains: Readonly<Record<string,string>>; network: string };
 readonly testCommand: readonly string[];
 readonly gates: readonly { name: string; passed: boolean; summary: string; output: string; outputTruncated: boolean }[];
 readonly skipped: readonly string[];
 readonly acceptance: "not-run";
}

export function verificationEvidence(proof: PipelineResult, sourceDigest: string, baselineDigest: string,
 execution: ExecutionPin, testCommand: readonly string[]): VerificationEvidence {
 assertExecutionPin(execution);
 const identity = proof.identity;
 const sameReference = (a: {id:string;version:number}, b: {id:string;version:number}) => a.id === b.id && a.version === b.version;
 if (!sourceDigest || !baselineDigest || proof.sourceDigest !== sourceDigest || !proof.environmentKey ||
     !proof.run.passed || proof.run.firstFailure || !proof.run.verdicts.length || proof.run.verdicts.some(g => !g.passed) ||
     !identity || identity.image !== execution.capabilities.image ||
     !sameReference(identity.adapter, execution.settings.profile.adapter) || !sameReference(identity.runner, execution.capabilities.runner) ||
     JSON.stringify(testCommand) !== JSON.stringify(proof.testCommand) ||
     JSON.stringify(testCommand) !== JSON.stringify(execution.settings.testCommand)) {
  throw new Error("Review verification evidence does not match the passed candidate and pinned execution.");
 }
 // Keep first and last observations when a noisy project exhausts the prompt budget.
 // Counts and output come from project-authored tests; they are not independent proof.
 let remaining = 12000;
 const gates = proof.run.verdicts.map(g => {
  const limit = Math.min(remaining, g.name === "tests" ? 8000 : 1000);
  const text = g.detail ?? "";
  const marker = "\n[... output truncated ...]\n";
  const kept = Math.max(0, limit - marker.length);
  const output = text.length <= limit ? text : limit < marker.length ? text.slice(0, limit)
   : text.slice(0, Math.ceil(kept / 2)) + marker + text.slice(text.length - Math.floor(kept / 2));
  remaining -= output.length;
  return { name:g.name, passed:g.passed, summary:g.summary.slice(0,1000), output, outputTruncated:text.length > limit };
 });
 const c = execution.capabilities;
 return { version:1, sourceDigest, baselineDigest, executionDigest:execution.digest, environmentKey:proof.environmentKey,
  runtime:{image:c.image,os:c.os,arch:c.arch,toolchains:{...c.toolchains},network:c.network.verification},
  testCommand:[...testCommand], gates, skipped:[...proof.run.skipped], acceptance:"not-run" };
}
