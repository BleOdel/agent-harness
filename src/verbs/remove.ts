/**
 *   harness remove <project>          show what would go
 *   harness remove <project> --yes    remove it
 *
 * Deletes a project and its harness state together, because they are two
 * directories and forgetting the second is how they accumulate.
 *
 * Nothing is deleted without `--yes`, and what would go is always printed
 * first with its size and file count. This is the only verb that destroys
 * anything the operator cannot get back: recovery snapshots go with it,
 * so every undo for that project goes too.
 *
 * It refuses anything that does not look like a project the harness has
 * worked on. A tool that deletes directories should be hard to point at
 * the wrong one.
 */

import { withWriter } from "../workspace/writer-lock.ts";

import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { harnessDirectory } from "../record/record.ts";
import { OperatorError, say } from "./io.ts";

async function measure(directory: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        files += 1;
        bytes += (await stat(full).catch(() => ({ size: 0 }))).size;
      }
    }
  };
  await walk(directory);
  return { files, bytes };
}

const human = (bytes: number): string =>
  bytes > 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)}M`
    : bytes > 1024 ? `${(bytes / 1024).toFixed(0)}K` : `${String(bytes)}B`;

/**
 * Refuses a target that is not recognisably a project. Deleting the wrong
 * directory is the one mistake this verb could make that no snapshot
 * anywhere would undo.
 */
export function assertLooksLikeProject(target: string, entries: readonly string[]): void {
  const resolved = path.resolve(target);
  if (resolved === path.parse(resolved).root || resolved === (process.env.HOME ?? "")) {
    throw new OperatorError(`Refusing to remove ${resolved}.`, "");
  }
  const marks = ["package.json", "features.json", "AGENTS.md", ".harness-claim.json"];
  if (!marks.some((mark) => entries.includes(mark))) {
    throw new OperatorError(
      `${resolved} does not look like a project the harness has worked on.`,
      `Expected one of: ${marks.join(", ")}.\nRemove it by hand if you are sure.`,
    );
  }
}

async function removeUnlocked(project: string, argv: readonly string[]): Promise<void> {
  const named = argv.find((argument) => !argument.startsWith("-"));
  const target = path.resolve(named ?? project);
  if (!existsSync(target)) throw new OperatorError(`Nothing at ${target}.`, "");
  assertLooksLikeProject(target, await readdir(target).catch(() => []));

  const state = harnessDirectory(target);
  const targets = [target, ...(existsSync(state) ? [state] : [])];

  say("Would remove:");
  say("");
  let runs = 0;
  for (const directory of targets) {
    const { files, bytes } = await measure(directory);
    say(`  ${directory}`);
    say(`      ${String(files)} files, ${human(bytes)}`);
    if (directory === state) {
      runs = (await readdir(path.join(state, "recovery")).catch(() => [])).length;
    }
  }
  say("");

  if (!argv.includes("--yes")) {
    if (runs > 0) {
      say(`This includes ${String(runs)} recovery snapshots. Every undo for this project goes with them.`);
      say("");
    }
    say("Nothing has been deleted. To go ahead:");
    say(`  harness remove ${target} --yes`);
    return;
  }

  for (const directory of targets) {
    await rm(directory, { recursive: true, force: true });
    say(`removed  ${directory}`);
  }
}

export async function remove(project: string, argv: readonly string[]): Promise<void> {
  return withWriter(path.resolve(argv.find(argument => !argument.startsWith("-")) ?? project), "remove", () => removeUnlocked(project, argv));
}
