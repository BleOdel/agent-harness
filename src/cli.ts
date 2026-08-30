#!/usr/bin/env -S node --experimental-strip-types
/**
 * The operator surface: five verbs.
 *
 *   add <id>    put an item on the feature list
 *   work [id]   build the next Must, or a named item; prove it; apply or escalate
 *   look        what happened, what is pending, what escalated and why
 *   show <id>   the exact diff
 *   undo <id>   put it back
 *
 * The only file in the project that does anything when you load it.
 * Everything else is a module that has to be called, which is what makes
 * the verbs testable -- a lesson this project learned twice, from the
 * boundary probe and again from `planUndo`.
 */

import path from "node:path";
import { applyConfigFile } from "./config.ts";
import { add } from "./verbs/add.ts";
import { OperatorError, say } from "./verbs/io.ts";
import { commit } from "./verbs/commit.ts";
import { deps } from "./verbs/deps.ts";
import { init } from "./verbs/init.ts";
import { look } from "./verbs/look.ts";
import { plan } from "./verbs/plan.ts";
import { remove } from "./verbs/remove.ts";
import { run as runAll } from "./verbs/run.ts";
import { show } from "./verbs/show.ts";
import { undo } from "./verbs/undo.ts";
import { view } from "./verbs/view.ts";
import { work } from "./verbs/work.ts";

const USAGE = [
  "harness — build software in a sandbox, prove it, then apply it.",
  "",
  "  harness init                  create a project the gates can work with",
  "  harness plan [<topic>]        an interview, in the sandbox, to settle criteria",
  "  harness add <id> --title \"...\" --criterion \"...\" [--priority must]",
  "  harness add --from latest     import the items a plan proposed",
  "  harness work [<item-id or goal>]",
  "  harness run [--max N]         work items until one needs you",
  "  harness look",
  "  harness show <run-id>",
  "  harness view [--open]         the whole record as a page you can read",
  "  harness undo <run-id>",
  "  harness commit [<run-id>]     commit what a run applied (never pushes)",
  "  harness remove [<path>] --yes a project and its harness state, together",
  "  harness deps [--install]      packages a run declared but did not install",
  "",
  "Run it inside your project. With no arguments, `work` takes the next Must.",
  "Settings come from ~/.config/harness/config, or the harness's own .env.",
].join("\n");

async function main(): Promise<void> {
  // Before anything else, and only from the operator's own machine.
  applyConfigFile();
  const [verb, ...rest] = process.argv.slice(2);
  const project = path.resolve(process.env.HARNESS_PROJECT ?? process.cwd());

  switch (verb) {
    case "add":
      return add(project, rest);
    case "init":
      return init(project);
    case "commit":
      return commit(project, rest);
    case "deps":
      return deps(project, rest);
    case "plan":
      return plan(rest);
    case "work":
      return work(rest);
    case "run":
      return runAll(rest);
    case "look":
      return look(project);
    case "show":
      return show(project, rest);
    case "view":
      return view(project, rest);
    case "undo":
      return undo(project, rest);
    case "remove":
      return remove(project, rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      say(USAGE);
      return;
    default:
      throw new OperatorError(`Unknown verb ${JSON.stringify(verb)}.`, USAGE);
  }
}

await main().catch((error: unknown) => {
  if (error instanceof OperatorError) {
    process.stderr.write(`\n${error.message}\n`);
    if (error.remedy.trim() !== "") process.stderr.write(`\n${error.remedy.trimEnd()}\n`);
    process.exit(1);
  }
  throw error;
});
