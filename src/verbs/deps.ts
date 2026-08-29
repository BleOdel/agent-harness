/**
 *   harness deps            what is declared but not installed
 *   harness deps --install  install it
 *
 * The only place the harness runs a command on your machine rather than
 * inside a container. That is why it is a separate verb and why it does
 * nothing without `--install`: installing a package runs whatever install
 * scripts that package ships, with your permissions, outside every
 * boundary this project otherwise maintains.
 *
 * Nothing is chosen here. It installs what `package.json` already
 * declares, which is a file you can read first.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { missingInProject } from "../deps.ts";
import { OperatorError, say } from "./io.ts";

function npmInstall(project: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["install"], { cwd: project, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", resolve);
  });
}

export async function deps(project: string, argv: readonly string[]): Promise<void> {
  const missing = await missingInProject(project);
  if (missing.length === 0) {
    say("Everything package.json declares is installed.");
    return;
  }

  say(`Declared in package.json but not installed (${String(missing.length)}):`);
  say("");
  for (const name of missing) say(`  ${name}`);
  say("");

  if (!argv.includes("--install")) {
    // Shown, not done. This is the one command that reaches outside the
    // container, so it takes a deliberate second word.
    say("A run added these inside the sandbox, where its tests passed. They are");
    say("not on your machine, so the project will not run here until they are.");
    say("");
    say(`Install them with:  harness deps --install`);
    say(`Or read the file first:  ${path.join(project, "package.json")}`);
    return;
  }

  say("Running npm install...");
  say("");
  const code = await npmInstall(project);
  if (code !== 0) throw new OperatorError(`npm install exited ${String(code)}.`, "");

  const stillMissing = await missingInProject(project);
  if (stillMissing.length > 0) {
    throw new OperatorError(
      `Still missing after install: ${stillMissing.join(", ")}.`,
      "npm reported success, so this is worth looking at by hand.",
    );
  }
  say("");
  say("Installed. Check the project with: npm test");
}
