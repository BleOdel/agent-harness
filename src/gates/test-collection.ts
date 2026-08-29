/**
 * Does the test runner actually collect every test file in the project?
 *
 * This is the gate the plan singled out, because in v1 the defect it
 * catches hid a second defect behind it. A test file the runner never
 * collects is worse than no test: the suite is green, the file looks like
 * coverage, and nobody reads it again.
 *
 * `node --test test/*.test.js` does not recurse and does not reach the
 * repository root. A model that puts a test in `src/`, or in
 * `test/unit/`, or at the top level, gets a passing suite either way.
 *
 * The check does not parse the test command's semantics. It expands the
 * command's glob arguments with the same matcher a shell would, which is
 * what the runner will actually see, and compares that to every test file
 * on disk. Anything on disk and not in the expansion is uncollected.
 */

import { glob } from "node:fs/promises";
import path from "node:path";
import { EXCLUDED_FROM_COPY } from "../workspace/changes.ts";
import { failed, type GateVerdict, passed } from "./gate.ts";

/**
 * Recognised by the naming convention every JS runner keys on. Kept
 * deliberately narrow: this gate must never argue with the operator about
 * whether a file is a test, only about whether a file that plainly is one
 * gets run.
 */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/u;

const NEVER_SEARCHED = new Set([...EXCLUDED_FROM_COPY, "node_modules", "dist", "build", "coverage"]);

/** Every file in the project that any reader would call a test. */
export async function discoverTestFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of glob("**/*", { cwd: root, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const relative = path
      .relative(root, path.join(entry.parentPath, entry.name))
      .split(path.sep)
      .join("/");
    if (relative.split("/").some((segment) => NEVER_SEARCHED.has(segment))) continue;
    if (TEST_FILE.test(entry.name)) found.push(relative);
  }
  return found.sort();
}

/**
 * What the test command will actually reach, by expanding its glob
 * arguments exactly as the shell will.
 *
 * Arguments that are not patterns and not existing paths -- `npm`,
 * `test`, `--test` -- expand to nothing, which is correct: they select no
 * files.
 */
export async function expandCollected(root: string, command: readonly string[]): Promise<string[]> {
  const collected = new Set<string>();
  for (const argument of command) {
    if (argument.startsWith("-")) continue;
    for await (const match of glob(argument, { cwd: root })) {
      collected.add(match.split(path.sep).join("/"));
    }
  }
  return [...collected].sort();
}

/**
 * `npm test` and friends hide the real command behind a script name, so
 * the globs to expand live in package.json rather than in argv.
 */
export async function resolveTestCommand(
  root: string,
  command: readonly string[],
  readPackageScript: (root: string, name: string) => Promise<string | undefined>,
): Promise<string[]> {
  if (command[0] !== "npm" || command[1] === undefined) return [...command];
  const script = await readPackageScript(root, command[1] === "run" ? command[2] ?? "" : command[1]);
  return script === undefined ? [...command] : script.split(" ").filter(Boolean);
}

export async function checkTestCollection(
  root: string,
  resolvedCommand: readonly string[],
): Promise<GateVerdict> {
  const [onDisk, collected] = await Promise.all([
    discoverTestFiles(root),
    expandCollected(root, resolvedCommand),
  ]);

  if (onDisk.length === 0) {
    // Not a pass. A project with no test files has nothing verifying it,
    // and the assertion gate would already have refused the run -- but
    // this gate must not be the one that quietly says yes.
    return failed(
      "tests-uncollected",
      "test collection: no test files found in the project",
      "Nothing here matches a test file name, so the suite that passed verified nothing in this project.",
    );
  }

  const collectedSet = new Set(collected);
  const uncollected = onDisk.filter((file) => !collectedSet.has(file));
  if (uncollected.length > 0) {
    return failed(
      "tests-uncollected",
      `test collection: ${String(uncollected.length)} test files the runner never runs`,
      [
        `The test command is: ${resolvedCommand.join(" ")}`,
        "",
        "These files look like tests, and it does not reach them:",
        ...uncollected.map((file) => `  ${file}`),
        "",
        "A test the runner never collects is worse than no test. The suite is",
        "green, the file looks like coverage, and nobody reads it again.",
        "Move them where the command collects them, or widen the command.",
      ].join("\n"),
    );
  }

  return passed(
    `test collection: all ${String(onDisk.length)} test `
    + `${onDisk.length === 1 ? "file is" : "files are"} collected`,
  );
}
