/**
 * Git, at arm's length.
 *
 * The harness never lets a model near git: `.git` is not in the sandbox
 * copy, so history cannot be rewritten, a branch cannot be moved, and no
 * commit can be made that looks like the operator's. That stays true.
 * This runs on the host, only when the operator asks, and only ever adds
 * a commit.
 *
 * Nothing here pushes. A commit is local and reversible; a push is
 * neither, and it is not the harness's decision.
 */

import { spawn } from "node:child_process";

export interface GitResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function git(project: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", project, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => { resolve({ code, stdout, stderr }); });
  });
}

export async function isRepository(project: string): Promise<boolean> {
  const result = await git(project, ["rev-parse", "--is-inside-work-tree"]).catch(() => undefined);
  return result?.code === 0 && result.stdout.trim() === "true";
}

/** Paths git reports as changed, staged or not. */
export async function changedPaths(project: string): Promise<string[]> {
  const result = await git(project, ["status", "--porcelain"]);
  return result.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    // Porcelain is `XY <path>`, and a rename is `XY old -> new`.
    .map((line) => line.slice(3).split(" -> ").at(-1) ?? "")
    .filter((entry) => entry !== "");
}

/**
 * The message for an applied run.
 *
 * Says what was asked and what proved it, because six months later the
 * useful question about a commit is not what changed -- the diff says
 * that -- but what it was supposed to satisfy and what checked it.
 */
export function commitMessage(run: {
  id: string;
  goal: string;
  gates: readonly string[];
  review?: { verdict: string } | undefined;
}, title: string | undefined): string {
  return [
    title === undefined ? run.goal : title,
    "",
    `Applied by the harness as ${run.id}.`,
    "",
    ...run.gates.map((gate) => `  ${gate}`),
    ...(run.review === undefined ? [] : [`  review: ${run.review.verdict}`]),
    "",
  ].join("\n");
}
