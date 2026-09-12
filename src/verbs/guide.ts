import { guideJobs } from "../guide/jobs.ts";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { detectProjects } from "../adapters/registry.ts";
import { readProfile } from "../project/profile.ts";
import { loadConfig } from "../config.ts";
import { chooseNext, readFeatures } from "../features.ts";
import { choose, confirmed, terminalDialogue, type Dialogue } from "../guide/dialogue.ts";
import { inspectWriter, readiness } from "../guide/readiness.ts";
import { acceptedProposal, resolvePlan } from "../planning/store.ts";
import { readRecord } from "../record/record.ts";
import { canonicalProject, recoverWriter } from "../workspace/writer-lock.ts";
import { OperatorError } from "./io.ts";

export type GuideCommand = (project: string, args: readonly string[]) => Promise<number>;
const execute: GuideCommand = (project, args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../cli.ts"), ...args], {
    stdio: "inherit", env: { ...process.env, HARNESS_PROJECT: project },
  });
  child.once("error", reject);
  child.once("close", code => resolve(code ?? 1));
});

export async function guide(configuredProject: string, io: Dialogue = terminalDialogue(), command: GuideCommand = execute): Promise<void> {
  io.write("Harness guide — saved plans and project state determine the next step.");
  io.write(`Shell folder: ${process.cwd()}`);
  io.write(`Configured project: ${configuredProject}`);
  const selected = (await io.ask("Project path (Enter to use the configured project):")).trim() || configuredProject;
  const project = await canonicalProject(selected.startsWith("~/") ? path.join(os.homedir(), selected.slice(2)) : selected);
  io.write(`Selected project: ${project}`);
  for (;;) {
    const actions: { label: string; run(): Promise<void> }[] = [];
    const run = async (...args: string[]) => {
      const code = await command(project, args);
      if (code !== 0) io.write("That step stopped. Saved plans and records remain available; review the message above, then choose the next action.");
    };
    try {
      const owner = await inspectWriter(project);
      const pending = await readFile(`${project}-harness/application.json`, "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; });
      if (owner) {
        io.write(`Writer: ${owner.command}, pid ${owner.pid}. ${owner.recoverable ? "The owner process has ended." : "The owner is live or cannot be verified. Wait for it to finish."}`);
        if (owner.recoverable) actions.push({ label: "Recover the ended writer (preserve saved work)", async run() {
          await recoverWriter(project, owner.token);
          io.write("Writer recovered. Resume the saved plan, or reconcile team resources before more work.");
        } });
      } else if (pending) {
        const value = JSON.parse(pending);
        if (typeof value.teamRunId !== "string") throw new OperatorError("Pending application has no valid team identity.");
        io.write(`Interrupted application: ${value.teamRunId}. This is saved application work, not a new build.`);
        actions.push({ label: "Finish the saved application", run: () => run("team", "recover", value.teamRunId) });
        actions.push({ label: "Roll back the interrupted application", run: () => run("team", "recover", value.teamRunId, "--rollback") });
      } else {
        const detected = await detectProjects(project);
        const initialized = detected.some(id => ["node-npm", "python-pip"].includes(id));
        if (!initialized && detected.length) io.write(`Detected ${detected.join(", ")}; choose a supported Node/npm or Python package root. Use project setup for guidance.`);
        if (!initialized && !detected.length) {
          actions.push({ label: "Create a Node project here", run: () => run("init") });
          actions.push({ label: "Create a Python project here", run: () => run("init", "--python") });
        }
        else if (initialized) {
          let supported = true;
          try { const profile = await readProfile(project); io.write(`Environment: ${profile.adapter.id}@${profile.adapter.version} on ${profile.runner.id}@${profile.runner.version}.`); }
          catch (error) { supported = false; io.write((error as Error).message); }
          if (!supported) actions.push({ label: "Choose the project environment", run: () => run("project", "setup") });
          if (supported) {
          let saved;
          try { saved = await resolvePlan(project); } catch (error) {
            if (!(error instanceof OperatorError && error.message.startsWith("No plan has been saved"))) throw error;
          }
          if (saved) {
            io.write(`Saved plan: ${saved.state.topic || "Project plan"} · ${saved.state.phase} · ${saved.state.status}`);
            const plan = saved;
            if (plan.state.phase !== "ready") actions.push({ label: plan.state.phase === "draft" ? "Continue the saved interview" : "Continue generating items from the approved plan", run: () => run("plan", "resume", plan.state.id) });
            if (plan.state.phase === "draft") actions.push({ label: "Review the draft and approve item generation", run: () => run("plan", "review", plan.state.id) });
            if (plan.state.phase === "ready") {
              const proposal = await acceptedProposal(plan);
              const existing = await readFeatures(project);
              if (!existing?.ok || !proposal.features.every(t => existing.features.some(e => e.id === t.id))) actions.push({ label: "Review and accept proposed work items", async run() {
                for (const task of proposal.features) {
                  io.write(`${task.title} (${task.id}); ${task.priority}; needs ${task.dependsOn.join(", ") || "no prerequisites"}`);
                  task.criteria.forEach(c => io.write(`  ${c}`));
                }
                if (await confirmed(io, "Accept these items?")) await run("add", "--from", path.join(plan.directory, "items.json"));
              } });
            }
          } else actions.push({ label: "Plan what to build (saved interview)", async run() {
            const topic = (await io.ask("What would you like to build?")).trim();
            if (topic) await run("plan", topic);
          } });
          const list = await readFeatures(project);
          if (list && !list.ok) throw new OperatorError(list.reason);
          if (list?.features.length) {
            const history = await readRecord(project);
            const next = chooseNext(list.features, id => history.runs.filter(r => r.goal === id).at(-1)?.outcome).next;
            if (next) actions.push({ label: `Build next: ${next.title}`, async run() {
              io.write(`${next.title}: ${next.criteria.join("; ")}`);
              const status = await readiness(project);
              if (!status.ready) { for (const c of status.checks.filter(c => c.status === "missing" || c.status === "blocked")) io.write(c.message); io.write(`Next: ${status.next}`); return; }
              const config = loadConfig({ ...process.env, HARNESS_PROJECT: project });
              io.write(`Success applies this item to ${project}. It does not commit or publish it.`);
              io.write(`Up to two builder attempts; ${config.agentTimeoutMs / 1000}s per model call, ${config.gateTimeoutMs / 1000}s per check. Provider cost is unknown until reported.`);
              await run("work", next.id);
            } });
            else io.write("No eligible next item. Review status for completed, deferred or blocked work.");
            actions.push({ label: "Set up acceptance checks (short prompts)", run: () => run("checks", "setup") });
            actions.push({ label: "Review a saved check draft", run: () => run("checks", "review") });
          }
          }
        }
        if (initialized) actions.push({ label: "Test, package and retain build outputs", run: () => run("verify", "--retain") });
        actions.push({ label: "Configure project environment and skills", run: () => run("project", "setup") });
      }
    } catch (error) { io.write(`Needs attention: ${(error as Error).message}`); }
    actions.push({ label: "Check readiness", run: () => run("doctor") });
    actions.push({ label: "Review project status and history", run: () => run("look") });
    actions.push({ label: "Manage jobs and retained outputs", run: () => guideJobs(project, io, command) });
    const choice = await choose(io, "Next action", actions.map(a => a.label));
    if (choice < 0) { io.write(`Saved work stays with ${project}. Return with harness guide ${JSON.stringify(project)}.`); return; }
    try { await actions[choice]!.run(); }
    catch (error) { io.write((error as Error).message); if (error instanceof OperatorError && error.remedy) io.write(error.remedy); }
  }
}
