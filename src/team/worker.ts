/** The production process adapter. It has no reference to the live project. */
import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import type { Config } from "../config.ts";
import type { SandboxLayout } from "../containment/sandbox.ts";
import { executeAndSubmit, briefing } from "../agent/execute.ts";
import { captureCandidate, InputChangeRequired } from "../workspace/candidate.ts";
import { prepareEnvironment, installEnvironment, EnvironmentBlocked } from "../workspace/dependencies.ts";
import { BoundaryViolation } from "../workspace/changes.ts";
import { DEFAULT_LIMITS } from "../gates/limits.ts";
import { counterPath } from "../gates/tests.ts";
import { runPipeline } from "../pipeline.ts";
import { review } from "../review/reviewer.ts";
import { renderDiff } from "../review/diff.ts";
import { run } from "../run.ts";
import { privateAgentDirectory } from "./inputs.ts";
import type { Attempt, Usage } from "./schema.ts";
import { atomicJson, readState } from "./state.ts";
import type { Worker } from "./controller.ts";

export function processWorker(config: Config, runDirectory: string, testCommand: readonly string[], output: (text: string) => void = text => process.stdout.write(text)): Worker {
  const labels = (a: Attempt): Record<string, string> => ({ "io.harness.run": path.basename(runDirectory), "io.harness.attempt": a.id });
  const layout = (a: Attempt, directory: string, reviewer = false): SandboxLayout => ({
    dockerExecutable: config.dockerExecutable, imageId: config.imageId, containerName: a.containerName,
    workDirectory: directory, agentDirectory: path.join(a.directory, reviewer ? "reviewer-agent" : "agent"),
    piPackageDirectory: config.piPackageDirectory,
    ...(reviewer || a.skills.length === 0 ? {} : { skillsDirectory: path.join(a.directory, "skills") }),
    user: `${process.getuid?.() ?? 501}:${process.getgid?.() ?? 20}`, labels: labels(a),
  });
  return {
    async execute(attempt, task, role) {
      const work = path.join(attempt.directory, "worker");
      const local = layout(attempt, work);
      let spent: Usage = { tokens: 0, costUsd: 0, complete: false };
      await privateAgentDirectory(config.agentDirectory, local.agentDirectory);
      output(`attempt: ${attempt.id} · task: ${task.id} · role: ${role.id}\n`);
      for (const skill of attempt.skills) output(`skill: ${skill.id} ${skill.digest}\n`);
      try {
        const environment = await prepareEnvironment(attempt.baseline.directory, path.join(attempt.directory, "environment"), local, config.gateTimeoutMs, config.installPolicy);
        await installEnvironment(attempt.baseline.directory, work, environment, local, config.gateTimeoutMs);
        const goal = [role.instructions, ...(attempt.feedback ? [`Previous attempt diagnosis: ${attempt.feedback}`] : []), briefing(task.title, task.criteria, task.kind === "shared-inputs"),
          `Allowed change scope: ${task.changeScope.join(", ")}.`,
          `Contract versions: ${JSON.stringify(attempt.contracts)}.`,
          ...attempt.skills.map(skill => `Read /opt/skills/${skill.id}/SKILL.md before using that workflow.`),
          'In your claim you may include "workflowEvidence": ["commands, observed results and evidence files"]. Evidence is a report; host verification still decides acceptance.',
        ].join("\n\n");
        const result = await executeAndSubmit(local, { goal, provider: role.provider ?? config.provider, model: role.model ?? config.model, timeoutMs: Math.min(role.timeoutMs ?? config.agentTimeoutMs, config.agentTimeoutMs), skills: attempt.skills.length > 0, sessionDirectory: "/pi-agent/sessions" }, output);
        const usage: Usage = spent = { tokens: result.agent.usage.totalTokens, costUsd: result.agent.usage.costUsd, complete: false };
        // Reviewer usage is unavailable on its existing text protocol, so run
        // totals remain explicitly estimates even when all builder turns report.
        if (result.agent.timedOut || result.agent.code !== 0 || result.agent.providerError) return { outcome: "failed", reason: result.agent.providerError ?? (result.agent.timedOut ? "Worker timed out." : `Worker exited ${result.agent.code}: ${result.agent.stderr}`), usage };
        if (result.submission.ok && result.submission.outcome === "blocked") return { outcome: "blocked", reason: `${result.submission.reason}\nNeeded: ${result.submission.requestedInput}`, usage };
        if (!result.claim.ok) return { outcome: "failed", reason: result.claim.reason, usage };
        const candidate = await captureCandidate(attempt.baseline, work, path.join(attempt.directory, "candidate"), { sharedInputs: task.kind === "shared-inputs", limits: role.limits ?? DEFAULT_LIMITS, ...(config.contractPaths === undefined ? {} : { contractPaths: config.contractPaths }) });
        await atomicJson(path.join(attempt.directory, "claim.json"), result.claim);
        const raw = JSON.parse(await readFile(path.join(work, ".harness-claim.json"), "utf8")) as { workflowEvidence?: unknown };
        const workflowEvidence = Array.isArray(raw.workflowEvidence) ? raw.workflowEvidence.filter((v): v is string => typeof v === "string") : [];
        return { outcome: "submitted", candidate, usage, observedReads: result.agent.observedReads, workflowEvidence };
      } catch (error) {
        if (error instanceof EnvironmentBlocked) return { outcome: "blocked", reason: `environment-blocked: ${error.message}`, usage: spent };
        if (error instanceof InputChangeRequired) return { outcome: "blocked", reason: error.message, usage: spent };
        if (error instanceof BoundaryViolation) return { outcome: "failed", reason: error.message, usage: spent };
        // Unexpected launcher/transport errors leave an unfinished durable
        // attempt for explicit recovery; they are never accepted as a result.
        throw error;
      }
    },
    async verify(attempt, result, task) {
      const local = layout(attempt, result.candidate.directory);
      const proof = await runPipeline({ config, layout: local, project: attempt.baseline.directory,
        claim: JSON.parse(await readFile(path.join(attempt.directory, "claim.json"), "utf8")),
        testCommand, counterSource: await readFile(counterPath(), "utf8"), limits: (await readState(runDirectory, false)).plan.roles.find(r => r.id === attempt.roleId)?.limits ?? DEFAULT_LIMITS });
      const gates = proof.run.verdicts.map(v => v.summary);
      for (const gate of gates) output(gate + "\n");
      await atomicJson(path.join(attempt.directory, "verification.json"), proof);
      if (!proof.run.passed) return { passed: false, gates, review: "not-run", blocked: proof.run.firstFailure?.kind === "environment-blocked", reason: proof.run.firstFailure?.detail ?? "Gates failed." };
      const reviewer = layout(attempt, result.candidate.directory, true);
      await privateAgentDirectory(config.agentDirectory, reviewer.agentDirectory);
      const verdict = await review(reviewer, { title: task.title, criteria: task.criteria, diff: await renderDiff(attempt.baseline.directory, result.candidate.directory, result.candidate.changes), provider: config.provider, model: config.model, timeoutMs: config.agentTimeoutMs });
      await atomicJson(path.join(attempt.directory, "review.json"), verdict);
      return { passed: verdict.verdict === "pass" && verdict.failure === undefined, gates, review: verdict.verdict, ...(proof.environmentKey === undefined ? {} : { environmentKey: proof.environmentKey }), reason: verdict.failure ?? [...verdict.unmet, ...verdict.unaccounted, ...verdict.notes].join("\n") };
    },
    async cleanup(attempt) {
      const listed = await run(config.dockerExecutable, ["ps", "--all", "--quiet", ...Object.entries(labels(attempt)).flatMap(([key, value]) => ["--filter", `label=${key}=${value}`])], { timeoutMs: 15000 });
      if (listed.code !== 0 || listed.timedOut) throw new Error(`Cannot reconcile owned containers: ${listed.stderr}`);
      for (const id of listed.stdout.trim().split(/\s+/u).filter(Boolean)) {
        if (!/^[a-f0-9]{12,64}$/u.test(id)) throw new Error("Docker returned an invalid container identity.");
        const removed = await run(config.dockerExecutable, ["rm", "--force", id], { timeoutMs: 15000 });
        if (removed.code !== 0 || removed.timedOut) throw new Error(`Owned container cleanup failed: ${removed.stderr}`);
      }
      // Retain candidate, claim and verification evidence, never auth/session copies.
      for (const name of ["agent", "reviewer-agent", "worker", "environment"]) await rm(path.join(attempt.directory, name), { recursive: true, force: true });
    },
  };
}
