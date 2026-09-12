import { desktopScaffold } from '../desktop/scaffold.ts';
/**
 *   harness init
 *
 * Creates a project the gates can actually work with.
 *
 * The four files below are not boilerplate -- they are the preconditions
 * every gate assumes. A harness that demands a shape and then makes the
 * operator type it out is offloading its own requirements, and the one
 * piece easiest to get wrong by hand is the test glob, which has an
 * entire gate devoted to catching it.
 *
 * Nothing here overwrites. A project that already has a package.json is
 * refused rather than merged: guessing how to combine someone's manifest
 * with ours is how a tool eats a project.
 */

import { pythonScaffold } from "../adapters/python/scaffold.ts";
import { detectProjects } from "../adapters/registry.ts";
import { withWriter } from "../workspace/writer-lock.ts";

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { OperatorError, say } from "./io.ts";

const manifest = (name: string): string => `${JSON.stringify({
  name,
  version: "0.1.0",
  private: true,
  type: "module",
  engines: { node: ">=20" },
  scripts: { test: "node --test test/*.test.js" },
}, null, 2)}\n`;

/**
 * Says in the file that it is temporary.
 *
 * v1's generator wrote `assert.ok(true)` with no such note, and it became
 * Finding 4 of its own review: a generated test that asserts nothing,
 * sitting in repositories forever, looking like coverage.
 *
 * The note is addressed to the operator, and tells the model explicitly
 * to leave it alone. The first version said only "delete this file once
 * you have a real test", the model obliged on its very first run, and the
 * reviewer escalated the deletion as scope nobody asked for -- two things
 * in this repository instructing the same model in opposite directions.
 */
const SEED_TEST = [
  "// Scaffolding. It proves nothing about this project and is not coverage.",
  "//",
  "// It exists only so the first run has something to collect: a project",
  "// with no test files is refused by the test-collection gate, and a run",
  "// with no assertions executed is refused by the tests gate.",
  "//",
  "// TO THE MODEL: leave this file alone. Deleting it is a change no",
  "// acceptance criterion asked for, and the reviewer will escalate it.",
  "// The operator removes it once real tests exist.",
  "",
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  "",
  'test("the suite runs", () => {',
  "  assert.ok(true);",
  "});",
  "",
].join("\n");

const agents = (name: string): string => `# ${name}

<!-- Describe the project in a sentence or two. The model reads this file
     on every run, before anything else. -->

You are running inside a disposable copy. Nothing you do here reaches the
real repository until the gates pass, so work freely -- read what you
need, write what you like, run what you want.

## What has to be true before anything lands

- **\`npm test\` passes** and reports observed assertions. Empty reports are
  refused; counts are diagnostics, not independent acceptance evidence.
- **Operator-approved behaviour passes host comparison.** These checks are
  outside your workspace. Do not fabricate reports or weaken project tests.
- **Every test file is one the runner collects.** \`npm test\` runs
  \`node --test test/*.test.js\`, which does not recurse and never reaches
  the repository root. A test anywhere else is green by never running.
- **\`npm run build\` changes nothing**, if this project has one. Committed
  artefacts must already match what their sources produce.
- **Every change is inside the project**, a real file, not a symlink.
- **Write \`.harness-claim.json\`** naming every file you changed, every file
  you deleted, and every acceptance criterion with the file that verifies
  it. It is checked against what actually changed, so it must be exact.

## Conventions

<!-- Fill these in. Whatever you settle in \`harness plan\` belongs here:
     the rules that hold across every item. Per-item requirements are
     acceptance criteria, not conventions. -->

- Plain ESM, named exports, no default exports.
- Tests live flat in \`test/\`, one file per module.

## How to work

Write the test first when the change is behavioural, then break it
deliberately and confirm it fails. A test that passes against broken code
is the most expensive thing you can add here.

If you cannot make the tests pass, stop and say what blocked you. A
disabled test, a deleted assertion, or a test rewritten to match broken
behaviour is worse than an honest failure.

## What not to do

- Do not commit or touch git history. \`.git\` is not in your copy at all.
- **Adding a dependency:** if you genuinely need a package, install it and
  add it to \`package.json\`, then say in your summary what it is for. Do
  not reach for one to save a few lines -- prefer a built-in. Note that
  \`node_modules\` never leaves the sandbox, so the operator is told to
  install it on their own machine afterwards.
- Do not weaken a check to make a test pass.
- Do not build anything no acceptance criterion asked for.
`;

async function initUnlocked(project: string, python = false, desktop = false): Promise<void> {
  const name = path.basename(project);
  if ((await detectProjects(project)).length) {
    throw new OperatorError(
      `${name} already has a project manifest.`,
      "init only ever creates a project from nothing. Add the pieces by hand, or\n"
      + "run it in an empty directory.",
    );
  }

  if (python || desktop) {
    const files = desktop ? await desktopScaffold() : await pythonScaffold(name);
    for (const [file] of files) if (existsSync(path.join(project, file))) throw new OperatorError(`init would overwrite ${file}; choose an empty project.`);
    for (const [file, contents] of files) {
      await mkdir(path.dirname(path.join(project, file)), { recursive: true });
      await writeFile(path.join(project, file), contents, { encoding: "utf8", flag: "wx" });
      say(`  created  ${file}`);
    }
    if (desktop) { say("Desktop notes created. Run npm test, then harness guide → Linux desktop apps to prepare the image and approve a journey."); return; }
    say("Python project created. Next: harness doctor checks your configured Python runner image.");
    say("Use harness guide to plan and continue; harness verify tests and packages in fresh offline containers.");
    return;
  }
  await mkdir(path.join(project, "src"), { recursive: true });
  await mkdir(path.join(project, "test"), { recursive: true });

  const files: [string, string][] = [
    ["package.json", manifest(name)],
    [path.join("test", "seed.test.js"), SEED_TEST],
    ["AGENTS.md", agents(name)],
  ];
  for (const [file, contents] of files) {
    // Exclusive create: never replace something that appeared between the
    // check above and now.
    await writeFile(path.join(project, file), contents, { encoding: "utf8", flag: "wx" });
    say(`  created  ${file}`);
  }
  say("  created  src/");

  say("");
  say(`${name} is ready. Check it with:  npm test`);
  say("");
  say("Continue with short prompts: harness guide");
  say("Or use explicit commands:");
  say("  harness plan            an interview that settles what this is");
  say("  harness plan approve    generate items from the reviewed plan");
  say("  harness add --from latest");
  say("  harness checks setup    approve observable application behaviour");
  say("  harness work");
  say("");
  say("Fill in the Conventions section of AGENTS.md once you know them.");
}

export async function init(project: string, args: readonly string[] = []): Promise<void> {
  if (args.length && (args.length !== 1 || !["--python", "--desktop"].includes(args[0]!))) throw new OperatorError("Use: harness init [--python | --desktop]");
  return withWriter(project, "init", () => initUnlocked(project, args[0] === "--python", args[0] === "--desktop"));
}
