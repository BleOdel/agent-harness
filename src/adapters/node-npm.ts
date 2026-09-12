import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectAdapter, VerificationRecipe } from "./contract.ts";
import { DEFAULT_INSTALL_POLICY, environmentKey, installEnvironment, prepareEnvironment, probeRuntime, type PreparedEnvironment } from "../workspace/dependencies.ts";
import { checkBuildReproducible, checkTypecheck } from "../gates/commands.ts";
import { checkTestCollection, resolveTestCommand } from "../gates/test-collection.ts";
import { runTestGate } from "../gates/tests.ts";
import { NEVER_APPLIED } from "../workspace/changes.ts";
const optionalRead = (file: string) => readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; });
function assertRecipe(recipe: VerificationRecipe): void {
 if (recipe.version !== 1 || recipe.adapter.id !== "node-npm" || recipe.adapter.version !== 1) throw new Error("Unsupported Node verification recipe.");
 if (!recipe.testCommand.length || recipe.testCommand.some(v => typeof v !== "string" || !v)) throw new Error("Invalid test command.");
 if (!recipe.scripts || Object.values(recipe.scripts).some(v => typeof v !== "string")) throw new Error("Invalid package scripts.");
}
export const nodeNpm: ProjectAdapter = {
 reference: { id: "node-npm", version: 1 }, markers: ["package.json"], defaultTestCommand: ["npm", "test"],
 source: { generatedDirectories: [...NEVER_APPLIED], sharedInputs: ["package.json", "package-lock.json", "npm-shrinkwrap.json"] },
 artifacts: ["dist", "build"], runtime: probeRuntime, prepare: prepareEnvironment,
 async matches(input, source, layout, policy = DEFAULT_INSTALL_POLICY) {
  const environment = input as PreparedEnvironment;
  const manifest = await optionalRead(path.join(source, "package.json")), lock = await optionalRead(path.join(source, "package-lock.json"));
  return environment.manifest === manifest && environment.lock === lock && environment.key === environmentKey({ manifest, lock, image: layout.imageId, runtime: environment.runtime, policy });
 },
 async install(source, destination, input, layout, timeoutMs) {
  const environment = input as PreparedEnvironment;
  if (!environment.policy || typeof environment.install !== "boolean") throw new Error("Invalid Node dependency environment.");
  await installEnvironment(source, destination, environment, layout, timeoutMs);
 },
 async recipe(source, command) {
  const pkg = JSON.parse(await optionalRead(path.join(source, "package.json")) ?? "{}");
  const recipe: VerificationRecipe = { version: 1, adapter: this.reference, testCommand: [...command], scripts: pkg.scripts ?? {} };
  assertRecipe(recipe); return recipe;
 },
 async pin(work, recipe) {
  assertRecipe(recipe);
  const file = path.join(work, "package.json"), raw = await optionalRead(file);
  if (raw !== undefined) await writeFile(file, JSON.stringify({ ...JSON.parse(raw), scripts: recipe.scripts }));
 },
 async checks(source, recipe, counter, timeoutMs) {
  assertRecipe(recipe);
  return [
   { name: "tests", applies: true, check: local => runTestGate(local, counter, recipe.testCommand, timeoutMs) },
   { name: "test-collection", applies: true, check: async () => checkTestCollection(source, await resolveTestCommand(source, recipe.testCommand, async (_root, name) => recipe.scripts![name])) },
   { name: "typecheck", applies: recipe.scripts!.typecheck !== undefined, check: local => checkTypecheck(local, ["npm", "run", "typecheck"], timeoutMs) },
   { name: "build", applies: recipe.scripts!.build !== undefined, check: local => checkBuildReproducible(local, ["npm", "run", "build"], timeoutMs) },
  ];
 },
 test: (layout, command, counter, timeoutMs) => runTestGate(layout, counter, command, timeoutMs),
};
