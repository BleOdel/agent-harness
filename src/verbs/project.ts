import { detectProjects } from "../adapters/registry.ts";
import { choose, confirmed, terminalDialogue, type Dialogue } from "../guide/dialogue.ts";
import { defaultProfile, profilePath, readProfile, saveProfile, savedProfile } from "../project/profile.ts";
import { availableSkills } from "../project/skills.ts";
import { canonicalProject, withWriter } from "../workspace/writer-lock.ts";
import { loadConfig } from "../config.ts";
import { OperatorError, say } from "./io.ts";
export async function setupProject(project: string, io: Dialogue = terminalDialogue()): Promise<void> {
 const detected = await detectProjects(project);
 const saved = await savedProfile(project).catch(error => { io.write(`Existing configuration needs replacement: ${(error as Error).message}`); return undefined; });
 io.write(`Project: ${project}`);
 io.write(`Detected: ${detected.length ? detected.join(", ") : "no project markers"}. Available adapters: Node/npm and Python (single package).`);
 if (detected.length && !detected.some(id => ["node-npm", "python-pip"].includes(id))) {
  io.write("This project needs an adapter from a later phase. Choose a supported package root or create one with harness init [--python]."); return;
 }
 const options = detected.includes("python-pip") && !detected.includes("node-npm") ? ["python-pip"] : detected.includes("node-npm") && !detected.includes("python-pip") ? ["node-npm"] : ["node-npm", "python-pip"];
 const choice = await choose(io, detected.length > 1 ? "Multiple project types: choose what this root should build" : "Project environment", options.map(id => id === "node-npm" ? "Node/npm on Linux Docker" : "Python/pytest on Linux Docker"));
 if (choice < 0) return;
 const profile = defaultProfile(options[choice]);
 if (saved) profile.skills = saved.skills;
 let available = new Map<string, string>();
 try { available = await availableSkills(loadConfig({ ...process.env, HARNESS_PROJECT: project }).skillsDirectory); }
 catch { io.write("Skills can be selected after the container/skills configuration is available. Run harness doctor for the next remedy."); }
 for (const role of ["build", "plan"] as const) {
  const choices = [...available.keys()].filter(id => role !== "build" || !["grill-me", "grilling"].includes(id)).sort();
  const defaults = profile.skills[role].filter(id => choices.includes(id));
  io.write(`${role === "build" ? "Build" : "Planning"} skills suggested: ${defaults.join(", ") || "none available"}.`);
  if (choices.length) {
   io.write(`Available: ${choices.join(", ")}`);
   const answer = (await io.ask(`${role} skills (Enter for suggested names, comma-separated names to select, or none):`)).trim();
   const selected = answer === "none" ? [] : answer ? answer.split(",").map(s => s.trim()) : defaults;
   if (selected.some(id => !choices.includes(id))) throw new OperatorError("A selected skill is unavailable. Choose a listed name.");
   profile.skills[role] = selected;
  } else profile.skills[role] = [];
 }
 io.write(`Selected: ${profile.adapter.id}@1, docker@1; Linux, 2 CPUs, 2048 MiB RAM; ${profile.adapter.id === "python-pip" ? "exact .python-version, pip >=23; Node >=26 for the model launcher" : "Node >=26, npm >=10"}. Verification is offline. GUI, native emulators and GPU are unavailable.`);
 if (profile.adapter.id === "python-pip") io.write("Python needs a runner image containing its pinned runtime, pip and Node. Build containers/python.Dockerfile and set HARNESS_IMAGE_ID to its immutable ID before continuing.");
 io.write(`Configuration will be saved outside project source: ${profilePath(project)}`);
 if (!await confirmed(io, "Save this project setup?")) return;
 await saveProfile(project, profile); io.write("Project setup saved. Continue with harness guide; harness doctor checks the installed tools.");
}
export async function projectCommand(project: string, args: readonly string[]): Promise<void> {
 project = await canonicalProject(project);
 if (args.length === 1 && args[0] === "setup") return withWriter(project, "project setup", () => setupProject(project));
 if (!args.length || (args.length === 1 && args[0] === "show")) {
  try { say(JSON.stringify({ path: profilePath(project), saved: !!await savedProfile(project), profile: await readProfile(project, true) }, null, 2)); }
  catch (error) { throw new OperatorError((error as Error).message, "Use harness project setup."); }
  return;
 }
 throw new OperatorError("Use: harness project setup | show");
}
