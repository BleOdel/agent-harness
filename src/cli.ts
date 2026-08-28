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
import { add } from "./verbs/add.ts";
import { OperatorError, say } from "./verbs/io.ts";
import { look } from "./verbs/look.ts";
import { show } from "./verbs/show.ts";
import { undo } from "./verbs/undo.ts";
import { work } from "./verbs/work.ts";

const USAGE = [
  "harness — build software in a sandbox, prove it, then apply it.",
  "",
  "  npm run add  -- <id> --title \"...\" --criterion \"...\" [--priority must]",
  "  npm run work [-- <item-id or goal>]",
  "  npm run look",
  "  npm run show -- <run-id>",
  "  npm run undo -- <run-id>",
  "",
  "With no arguments, `work` takes the next Must from the feature list.",
  "Set HARNESS_PROJECT to work on a project other than the current directory.",
].join("\n");

async function main(): Promise<void> {
  const [verb, ...rest] = process.argv.slice(2);
  const project = path.resolve(process.env.HARNESS_PROJECT ?? process.cwd());

  switch (verb) {
    case "add":
      return add(project, rest);
    case "work":
      return work(rest);
    case "look":
      return look(project);
    case "show":
      return show(project, rest);
    case "undo":
      return undo(project, rest);
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
