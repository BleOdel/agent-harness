import {regenerateSavedCheck} from "../acceptance/regenerate.ts";
import {prepareChecks,checkWorkflowStatus} from '../acceptance/workflow.ts';
import {parseCheckLimits} from '../acceptance/budget.ts';
import { guidedSetup, readGuidedDraft, reviewGuidedDraft, resumePreparation, repairSavedCheck, simplifySavedCheck, useRecipeSavedCheck } from "../acceptance/guided.ts";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { readApproval, approveChecks, parseChecks, type CheckStep } from "../acceptance/checks.ts";
import { readFeatures } from "../features.ts";
import { atomicWrite } from "../planning/store.ts";
import { harnessDirectory } from "../record/record.ts";
import { canonicalProject, withWriter } from "../workspace/writer-lock.ts";
import { choose, confirmed, terminalDialogue, type Dialogue } from "../guide/dialogue.ts";
import { OperatorError, say } from "./io.ts";

const decode = (text: string): string => text.replace(/\\(n|t|r|\\)/gu, (_, code: string) => ({ n: "\n", t: "\t", r: "\r", "\\": "\\" })[code]!);

export async function setupChecks(project: string, io: Dialogue, manual = false): Promise<void> {
  project = await canonicalProject(project);
  const features = await readFeatures(project);
  if (!features?.ok || !features.features.length) throw new OperatorError("Accept work items before setting up checks.", "Use harness guide to plan and accept items first.");
  const index = await choose(io, "Which task should this check cover?", features.features.map(t => `${t.title} (${t.id})`));
  if (index < 0) return;
  const task = features.features[index]!;
  if (!manual) return guidedSetup(project, task, io);
  task.criteria.forEach(c => io.write(`  Expected: ${c}`));
  io.write("Describe observable application behaviour. Commands run only in an isolated, offline verification copy. Do not use a test runner's 'passed' message as the expected result.");
  io.write("Use /work for project paths. Enter \\n for a newline or \\t for a tab in expected text.");
  const steps: CheckStep[] = [];
  do {
    const command = (await io.ask("Application command (blank to cancel):")).trim();
    if (!command) return;
    const code = (await io.ask("Expected exit code [0]:")).trim();
    const step: CheckStep = { command: ["sh", "-c", command], exitCode: code ? Number(code) : 0 };
    const kind = await choose(io, "What should the host verify?", ["Exact output", "Output includes text", "Exact file content"]);
    if (kind < 0) return;
    if (kind === 2) {
      const file = (await io.ask("File path relative to the project:")).trim();
      step.files = [{ path: file, text: decode(await io.ask("Expected file content:")) }];
    } else {
      const text = decode(await io.ask("Expected output:"));
      if (kind === 0) step.stdout = text; else step.stdoutIncludes = text;
    }
    parseChecks({ version: 1, cases: [{ id: "draft", tasks: [task.id], steps: [step] }] });
    steps.push(step);
  } while (await confirmed(io, "Add another step using the same data (for example, restart and load)?"));
  // Preserve previously approved cases; never silently remove another task's checks.
  const previous = await readApproval(project);
  const manifest = parseChecks({ version: 1, cases: [...(previous?.manifest.cases ?? []), { id: `${task.id}-${randomUUID().slice(0, 8)}`, tasks: [task.id], steps }] });
  io.write(`Review checks for ${task.title}:`);
  for (const [index, step] of steps.entries()) {
    io.write(`  ${index + 1}. ${step.command[2]} -> exit ${step.exitCode}`);
    if (step.stdout !== undefined) io.write(`     Output exactly: ${JSON.stringify(step.stdout)}`);
    if (step.stdoutIncludes !== undefined) io.write(`     Output includes: ${JSON.stringify(step.stdoutIncludes)}`);
    for (const file of step.files ?? []) io.write(`     ${file.path}: ${JSON.stringify(file.text)}`);
  }
  const approve = await confirmed(io, "Approve these checks before building this task?");
  await withWriter(project, "checks", async () => {
    if ((await readApproval(project))?.digest !== previous?.digest) throw new OperatorError("Checks changed while you reviewed them. Run setup again to include the latest checks.");
    const directory = path.join(harnessDirectory(project), "acceptance");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const draft = path.join(directory, "draft.json");
    await atomicWrite(draft, JSON.stringify(manifest, null, 2) + "\n");
    await rm(path.join(directory, "guided-draft.json"), { force: true });
    if (approve) { await approveChecks(project, draft); io.write("Checks approved. They will be required before application."); }
    else io.write(`Draft saved without approval: ${draft}. Review later with harness checks review.`);
  });
}

export async function checks(project: string, args: readonly string[]): Promise<void> {
  if(args[0]==='prepare'){const status=await prepareChecks(project,terminalDialogue(),parseCheckLimits(args.slice(1)));if(status==='blocked')process.exitCode=1;return;}
  if(args.length===2&&args[0]==='regenerate')return regenerateSavedCheck(project,terminalDialogue(),args[1]!);
  if(args.length===1&&args[0]==='status')return checkWorkflowStatus(project,say);
  if (args.length === 1 && args[0] === "setup") return setupChecks(project, terminalDialogue());
  if (args.length === 2 && args[0] === "setup" && args[1] === "--manual") return setupChecks(project, terminalDialogue(), true);
  if ((args.length===1||args.length===2) && args[0]==="use-recipe") return useRecipeSavedCheck(project,terminalDialogue(),args[1]);
  if ((args.length===1||args.length===2) && args[0]==="repair") return repairSavedCheck(project,terminalDialogue(),args[1]);
  if ((args.length===1||args.length===2) && args[0]==="simplify") return simplifySavedCheck(project,terminalDialogue(),args[1]);
  if (args.length === 1 && args[0] === "review") {
    const io = terminalDialogue();
    if (await readGuidedDraft(project,true)) return reviewGuidedDraft(project, io);
    if (await resumePreparation(project, io)) return;
    const { readArtifact } = await import("../planning/store.ts");
    const directory = path.join(harnessDirectory(await canonicalProject(project)), "acceptance");
    const raw = await readArtifact(directory, "draft.json");
    if (!raw) throw new OperatorError("No check draft is saved.", "Run harness checks setup.");
    parseChecks(JSON.parse(raw)); io.write(raw);
    if (await confirmed(io, "Approve this saved draft?")) await withWriter(project, "checks", async () => {
      if (await readArtifact(directory, "draft.json") !== raw) throw new OperatorError("The check draft changed during review. Review it again before approval.");
      await approveChecks(project, path.join(directory, "draft.json")); io.write("Checks approved.");
    });
    return;
  }
  if (!args.length) {
    const approval = await readApproval(project);
    if (approval) { say(`Approved acceptance checks: ${approval.manifest.cases.length} cases`); for (const c of approval.manifest.cases) say(`  ${c.id}: ${c.tasks.join(", ")}`); }
    else say("No acceptance checks approved. Builds stop before model work until checks cover their tasks.");
    say("Next: harness checks prepare (bounded preparation from your plan), or harness checks approve <file> (JSON document).");
    say("Use application behaviour, not a test runner's claim that tests passed. The host checks expectations outside the candidate process."); return;
  }
  if (args.length !== 2 || args[0] !== "approve") throw new OperatorError("Use: harness checks [prepare [--max-requests N] [--max-seconds N] [--request-seconds N] | regenerate <case-id> | status | setup [--manual] | review | repair [case-id] | use-recipe [case-id] | simplify [case-id] | approve <file>]");
  await withWriter(project, "checks", async () => { const approval = await approveChecks(project, path.resolve(args[1]!)); say(`Approved ${approval.manifest.cases.length} acceptance cases. These exact expectations will be checked before application.`); });
}
