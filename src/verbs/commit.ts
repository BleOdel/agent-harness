/**
 *   harness commit [<run-id>]
 *
 * Commits what a run applied, with a message saying what it was meant to
 * satisfy and what proved it.
 *
 * Only ever adds a commit. It does not push, does not branch, does not
 * amend, and does not touch history -- a commit is local and reversible,
 * a push is neither and is not the harness's call.
 *
 * Runs on the host, because that is the only place `.git` exists. The
 * model never sees it.
 */

import path from "node:path";
import { changedPaths, commitMessage, git, isRepository } from "../git.ts";
import { readFeatures } from "../features.ts";
import { readRecord, undoableRuns } from "../record/record.ts";
import { OperatorError, say } from "./io.ts";

export async function commit(project: string, argv: readonly string[]): Promise<void> {
  if (!(await isRepository(project))) {
    throw new OperatorError(
      `${path.basename(project)} is not a git repository.`,
      "Start one with:  git init\nThe harness never runs git init for you: making a repository is a\ndecision about where your history begins.",
    );
  }

  const changed = await changedPaths(project);
  if (changed.length === 0) {
    say("Nothing to commit: the working tree is clean.");
    return;
  }

  const { runs } = await readRecord(project);
  const standing = undoableRuns(runs);
  const wanted = argv.find((argument) => !argument.startsWith("-"));
  const run = wanted === undefined ? standing.at(-1) : runs.find((entry) => entry.id === wanted);
  if (run === undefined) {
    throw new OperatorError(
      wanted === undefined ? "No applied run to commit." : `No run ${wanted} in this project.`,
      "Run `harness look` to see what there is.",
    );
  }

  const list = await readFeatures(project);
  const title = list !== undefined && list.ok
    ? list.features.find((feature) => feature.id === run.goal)?.title
    : undefined;

  // Everything git can see, not only what the run touched. A commit that
  // silently leaves your own edits behind is worse than no commit: you
  // would believe the tree was saved.
  say(`Committing ${String(changed.length)} changed paths:`);
  for (const file of changed.slice(0, 20)) say(`  ${file}`);
  if (changed.length > 20) say(`  ... and ${String(changed.length - 20)} more`);
  say("");

  const message = commitMessage(run, title);
  const staged = await git(project, ["add", "--all"]);
  if (staged.code !== 0) throw new OperatorError(`git add failed: ${staged.stderr.trim()}`, "");

  const committed = await git(project, ["commit", "--message", message]);
  if (committed.code !== 0) {
    throw new OperatorError(
      `git commit failed: ${committed.stderr.trim() || committed.stdout.trim()}`,
      "Nothing was committed. Your changes are still in the working tree.",
    );
  }
  say(committed.stdout.trim().split("\n")[0] ?? "committed");
  say("");
  say(message.split("\n").map((line) => `  ${line}`).join("\n").trimEnd());
  say("");
  say("Not pushed. That is your call:  git push");
}
