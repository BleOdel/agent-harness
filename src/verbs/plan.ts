/** Interview drafts and Pi sessions survive every exit; approval advances document handoff. */
import path from "node:path";
import { realpath, rm } from "node:fs/promises";
import { buildRunArguments, CONTAINER_PI_PACKAGE, type SandboxLayout } from "../containment/sandbox.ts";
import { runContained, withContainmentSignal } from "../containment/process.ts";
import { stopContainer } from "../containment/stop.ts";
import { ConfigError, loadConfig, setting, type Config } from "../config.ts";
import { listSkills } from "../agent/skills.ts";
import { resourceArguments } from "../agent/resources.ts";
import { withWriter } from "../workspace/writer-lock.ts";
import { OperatorError, say } from "./io.ts";
import { approvePlan, approvedText, atomicWrite, createPlan, finishItems, readArtifact, resolvePlan, savePlan, type SavedPlan } from "../planning/store.ts";

export const PLAN_FILE = "PLAN.md";
export const ITEMS_FILE = "items.json";
export const SESSION_FILE = "session.jsonl";

const itemsFormat = [
  'Write items.json as a JSON array: [{"id":"short-kebab-id","title":"Deliverable",',
  '"priority":"must","criteria":["testable result"],"dependsOn":[]}].',
  'Priorities: must, should, could, wont. Do not include a status field.',
  'Dependencies must name other items in this proposal and must be acyclic.',
  'Assignments changing package manifests, lockfiles or shared contracts must use "kind":"shared-inputs".',
  'Separate those assignments and put dependent implementation after them.',
  'Write criteria so a reviewer who cannot see this conversation can verify them.',
].join("\n");

export function planPrompt(topic: string, skills: readonly string[]): string {
  return [
    topic ? `Interview me about: ${topic}` : "Interview me about what this project should do next.",
    ...(skills.includes("grilling") ? ["Use your grilling skill."] : []),
    "Work in rounds: ask every question whose prerequisites are settled, with recommendations,",
    "then wait for my answers before the next round. Read the project instead of asking for facts you can inspect.",
    "The existing session, DECISIONS.md and PLAN.md are saved context. Read them before asking anything again.",
    "After each round of answers, update DECISIONS.md with decisions and open questions BEFORE asking the next round.",
    "Maintain PLAN.md as a draft throughout the interview. Do not wait until the end to save it.",
    "Once we agree on the scope, finish PLAN.md and tell me to exit and run harness plan approve.",
    "Do not implement source, install dependencies, or change project configuration.",
    "A later host-controlled step will read the approved PLAN.md and generate items.json automatically.",
    itemsFormat,
  ].join("\n");
}

export function buildPlanCommand(request: {
  topic: string; skills: readonly string[]; skillsConfigured: boolean;
  provider: string | undefined; model: string | undefined;
  phase?: "draft" | "items"; diagnosis?: string;
}): string[] {
  const items = request.phase === "items";
  return ["node", `${CONTAINER_PI_PACKAGE}/dist/cli.js`, "--approve",
    ...resourceArguments(items ? false : request.skillsConfigured),
    "--session", `/work/${SESSION_FILE}`,
    ...(items ? ["--print"] : []),
    ...(request.provider === undefined ? [] : ["--provider", request.provider]),
    ...(request.model === undefined ? [] : ["--model", request.model]),
    items ? [
      "The operator approved the PLAN.md now on disk. Read it and generate items.json from it.",
      "Do not restart the interview or ask questions. Do not change PLAN.md or implement the project.",
      "Use DECISIONS.md and the saved conversation only as supporting context; PLAN.md is authoritative.",
      itemsFormat,
      ...(request.diagnosis ? [`Previous attempt failed: ${request.diagnosis}. Correct the proposal.`] : []),
    ].join("\n") : planPrompt(request.topic, request.skills),
  ];
}

export const planContainer = (plan: SavedPlan): string => `harness-plan-${plan.state.id}`;

/** Also used before approval: a crashed planner must be stopped before reading its outputs. */
async function reconcile(plan: SavedPlan, config: Config): Promise<SavedPlan> {
  if (plan.state.status !== "paused") {
    await stopContainer(config.dockerExecutable, planContainer(plan));
    return savePlan(plan, { ...plan.state, status: "paused" });
  }
  return plan;
}

export async function runPlanAttempt(original: SavedPlan, config: Config): Promise<SavedPlan> {
  let plan = await reconcile(original, config);
  const agent = await realpath(config.agentDirectory);
  const overlaps = (parent: string, child: string): boolean => {
    const rel = path.relative(parent, child); return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
  };
  if (overlaps(agent, plan.state.project) || overlaps(plan.state.project, agent)
    || overlaps(agent, plan.directory) || overlaps(plan.directory, agent)) throw new OperatorError("Pi's writable data directory must not overlap the project or planning state.");
  const items = plan.state.phase === "items";
  if (plan.state.phase === "ready") return plan;
  if (items) {
    await atomicWrite(path.join(plan.work, PLAN_FILE), await approvedText(plan));
    const previous = await readArtifact(plan.work, ITEMS_FILE);
    if (previous !== undefined) await atomicWrite(path.join(plan.work, "items.previous.json"), previous);
    await rm(path.join(plan.work, ITEMS_FILE), { force: true });
  }
  // Empty explicit sessions make Pi persist even the initial user message before its first response.
  if (await readArtifact(plan.work, SESSION_FILE, 64 * 1024 * 1024) === undefined) await atomicWrite(path.join(plan.work, SESSION_FILE), "");
  const skills = !items && config.skillsDirectory ? await listSkills(config.skillsDirectory) : [];
  const layout: SandboxLayout = {
    dockerExecutable: config.dockerExecutable, imageId: config.imageId, containerName: planContainer(plan),
    workDirectory: plan.work, agentDirectory: config.agentDirectory, piPackageDirectory: config.piPackageDirectory,
    ...(!items && config.skillsDirectory ? { skillsDirectory: config.skillsDirectory } : {}),
    user: `${process.getuid?.() ?? 501}:${process.getgid?.() ?? 20}`,
  };
  const args = buildRunArguments(layout, "bridge", buildPlanCommand({ topic: plan.state.topic, skills,
    skillsConfigured: skills.length > 0, provider: config.provider, model: config.model,
    phase: items ? "items" : "draft", ...(plan.state.error ? { diagnosis: plan.state.error } : {}),
  }), !items);
  say(`plan: ${plan.state.id}`);
  say(`saved workspace: ${plan.work}`);
  say(`skills: ${skills.join(", ") || "none"}`);
  plan = await savePlan(plan, { ...plan.state, status: "running" });
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Planning interrupted by signal."));
  process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
  try {
    const result = await withContainmentSignal(controller.signal, () => runContained(layout, args, {
      timeoutMs: config.agentTimeoutMs, interactive: !items, ...(items ? { onOutput: (chunk: string) => process.stdout.write(chunk) } : {}),
    }));
    if (result.timedOut) throw new OperatorError(`Planning timed out after ${config.agentTimeoutMs / 1000}s. The saved conversation and drafts were retained.`);
    if (result.code !== 0) throw new OperatorError(`Planner exited with code ${result.code ?? "signal"}. ${result.stderr.trim()}`);
    const { error: _oldError, ...state } = plan.state;
    plan = await savePlan(plan, { ...state, status: "paused" });
    if (items) plan = await finishItems(plan);
    return plan;
  } catch (error) {
    await savePlan(plan, { ...plan.state, status: "interrupted", error: (error as Error).message });
    throw new OperatorError((error as Error).message, `Continue without retyping: harness plan resume ${plan.state.id}`);
  } finally {
    process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel);
  }
}

async function describe(plan: SavedPlan): Promise<void> {
  say(`plan: ${plan.state.id} · ${plan.state.phase} · ${plan.state.status}`);
  say(`draft: ${path.join(plan.work, PLAN_FILE)}`);
  say(`conversation: ${path.join(plan.work, SESSION_FILE)}`);
  if (plan.state.error) say(`last error: ${plan.state.error}`);
  if (plan.state.phase === "ready") {
    say(`approved plan: ${path.join(plan.directory, PLAN_FILE)}`);
    say(`items: ${path.join(plan.directory, ITEMS_FILE)}`);
    say("Review the items, then accept them: harness add --from latest");
  } else if (plan.state.phase === "items") say("Generate or repair items from the approved plan: harness plan resume");
  else {
    say("Continue the saved interview: harness plan resume");
    say("After reviewing PLAN.md, generate its work items: harness plan approve");
  }
}

async function planUnlocked(project: string, argv: readonly string[]): Promise<void> {
  const action = argv[0];
  if (action === "status") { if (argv.length > 2) throw new OperatorError("Use: harness plan status [id]"); await describe(await resolvePlan(project, argv[1])); return; }
  if (action === "--from") {
    if (argv.length !== 2) throw new OperatorError("Use: harness plan --from /path/to/PLAN.md");
    const source = path.resolve(argv[1]!);
    const text = await readArtifact(path.dirname(source), path.basename(source));
    if (!text?.trim()) throw new OperatorError("The supplied plan is empty or missing.");
    const saved = await createPlan(project, "Continue the supplied plan");
    await atomicWrite(path.join(saved.work, PLAN_FILE), text); await describe(saved); return;
  }
  const existing = action === "resume" || action === "approve";
  if (existing && argv.length > 2) throw new OperatorError(`Use: harness plan ${action} [id]`);
  if (!existing && argv.some(a => a.startsWith("--"))) throw new OperatorError("Unknown plan option. Use plan [topic], resume, approve, status, or --from.");
  let saved = existing ? await resolvePlan(project, argv[1]) : undefined;
  if (action !== "approve" && saved?.state.phase !== "items" && saved?.state.phase !== "ready" && !process.stdin.isTTY) {
    throw new OperatorError("plan needs a terminal for the interview.", "Run it directly in a shell. Saved plan approval and item generation also work without a terminal.");
  }
  let config: Config;
  try { config = loadConfig(); } catch (error) { if (error instanceof ConfigError) throw new OperatorError(error.message, error.remedy); throw error; }
  saved ??= await createPlan(project, argv.join(" ").trim());
  saved = await reconcile(saved, config);
  if (action === "approve") saved = await approvePlan(saved);
  await describe(await runPlanAttempt(saved, config));
}

export async function plan(argv: readonly string[]): Promise<void> {
  const project = path.resolve(setting(process.env, "HARNESS_PROJECT") ?? process.cwd());
  if (argv[0] === "status") { await planUnlocked(project, argv); return; }
  return withWriter(project, "plan", () => planUnlocked(project, argv));
}
