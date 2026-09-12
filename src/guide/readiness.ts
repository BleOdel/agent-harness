import { readProfile, type ProjectProfile } from "../project/profile.ts";
import { getAdapter } from "../adapters/registry.ts";
import { inspectCapabilities } from "../project/execution.ts";
import type { Capabilities } from "../runners/contract.ts";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { hostname } from "node:os";
import { ConfigError, loadConfig, setting } from "../config.ts";
import { readFeatures } from "../features.ts";
import { readApproval } from "../acceptance/checks.ts";
import { writerPath, canonicalProject } from "../workspace/writer-lock.ts";
import { run } from "../run.ts";

export interface ReadinessCheck { id: string; status: "ready" | "missing" | "blocked" | "unknown"; message: string; remedy?: string; }
export interface Readiness { version: 2; profile?: ProjectProfile; capabilities?: Capabilities; project: string; ready: boolean; checks: ReadinessCheck[]; next: string; }
export async function inspectWriter(project: string): Promise<{ command: string; pid: number; token: string; recoverable: boolean } | undefined> {
  const text = await readFile(await writerPath(project), "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; });
  if (!text) return undefined;
  const owner = JSON.parse(text);
  if (owner.version !== 1 || !Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== "string" || typeof owner.command !== "string" || typeof owner.host !== "string") throw new Error("Invalid writer lock; inspect it before recovery.");
  let dead = false;
  try { process.kill(owner.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") dead = true; }
  return { command: owner.command, pid: owner.pid, token: owner.token, recoverable: owner.host === hostname() && dead };
}

export async function readiness(project: string, environment: NodeJS.ProcessEnv = process.env, probe = run): Promise<Readiness> {
  project = await canonicalProject(project);
  const checks: ReadinessCheck[] = [];
  const add = (check: ReadinessCheck) => checks.push(check);
  add({ id: "node", status: Number(process.versions.node.split(".")[0]) >= 26 ? "ready" : "blocked", message: `Harness runtime: Node ${process.versions.node}`, remedy: "Run the harness with Node 26 or later." });
  let profile: ProjectProfile | undefined, capabilities: Capabilities | undefined;
  try {
    profile = await readProfile(project);
    const adapter = getAdapter(profile.adapter);
    const command = (setting(environment, "HARNESS_TEST_COMMAND") ?? adapter.defaultTestCommand.join(" ")).split(" ").filter(Boolean);
    const recipe = await adapter.recipe(project, command);
    const hasTest = command[0] !== "npm" || !!recipe.scripts?.test;
    add({ id: "project", status: hasTest ? "ready" : "missing", message: `${profile.adapter.id}@${profile.adapter.version} on ${profile.runner.id}@${profile.runner.version}${hasTest ? ": test command configured." : ": test command missing."}`, remedy: "Use harness project setup and add the project test command." });
  } catch (error) { add({ id: "project", status: "blocked", message: (error as Error).message, remedy: "Use harness project setup to choose a supported root and environment." }); }
  try {
    const owner = await inspectWriter(project);
    add(owner ? { id: "writer", status: "blocked", message: `Writer: ${owner.command} (pid ${owner.pid}), ${owner.recoverable ? "process ended" : "active or ownership cannot be verified"}.`, remedy: owner.recoverable ? "Use harness guide to recover the dead writer and continue saved work." : "Wait for the owner to finish; a live lock cannot be recovered." } : { id: "writer", status: "ready", message: "No project writer is running." });
    const pending = await readFile(`${project}-harness/application.json`, "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; });
    if (pending) add({ id: "application", status: "blocked", message: "A team application was interrupted.", remedy: "Use harness guide to finish or roll back the saved application." });
  } catch (error) { add({ id: "writer", status: "blocked", message: (error as Error).message, remedy: "Inspect the writer or application state before starting work." }); }
  try {
    const features = await readFeatures(project);
    if (features && !features.ok) throw new Error(features.reason);
    const tasks = features?.features.filter(t => t.priority !== "wont" && t.status !== "done").map(t => t.id) ?? [];
    const approval = await readApproval(project);
    const missing = tasks.filter(t => !approval?.manifest.cases.some(c => c.tasks.includes(t) || c.tasks.includes("*")));
    add({ id: "acceptance", status: approval && !missing.length ? "ready" : "missing", message: !approval ? "No acceptance checks approved." : missing.length ? `Checks needed for: ${missing.join(", ")}.` : `${approval.manifest.cases.length} acceptance cases approved.`, remedy: "Use harness checks setup to enter expected application behaviour and approve it." });
  } catch (error) { add({ id: "acceptance", status: "blocked", message: (error as Error).message, remedy: "Review the saved checks and task list with harness guide." }); }
  try {
    const config = loadConfig({ ...environment, HARNESS_PROJECT: project });
    add({ id: "configuration", status: "ready", message: "Container configuration and writable paths are valid." });
    if (profile) {
      try {
        capabilities = await inspectCapabilities(profile, config, probe);
        if (profile.adapter.id === "python-pip") {
          const expected = (await readFile(path.join(project, ".python-version"), "utf8")).trim();
          if (capabilities.toolchains.python !== expected) throw new Error(`Python runtime mismatch: project pins ${expected}, image provides ${capabilities.toolchains.python}. Select a matching immutable Python runner image.`);
        }
        add({ id: "capabilities", status: "ready", message: `${capabilities.os}/${capabilities.arch}; ${Object.entries(capabilities.toolchains).map(([name, version]) => `${name} ${version}`).join("; ")}; ${capabilities.cpu} CPUs, ${capabilities.memoryMiB} MiB; offline verification; no GUI, emulator or GPU.` });
      } catch (error) { add({ id: "capabilities", status: "blocked", message: (error as Error).message, remedy: "Resolve the reported runner prerequisite, then run harness doctor again. Project setup cannot grant unavailable capabilities." }); }
    }
    await access(path.join(config.piPackageDirectory, "dist/cli.js"));
    add({ id: "agent", status: "ready", message: "Agent entry point is installed." });
    const auth = await access(path.join(config.agentDirectory, "auth.json")).then(() => true, () => false);
    add({ id: "authentication", status: auth ? "unknown" : "missing", message: auth ? "Authentication file is present; expiry has not been tested with the provider." : "No provider authentication file found.", remedy: "Sign in through Pi on the host, then resume the saved plan or retry the item. Do not paste credentials into the harness." });
  } catch (error) { add({ id: "configuration", status: "blocked", message: (error as Error).message, remedy: error instanceof ConfigError ? error.remedy : "Check the configured Docker and Pi installation, then retry doctor." }); }
  const first = checks.find(c => c.status === "blocked" || c.status === "missing");
  return { version: 2, ...(profile ? { profile } : {}), ...(capabilities ? { capabilities } : {}), project, ready: !first, checks, next: first?.remedy ?? "Use harness guide to review the saved stage and continue. Provider authentication will be checked on dispatch." };
}
