import { readProfile } from "../project/profile.ts";
import { getAdapter } from "../adapters/registry.ts";
/** Durable planning drafts are untrusted; approval and import identities stay outside the mount. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { cp, lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { parseProposedItems, type Feature } from "../features.ts";
import { harnessDirectory } from "../record/record.ts";
import { createSandbox, destroySandbox } from "../workspace/sandbox-lifecycle.ts";
import { OperatorError } from "../verbs/io.ts";

export interface PlanState {
  version: 1;
  id: string;
  project: string;
  topic: string;
  phase: "draft" | "items" | "ready";
  status: "paused" | "running" | "interrupted";
  approvedHash?: string;
  itemsHash?: string;
  error?: string;
}
export interface SavedPlan { directory: string; work: string; state: PlanState; }
export const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

export async function atomicWrite(file: string, text: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, file); } finally { await rm(temporary, { force: true }); }
}

/** Do not follow a model-created symlink when reading a draft on the host. */
export async function readArtifact(directory: string, name: string, maxBytes = 2 * 1024 * 1024): Promise<string | undefined> {
  let handle;
  try { handle = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new OperatorError(`${name} must be a bounded regular file with one link.`);
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

export async function savePlan(plan: SavedPlan, state: PlanState): Promise<SavedPlan> {
  await atomicWrite(path.join(plan.directory, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  return { ...plan, state };
}

export async function createPlan(project: string, topic: string): Promise<SavedPlan> {
  const canonical = await realpath(project);
  const adapter = getAdapter((await readProfile(canonical, true)).adapter);
  const id = `${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
  const directory = path.join(harnessDirectory(canonical), "plans", id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const work = path.join(directory, "work");
  const sandbox = await createSandbox(canonical, adapter.source.generatedDirectories);
  try {
    await cp(sandbox.workDirectory, work, { recursive: true, dereference: false, verbatimSymlinks: true });
    // A project cannot seed an unrelated or forged Pi conversation or proposal.
    for (const file of ["session.jsonl", "items.json", "DECISIONS.md"]) await rm(path.join(work, file), { recursive: true, force: true });
  } finally { await destroySandbox(sandbox); }
  const plan: SavedPlan = { directory, work, state: { version: 1, id, project: canonical, topic, phase: "draft", status: "paused" } };
  return savePlan(plan, plan.state);
}

export async function latestPlanDirectory(project: string): Promise<string> {
  const root = path.join(harnessDirectory(await realpath(project)), "plans");
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []; throw error;
  });
  const latest = entries.filter(e => e.isDirectory()).map(e => e.name).sort().at(-1);
  if (!latest) throw new OperatorError("No plan has been saved for this project.", "Run harness plan first.");
  return path.join(root, latest);
}

export async function resolvePlan(project: string, selector = "latest"): Promise<SavedPlan> {
  if (selector !== "latest" && !/^[A-Za-z0-9_-]+$/u.test(selector)) throw new OperatorError("Invalid plan id.");
  const canonical = await realpath(project);
  const directory = selector === "latest" ? await latestPlanDirectory(canonical) : path.join(harnessDirectory(canonical), "plans", selector);
  if (!(await lstat(directory)).isDirectory()) throw new OperatorError("Plan directory must be a real directory.");
  const raw = await readArtifact(directory, "state.json");
  if (!raw) throw new OperatorError("This is a legacy plan without a saved conversation.", `Use harness plan --from ${path.join(directory, "PLAN.md")} to continue from its document.`);
  const state = JSON.parse(raw) as PlanState;
  if (state.version !== 1 || state.project !== canonical || state.id !== path.basename(directory)
    || typeof state.topic !== "string" || !["draft", "items", "ready"].includes(state.phase)
    || !["paused", "running", "interrupted"].includes(state.status)) throw new OperatorError("Invalid planning state.");
  const work = path.join(directory, "work");
  if (!(await lstat(work)).isDirectory()) throw new OperatorError("Plan workspace must be a real directory.");
  return { directory, work, state };
}

export async function approvePlan(plan: SavedPlan): Promise<SavedPlan> {
  const text = await readArtifact(plan.work, "PLAN.md");
  if (!text?.trim()) throw new OperatorError("No nonempty PLAN.md to approve.", "Resume the interview first.");
  // Captured before dispatch: model-written status cannot approve anything.
  await atomicWrite(path.join(plan.directory, "PLAN.md"), text);
  return savePlan(plan, { version: 1, id: plan.state.id, project: plan.state.project, topic: plan.state.topic, phase: "items", status: "paused", approvedHash: digest(text) });
}

export async function approvedText(plan: SavedPlan): Promise<string> {
  const text = await readArtifact(plan.directory, "PLAN.md");
  if (!text || digest(text) !== plan.state.approvedHash) throw new OperatorError("Approved plan changed; approve the draft again before generating items.");
  return text;
}

export async function finishItems(plan: SavedPlan): Promise<SavedPlan> {
  const approved = await approvedText(plan);
  if (await readArtifact(plan.work, "PLAN.md") !== approved) throw new OperatorError("The generator changed PLAN.md; approval does not cover that change.");
  const text = await readArtifact(plan.work, "items.json");
  const parsed = parseProposedItems(text ?? "");
  if (!parsed.ok) throw new OperatorError(`Items are not ready: ${parsed.reason}`, "Use harness plan resume to repair the proposal from the saved approved plan.");
  if (!parsed.features.length) throw new OperatorError("The proposal contains no work items.");
  // Strip model-supplied plan context. Only the operator-approved document is handed on.
  const features = parsed.features.map(({ planContext: _ignored, ...feature }) => feature);
  const canonical = `${JSON.stringify(features, null, 2)}\n`;
  await atomicWrite(path.join(plan.directory, "items.json"), canonical);
  return savePlan(plan, { ...plan.state, phase: "ready", status: "paused", itemsHash: digest(canonical) });
}

export async function acceptedProposal(plan: SavedPlan): Promise<{ features: Feature[] }> {
  if (plan.state.phase !== "ready" || plan.state.status !== "paused") throw new OperatorError("Plan items are not ready to import.", "Use harness plan status, then approve or resume the plan.");
  const context = await approvedText(plan);
  const text = await readArtifact(plan.directory, "items.json");
  if (!text || digest(text) !== plan.state.itemsHash) throw new OperatorError("Generated items changed; regenerate them with harness plan approve before importing.");
  const parsed = parseProposedItems(text);
  if (!parsed.ok) throw new OperatorError(parsed.reason);
  return { features: parsed.features.map(feature => ({ ...feature, planContext: context })) };
}
